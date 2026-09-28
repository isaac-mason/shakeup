import { describe, expect, it } from 'vitest';
import { verifyRefFacts } from '../../src/analysis/ref-facts.ts';
import { analyze, createSemantic, type Semantic } from '../../src/analysis/semantic.ts';
import { create, N, type Node, parse, TYPE_NAME, walk } from '../../src/ast.ts';
import { finishNormalizePass, flushPassChanges, runPeepholePass } from '../../src/passes/dce/compression-pass.ts';
import { eliminateDeadCode } from '../../src/passes/dce/compressor.ts';
import { statementsAreTerminated } from '../../src/passes/dce/is-terminated.ts';
import { createKeepVar, keepVarVariableDeclaration, keepVarVisitStatement } from '../../src/passes/dce/keep-var.ts';
import { dceOptions, rolldownDceOptions } from '../../src/passes/dce/options.ts';
import { normalize } from '../../src/passes/dce/peephole/normalize.ts';
import type { SourceType } from '../../src/passes/dce/state.ts';
import { functionIsDead, isImplicitlyObservable, symbolValueOf } from '../../src/passes/dce/symbol-state.ts';
import { canInlineInitializedConstant } from '../../src/passes/dce/symbol-value.ts';
import { ReferenceFlags, ScopeFlags, SymbolFlags } from '../../src/passes/dce/syntax.ts';
import {
    createDceCtx,
    createIdentExpr,
    type DceCtx,
    dropStatement,
    getReference,
    getResolvedReferences,
    parentKind,
    replaceExpression,
    symbolIsUnused,
    takeNode,
} from '../../src/passes/dce/traverse-context.ts';
import { type Traverser, traverseProgram } from '../../src/passes/dce/traverse.ts';
import { printModule } from '../../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../../src/print/printer.ts';

const NORMALIZE = { convertWhileToFors: false, convertConstToLet: false, removeUnnecessaryUseStrict: false };

const parseKind = (sourceType: SourceType): 'module' | 'script' | 'commonjs' => sourceType;

function setup(
    source: string,
    sourceType: SourceType = 'module',
    verify = true,
): { program: Node; semantic: Semantic; ctx: DceCtx } {
    const { program } = parse(source, { ts: false, jsx: false, kind: parseKind(sourceType) });
    const semantic = createSemantic();
    analyze(semantic, program, sourceType === 'module');
    const ctx = createDceCtx(program, semantic, rolldownDceOptions(), 'tree-shake-only', sourceType, new Set(), verify);
    return { program, semantic, ctx };
}

function print(program: Node): string {
    const printer = createPrinter({ minify: false });
    printModule(printer, program);
    return finishPrinter(printer).trim();
}

function findAll(root: Node, predicate: (node: Node) => boolean): Node[] {
    const found: Node[] = [];
    walk(root, (visited) => {
        if (predicate(visited)) found.push(visited);
    });
    return found;
}

const identifiers = (root: Node, name: string): Node[] =>
    findAll(root, (visited) => visited.type === N.IdentifierReference && visited.name === name);

const bindingSymbol = (root: Node, name: string): number => {
    const [binding] = findAll(root, (visited) => visited.type === N.BindingIdentifier && visited.name === name);
    return binding.sym;
};

const flagsOf = (ctx: DceCtx, ident: Node): number => getReference(ctx, ident).flags;

const fields = (target: Node): Record<string, any> => target.data as unknown as Record<string, any>;

const READ = ReferenceFlags.Read;
const WRITE = ReferenceFlags.Write;
const MEMBER_WRITE_TARGET = ReferenceFlags.MemberWriteTarget;

describe('scoping view', () => {
    it('gives each reference oxc semantic flags', () => {
        const { program, ctx } = setup(
            [
                'let a, b, c, d, e, f, g, h, i, j, k, m, n, o, p, q, r, s, t, u;',
                'a = 1; b += 1; c++; d.x = 1; e.x.y = 1; f().x = 1;',
                '[g] = h; ({ i } = j); for (k of []) ; delete m.x; delete n;',
                '(o ? p : q).x = 1; r[s] = 1; t.x += 1; export default u;',
            ].join('\n'),
        );
        const flags = (name: string): number => flagsOf(ctx, identifiers(program, name)[0]);
        expect(flags('a')).toBe(WRITE);
        expect(flags('b')).toBe(READ | WRITE);
        expect(flags('c')).toBe(READ | WRITE);
        expect(flags('d')).toBe(READ | MEMBER_WRITE_TARGET);
        expect(flags('e')).toBe(READ | MEMBER_WRITE_TARGET);
        // The pending member-write flags are consumed by the next identifier: the callee.
        expect(flags('f')).toBe(READ | MEMBER_WRITE_TARGET);
        expect(flags('g')).toBe(WRITE);
        expect(flags('h')).toBe(READ);
        expect(flags('i')).toBe(WRITE);
        expect(flags('j')).toBe(READ);
        expect(flags('k')).toBe(WRITE);
        expect(flags('m')).toBe(READ | MEMBER_WRITE_TARGET);
        expect(flags('n')).toBe(READ);
        // A conditional's test is a pure read; the flags reach its consequent.
        expect(flags('o')).toBe(READ);
        expect(flags('p')).toBe(READ | MEMBER_WRITE_TARGET);
        expect(flags('q')).toBe(READ);
        expect(flags('r')).toBe(READ | MEMBER_WRITE_TARGET);
        expect(flags('s')).toBe(READ);
        expect(flags('t')).toBe(READ | MEMBER_WRITE_TARGET);
        expect(flags('u')).toBe(READ | ReferenceFlags.Type);
    });

    it('lists resolved references per symbol, globals unresolved', () => {
        const { program, ctx } = setup('let a = 1; a; a = 2; function f() { return a + g; }');
        const a = bindingSymbol(program, 'a');
        expect(getResolvedReferences(ctx, a).map((reference) => reference.flags)).toEqual([READ, WRITE, READ]);
        const [g] = identifiers(program, 'g');
        expect(getReference(ctx, g).symbolId).toBe(0);
        expect(ctx.isGlobalReference(g)).toBe(true);
    });

    it('records the scope each reference occurs in', () => {
        const { program, ctx } = setup('let a; function f() { a; { a; } } const g = () => a;');
        const [f] = findAll(program, (visited) => visited.type === N.FunctionDeclaration);
        const [block] = findAll(f, (visited) => visited.type === N.BlockStatement && visited.data.scopeId > 0);
        const [arrow] = findAll(program, (visited) => visited.type === N.ArrowFunctionExpression);
        const scopes = identifiers(program, 'a').map((ident) => getReference(ctx, ident).scopeId);
        expect(scopes).toEqual([fields(f).scopeId, fields(block).scopeId, fields(arrow).scopeId]);
    });

    it('computes oxc scope flags', () => {
        const { program, ctx } = setup(
            'class C { constructor() {} get g() {} set s(v) {} m() {} static { } } try {} catch (e) {} const f = () => {}; { }',
        );
        const flagsOf = (predicate: (node: Node) => boolean): number =>
            ctx.scoping.scopeFlags[fields(findAll(program, predicate)[0]).scopeId];
        const method = (kind: string) => (visited: Node) => visited.type === N.MethodDefinition && visited.data.kind === kind;
        const functionScope = (kind: string): number =>
            ctx.scoping.scopeFlags[fields(fields(findAll(program, method(kind))[0]).value).scopeId];
        expect(ctx.scoping.scopeFlags[ctx.scoping.rootScopeId]).toBe(ScopeFlags.Top | ScopeFlags.StrictMode);
        expect(functionScope('constructor')).toBe(ScopeFlags.Function | ScopeFlags.Constructor | ScopeFlags.StrictMode);
        expect(functionScope('get')).toBe(ScopeFlags.Function | ScopeFlags.GetAccessor | ScopeFlags.StrictMode);
        expect(functionScope('set')).toBe(ScopeFlags.Function | ScopeFlags.SetAccessor | ScopeFlags.StrictMode);
        expect(functionScope('method')).toBe(ScopeFlags.Function | ScopeFlags.StrictMode);
        expect(flagsOf((visited) => visited.type === N.StaticBlock)).toBe(ScopeFlags.ClassStaticBlock | ScopeFlags.StrictMode);
        expect(flagsOf((visited) => visited.type === N.CatchClause)).toBe(ScopeFlags.CatchClause | ScopeFlags.StrictMode);
        expect(flagsOf((visited) => visited.type === N.ArrowFunctionExpression)).toBe(
            ScopeFlags.Function | ScopeFlags.Arrow | ScopeFlags.StrictMode,
        );
        expect(flagsOf((visited) => visited.type === N.ClassDeclaration)).toBe(ScopeFlags.StrictMode);
    });

    it('propagates DirectEval from the call to every enclosing scope', () => {
        const { program, ctx } = setup('function f() { function g() { eval("x"); } } function h() {}', 'script');
        const scopeOf = (name: string): number =>
            fields(findAll(program, (visited) => visited.type === N.FunctionDeclaration && fields(visited).id?.name === name)[0])
                .scopeId;
        expect(ctx.scoping.scopeFlags[scopeOf('g')] & ScopeFlags.DirectEval).toBeTruthy();
        expect(ctx.scoping.scopeFlags[scopeOf('f')] & ScopeFlags.DirectEval).toBeTruthy();
        expect(ctx.scoping.scopeFlags[ctx.scoping.rootScopeId] & ScopeFlags.DirectEval).toBeTruthy();
        expect(ctx.scoping.scopeFlags[scopeOf('h')] & ScopeFlags.DirectEval).toBe(0);
    });

    it('computes oxc symbol flags from the declaration', () => {
        const { program, ctx } = setup(
            'import d from "x"; var a; let b; const c = 1; function f(p) {} async function* g() {} class K {} (function h() {}); try {} catch (e) {} try {} catch ({ q }) {}',
        );
        const flags = (name: string): number => ctx.scoping.symbolFlags[bindingSymbol(program, name)];
        expect(flags('a')).toBe(SymbolFlags.FunctionScopedVariable);
        expect(flags('b')).toBe(SymbolFlags.BlockScopedVariable);
        expect(flags('c')).toBe(SymbolFlags.BlockScopedVariable | SymbolFlags.ConstVariable);
        expect(flags('f')).toBe(SymbolFlags.Function);
        expect(flags('g')).toBe(SymbolFlags.Function | SymbolFlags.AsyncOrGeneratorFunction);
        expect(flags('h')).toBe(SymbolFlags.Function | SymbolFlags.FunctionExpression);
        expect(flags('K')).toBe(SymbolFlags.Class);
        expect(flags('p')).toBe(SymbolFlags.FunctionScopedVariable);
        expect(flags('d')).toBe(SymbolFlags.Import);
        expect(flags('e')).toBe(SymbolFlags.FunctionScopedVariable | SymbolFlags.CatchVariable);
        expect(flags('q')).toBe(SymbolFlags.BlockScopedVariable | SymbolFlags.CatchVariable);
    });

    it('lists every declaration of a redeclared symbol', () => {
        const { program, ctx } = setup('var x = 1; var x = 2; function f(y) { var y; }', 'script');
        expect(ctx.scoping.symbolRedeclarations.get(bindingSymbol(program, 'x'))).toHaveLength(2);
        expect(ctx.scoping.symbolRedeclarations.get(bindingSymbol(program, 'y'))).toHaveLength(2);
    });

    it('keeps directive prologues out of statement lists', () => {
        const { program, ctx } = setup('"use strict"; foo(); function f() { "use strict"; ("not a directive"); }', 'script');
        const [first] = fields(program).body;
        expect(ctx.directives.has(first)).toBe(true);
        expect(ctx.directives.size).toBe(2);
    });
});

describe('replace and drop accounting', () => {
    it('marks references only in the old subtree removed and moves a surviving identifier', () => {
        const { program, ctx } = setup('let a, b; a || b;');
        const [logical] = findAll(program, (visited) => visited.type === N.LogicalExpression);
        const [a] = identifiers(program, 'a');
        const [b] = identifiers(program, 'b');
        const aReference = getReference(ctx, a);
        const bReference = getReference(ctx, b);
        replaceExpression(ctx, logical, fields(logical).right);
        expect(aReference.markedRemoved).toBe(true);
        expect(bReference.markedRemoved).toBe(false);
        // The slot now holds `b`, and the reference follows the node that holds it.
        expect(logical.type).toBe(N.IdentifierReference);
        expect(getReference(ctx, logical)).toBe(bReference);
        expect(bReference.node).toBe(logical);
        expect(ctx.state.passChanges.revisitRequested).toBe(true);
        expect(ctx.state.passChanges.removedReferences).toEqual([aReference]);
    });

    it('keeps survivors nested deep inside the replacement', () => {
        const { program, ctx } = setup('let a, b, c; (a, f(b, c));');
        const [sequence] = findAll(program, (visited) => visited.type === N.SequenceExpression);
        const call = fields(sequence).expressions[1];
        const replacement = create.ArrayExpression(0, 0, 0, [fields(call).arguments[1]]);
        replaceExpression(ctx, sequence, replacement);
        const removed = ctx.state.passChanges.removedReferences.map((reference) => reference.node.name).sort();
        expect(removed).toEqual(['a', 'b', 'f']);
    });

    it('does not mark references minted since the last flush', () => {
        const { program, ctx } = setup('let a; a;');
        const [statement] = findAll(program, (visited) => visited.type === N.ExpressionStatement);
        const fresh = createIdentExpr(ctx, statement, 'a', bindingSymbol(program, 'a'), READ);
        expect(getResolvedReferences(ctx, bindingSymbol(program, 'a'))).toHaveLength(2);
        replaceExpression(ctx, fields(statement).expression, fresh);
        // The original `a` is removed; the minted reference is beyond the capacity guard.
        expect(ctx.state.passChanges.removedReferences.map((reference) => reference.id)).toEqual([0]);
        dropStatement(ctx, statement);
        expect(ctx.state.passChanges.removedReferences).toHaveLength(1);
    });

    it('moves a node out with takeNode so it can sit inside its own replacement', () => {
        const { program, ctx } = setup('let a; a;');
        const [statement] = findAll(program, (visited) => visited.type === N.ExpressionStatement);
        const slot = fields(statement).expression;
        const reference = getReference(ctx, slot);
        const moved = takeNode(ctx, slot);
        expect(getReference(ctx, moved)).toBe(reference);
        const zero = create.UnaryExpression(0, 0, 0, moved);
        replaceExpression(ctx, slot, create.SequenceExpression(0, 0, 0, [zero]));
        expect(ctx.state.passChanges.removedReferences).toEqual([]);
        expect(() => replaceExpression(ctx, slot, create.SequenceExpression(0, 0, 0, [slot]))).toThrow(/takeNode/);
    });

    it('records dropped direct eval calls', () => {
        const { program, ctx } = setup('eval("x"); f(eval("y"));', 'script');
        const [statement] = findAll(program, (visited) => visited.type === N.ExpressionStatement);
        dropStatement(ctx, statement);
        expect(ctx.state.passChanges.directEvalDropped).toBe(true);
    });
});

describe('pass flush', () => {
    it('prunes removed references and clears the accumulator', () => {
        const { program, ctx } = setup('let a = 1, b = 2; a || b;');
        normalize(program, ctx, NORMALIZE);
        finishNormalizePass(program, ctx);
        const [logical] = findAll(program, (visited) => visited.type === N.LogicalExpression);
        const a = bindingSymbol(program, 'a');
        replaceExpression(ctx, logical, fields(logical).right);
        expect(symbolIsUnused(ctx, a)).toBe(false);
        flushPassChanges(program, ctx);
        expect(symbolIsUnused(ctx, a)).toBe(true);
        expect(ctx.state.passChanges.removedReferences).toEqual([]);
        expect(ctx.state.passChanges.referenceCapacity).toBe(ctx.scoping.references.length);
    });

    it('clears DirectEval once the last direct eval is dropped', () => {
        const { program, ctx } = setup('function f() { eval("x"); } g();', 'script');
        normalize(program, ctx, NORMALIZE);
        finishNormalizePass(program, ctx);
        const [f] = findAll(program, (visited) => visited.type === N.FunctionDeclaration);
        const [statement] = findAll(f, (visited) => visited.type === N.ExpressionStatement);
        dropStatement(ctx, statement);
        fields(fields(f).body).body.length = 0;
        expect(flushPassChanges(program, ctx)).toBe(true);
        expect(ctx.scoping.scopeFlags[ctx.scoping.rootScopeId] & ScopeFlags.DirectEval).toBe(0);
        expect(ctx.scoping.scopeFlags[fields(f).scopeId] & ScopeFlags.DirectEval).toBe(0);
    });
});

/** Every hook, logged with the node's type and the slot it sits in. */
function recordHooks(source: string): string[] {
    const { program, ctx } = setup(source, 'script');
    const log: string[] = [];
    const record = (hook: string) => (context: DceCtx, visited: Node) =>
        log.push(`${hook} ${TYPE_NAME[visited.type]}@${parentKind(context)}`);
    const traverser: Traverser<DceCtx> = {
        enterProgram: record('enterProgram'),
        exitProgram: record('exitProgram'),
        enterStatement: record('enterStatement'),
        exitStatement: record('exitStatement'),
        exitStatements: (context, statements, first) =>
            log.push(`exitStatements ${statements.length - first}@${parentKind(context)}`),
        enterExpression: record('enterExpression'),
        exitExpression: record('exitExpression'),
        enterFunction: record('enterFunction'),
        enterFunctionBody: record('enterFunctionBody'),
        exitFunctionBody: record('exitFunctionBody'),
        enterArrowFunctionBody: record('enterArrowFunctionBody'),
        exitArrowFunctionBody: record('exitArrowFunctionBody'),
        enterVariableDeclaration: record('enterVariableDeclaration'),
        exitVariableDeclaration: record('exitVariableDeclaration'),
        exitVariableDeclarator: record('exitVariableDeclarator'),
        exitCallExpression: record('exitCallExpression'),
        exitAssignmentTarget: record('exitAssignmentTarget'),
    };
    traverseProgram(traverser, program, ctx);
    return log;
}

describe('walker hook order', () => {
    it('matches oxc for a call statement', () => {
        expect(recordHooks('a(b);')).toEqual([
            'enterProgram Program@None',
            'enterStatement ExpressionStatement@ProgramBody',
            'enterExpression CallExpression@ExpressionStatementExpression',
            'enterExpression IdentifierReference@CallExpressionCallee',
            'exitExpression IdentifierReference@CallExpressionCallee',
            'enterExpression IdentifierReference@CallExpressionArguments',
            'exitExpression IdentifierReference@CallExpressionArguments',
            'exitCallExpression CallExpression@ExpressionStatementExpression',
            'exitExpression CallExpression@ExpressionStatementExpression',
            'exitStatement ExpressionStatement@ProgramBody',
            'exitStatements 1@ProgramBody',
            'exitProgram Program@None',
        ]);
    });

    it('treats assignment targets and binding patterns as oxc does', () => {
        expect(recordHooks('x.y = z; var { a = b } = c; for (k of l) {}')).toEqual([
            'enterProgram Program@None',
            'enterStatement ExpressionStatement@ProgramBody',
            'enterExpression AssignmentExpression@ExpressionStatementExpression',
            'enterExpression IdentifierReference@StaticMemberExpressionObject',
            'exitExpression IdentifierReference@StaticMemberExpressionObject',
            'exitAssignmentTarget StaticMemberExpression@AssignmentExpressionLeft',
            'enterExpression IdentifierReference@AssignmentExpressionRight',
            'exitExpression IdentifierReference@AssignmentExpressionRight',
            'exitExpression AssignmentExpression@ExpressionStatementExpression',
            'exitStatement ExpressionStatement@ProgramBody',
            'enterStatement VariableDeclaration@ProgramBody',
            'enterVariableDeclaration VariableDeclaration@ProgramBody',
            'enterExpression IdentifierReference@AssignmentPatternRight',
            'exitExpression IdentifierReference@AssignmentPatternRight',
            'enterExpression IdentifierReference@VariableDeclaratorInit',
            'exitExpression IdentifierReference@VariableDeclaratorInit',
            'exitVariableDeclarator VariableDeclarator@VariableDeclarationDeclarations',
            'exitVariableDeclaration VariableDeclaration@ProgramBody',
            'exitStatement VariableDeclaration@ProgramBody',
            'enterStatement ForOfStatement@ProgramBody',
            'exitAssignmentTarget IdentifierReference@ForOfStatementLeft',
            'enterExpression IdentifierReference@ForOfStatementRight',
            'exitExpression IdentifierReference@ForOfStatementRight',
            'enterStatement BlockStatement@ForOfStatementBody',
            'exitStatements 0@BlockStatementBody',
            'exitStatement BlockStatement@ForOfStatementBody',
            'exitStatement ForOfStatement@ProgramBody',
            'exitStatements 3@ProgramBody',
            'exitProgram Program@None',
        ]);
    });

    it('walks functions, bodies and arrow bodies as oxc does, skipping directives', () => {
        expect(recordHooks('function f(p = 1) { "use strict"; return () => p; }')).toEqual([
            'enterProgram Program@None',
            'enterStatement FunctionDeclaration@ProgramBody',
            'enterFunction FunctionDeclaration@ProgramBody',
            'enterExpression NumericLiteral@FormalParameterInitializer',
            'exitExpression NumericLiteral@FormalParameterInitializer',
            'enterFunctionBody BlockStatement@FunctionBody',
            'enterStatement ReturnStatement@FunctionBodyStatements',
            'enterExpression ArrowFunctionExpression@ReturnStatementArgument',
            'enterArrowFunctionBody IdentifierReference@ArrowFunctionExpressionBody',
            'enterExpression IdentifierReference@ArrowFunctionExpressionBody',
            'exitExpression IdentifierReference@ArrowFunctionExpressionBody',
            'exitArrowFunctionBody IdentifierReference@ArrowFunctionExpressionBody',
            'exitExpression ArrowFunctionExpression@ReturnStatementArgument',
            'exitStatement ReturnStatement@FunctionBodyStatements',
            'exitStatements 1@FunctionBodyStatements',
            'exitFunctionBody BlockStatement@FunctionBody',
            'exitStatement FunctionDeclaration@ProgramBody',
            'exitStatements 1@ProgramBody',
            'exitProgram Program@None',
        ]);
    });

    it('gives chain elements no expression hooks', () => {
        expect(recordHooks('a?.b();')).toEqual([
            'enterProgram Program@None',
            'enterStatement ExpressionStatement@ProgramBody',
            'enterExpression ChainExpression@ExpressionStatementExpression',
            'enterExpression StaticMemberExpression@CallExpressionCallee',
            'enterExpression IdentifierReference@StaticMemberExpressionObject',
            'exitExpression IdentifierReference@StaticMemberExpressionObject',
            'exitExpression StaticMemberExpression@CallExpressionCallee',
            'exitCallExpression CallExpression@ChainExpressionExpression',
            'exitExpression ChainExpression@ExpressionStatementExpression',
            'exitStatement ExpressionStatement@ProgramBody',
            'exitStatements 1@ProgramBody',
            'exitProgram Program@None',
        ]);
    });

    it('tracks the current scope', () => {
        const { program, ctx } = setup('let a; switch (a) { case 1: a; } class C extends a {}');
        const scopes: number[] = [];
        traverseProgram<DceCtx>({ exitExpression: (context) => scopes.push(context.currentScopeId) }, program, ctx);
        const [switchStatement] = findAll(program, (visited) => visited.type === N.SwitchStatement);
        const [classDeclaration] = findAll(program, (visited) => visited.type === N.ClassDeclaration);
        const root = ctx.scoping.rootScopeId;
        // The discriminant is outside the switch scope; the heritage is inside the class scope.
        expect(scopes).toEqual([
            root,
            fields(switchStatement).scopeId,
            fields(switchStatement).scopeId,
            fields(classDeclaration).scopeId,
        ]);
        expect(ctx.currentScopeId).toBe(root);
        expect(ctx.ancestorDepth).toBe(0);
    });

    it('continues from the new shape when a hook rewrites its node', () => {
        const { program, ctx } = setup('a; b;', 'script');
        const visited: string[] = [];
        traverseProgram<DceCtx>(
            {
                enterStatement(context, statement) {
                    if (
                        parentKind(context) === 'ProgramBody' &&
                        statement.type === N.ExpressionStatement &&
                        statement.data.expression.name === 'a'
                    ) {
                        const inner = create.ExpressionStatement(0, 0, 0, statement.data.expression);
                        const retyped = statement as { type: number; data: unknown };
                        retyped.type = N.BlockStatement;
                        retyped.data = { body: [inner], scopeId: 0 };
                    }
                },
                exitExpression: (_context, expression) => visited.push(expression.name),
                exitStatement(_context, statement) {
                    if (statement.type === N.ExpressionStatement && statement.data.expression.name === 'b') {
                        const retyped = statement as { type: number; data: unknown };
                        retyped.type = N.EmptyStatement;
                        retyped.data = null;
                    }
                },
            },
            program,
            ctx,
        );
        expect(visited).toEqual(['a', 'b']);
        expect(print(program)).toBe('{\n    a;\n}\n;');
    });

    it('walks a 1000-level nesting program iteratively', () => {
        let source = 'let v0 = 1;\n';
        for (let level = 1; level <= 1000; level++) source += `{ let v${level} = v${level - 1} + 1;\n`;
        source += `globalThis.sink = v1000;\n${'}'.repeat(1000)}`;
        const { program, semantic } = setup(source);
        let statements = 0;
        const { ctx } = setup(source);
        traverseProgram<DceCtx>({ enterStatement: () => void statements++ }, program, ctx);
        expect(statements).toBe(2002);
        const result = eliminateDeadCode(program, semantic, rolldownDceOptions(), 'module', new Set(), true);
        // the whole chain folds, as rolldown's per-module pass folds it
        expect(print(program)).toBe('globalThis.sink = 1001;');
        expect(result.iterations).toBe(2);
        expect(verifyRefFacts(semantic, program)).toEqual([]);
    });
});

/** The values recorded by the last peephole pass. */
function valuesAfterPass(source: string, sourceType: SourceType = 'module'): { program: Node; ctx: DceCtx } {
    const { program, ctx } = setup(source, sourceType, false);
    normalize(program, ctx, NORMALIZE);
    finishNormalizePass(program, ctx);
    runPeepholePass(program, ctx);
    return { program, ctx };
}

const symbolValueFor = (source: string, name: string, sourceType: SourceType = 'module') => {
    const { program, ctx } = valuesAfterPass(source, sourceType);
    return symbolValueOf(ctx.state.symbols, bindingSymbol(program, name));
};

describe('full-minify walker hooks', () => {
    /** The hooks only the full minifier uses, in the order they fire, with the node's type. */
    function recordFullHooks(source: string): string[] {
        const { program, ctx } = setup(source, 'module', false);
        const log: string[] = [];
        const record =
            (name: string) =>
            (_context: DceCtx, node: Node): void => {
                log.push(`${name} ${TYPE_NAME[node.type]}`);
            };
        const names = [
            'exitForStatement',
            'exitReturnStatement',
            'exitCatchClause',
            'exitObjectProperty',
            'exitAssignmentTargetProperty',
            'exitAssignmentTargetPropertyProperty',
            'exitBindingProperty',
            'exitMethodDefinition',
            'exitPropertyDefinition',
            'exitAccessorProperty',
            'exitMemberExpression',
            'exitPrivateFieldExpression',
            'exitPrivateInExpression',
            'enterClassBody',
            'exitClassBody',
        ] as const;
        const traverser: Traverser<DceCtx> = {};
        for (const name of names) traverser[name] = record(name);
        traverseProgram(traverser, program, ctx);
        return log;
    }

    it('fires each property kind its own hook', () => {
        expect(recordFullHooks('({ a: 1, m() {} }); var { a, b: c } = o; ({ a, b: c } = o);')).toEqual([
            'exitObjectProperty ObjectProperty',
            'exitObjectProperty ObjectProperty',
            'exitBindingProperty ObjectProperty',
            'exitBindingProperty ObjectProperty',
            'exitAssignmentTargetProperty ObjectProperty',
            'exitAssignmentTargetPropertyProperty ObjectProperty',
            'exitAssignmentTargetProperty ObjectProperty',
        ]);
    });

    it('fires the class body hooks around the members, and each member and private access its own', () => {
        expect(recordFullHooks('class C { #x; m() {} accessor y; static z; f() { return #x in this && this.#x; } }')).toEqual([
            'enterClassBody ClassDeclaration',
            'exitPropertyDefinition PropertyDefinition',
            'exitMethodDefinition MethodDefinition',
            'exitAccessorProperty PropertyDefinition',
            'exitPropertyDefinition PropertyDefinition',
            'exitPrivateInExpression BinaryExpression',
            'exitPrivateFieldExpression PrivateFieldExpression',
            'exitMemberExpression PrivateFieldExpression',
            'exitReturnStatement ReturnStatement',
            'exitMethodDefinition MethodDefinition',
            'exitClassBody ClassDeclaration',
        ]);
    });

    it('fires member expressions inside out, and for, return and catch', () => {
        expect(recordFullHooks('a.b[c]; for (;;) break; try {} catch (e) {} function f() { return; }')).toEqual([
            'exitMemberExpression StaticMemberExpression',
            'exitMemberExpression ComputedMemberExpression',
            'exitForStatement ForStatement',
            'exitCatchClause CatchClause',
            'exitReturnStatement ReturnStatement',
        ]);
    });
});

describe('symbol values (init_symbol_value)', () => {
    it('records constants of lexical declarations', () => {
        expect(symbolValueFor('const a = 1 + 2; export { a };', 'a')?.initializedConstant).toEqual({ kind: 'number', value: 3 });
        const empty = symbolValueFor('let a; export { a };', 'a');
        expect(empty?.initializedConstant).toEqual({ kind: 'undefined' });
        expect(empty?.implicitUndefined).toBe(true);
        expect(symbolValueFor('const a = f(); export { a };', 'a')?.initializedConstant).toBeNull();
    });

    it('inlines a top-level var read only inside functions of a clean prelude', () => {
        // unconditional_var_declarator_positions_still_inline
        expect(symbolValueFor('var flag = true; export function f() { return flag; }', 'flag')?.initializedConstant).toEqual({
            kind: 'boolean',
            value: true,
        });
        expect(
            symbolValueFor('export var flag = true; export function f() { return flag; }', 'flag')?.initializedConstant,
        ).toEqual({
            kind: 'boolean',
            value: true,
        });
        // readonly_var_unsafe_preceding_call
        expect(symbolValueFor('output(); var foo = true; function output() { foo; }', 'foo')?.initializedConstant).toBeNull();
        // readonly_var_unsafe_preceding_read: the read is in the same function frame.
        expect(symbolValueFor('var y = foo; var foo = 1; log(y);', 'foo')?.initializedConstant).toBeNull();
        // A module loader can reach the var through an import cycle.
        expect(
            symbolValueFor('import "x"; var flag = true; export function f() { return flag; }', 'flag')?.initializedConstant,
        ).toBeNull();
        // Script-root vars alias the global object.
        expect(
            symbolValueFor('var flag = true; function f() { return flag; }', 'flag', 'script')?.initializedConstant,
        ).toBeNull();
    });

    it('withholds values of conditional vars but keeps their falsy fact', () => {
        // conditional_var_declarator_not_inlined
        const conditional = symbolValueFor(
            'export function t() { if (window.x) { var callback = true } return () => callback; }',
            'callback',
        );
        expect(conditional?.initializedConstant).toBeNull();
        // single_conditional_falsy_var_still_folds_in_boolean_context
        const falsy = symbolValueFor('export function f(a) { if (a) var x = false; return x ? 1 : 2; }', 'x');
        expect(falsy?.initializedConstant).toBeNull();
        expect(falsy?.booleanFalsy).toBe(true);
        // conditional_labeled_var_declarator_not_inlined
        expect(
            symbolValueFor('export function t(c) { if (c) L: var flag = true; return () => flag; }', 'flag')?.initializedConstant,
        ).toBeNull();
    });

    it('disables every fact of a redeclared symbol', () => {
        // redeclared_var_facts_are_disabled_before_first_use
        const redeclared = symbolValueFor(
            'export function outer() { var x = false; function read() { return x; } var x = true; return read(); }',
            'x',
        );
        expect(redeclared?.initializedConstant).toBeNull();
        expect(redeclared?.booleanFalsy).toBe(false);
        // redeclared_falsy_var_is_not_assumed_falsy: a conditional var redeclaring a parameter.
        expect(symbolValueFor('export function f(x, c) { if (c) var x = false; return x; }', 'x')?.booleanFalsy).toBe(false);
        // redeclared_vars_are_not_assumed_fresh
        expect(symbolValueFor('export function f(a, o) { if (a) var x = o; else var x = {}; x.p = 1; }', 'x')?.kind).toBe('none');
    });

    it('classifies fresh values', () => {
        expect(symbolValueFor('const o = {}; export { o };', 'o')?.kind).toBe('object');
        expect(symbolValueFor('const o = { get a() {} }; export { o };', 'o')?.kind).toBe('none');
        expect(symbolValueFor('const o = { __proto__: p }; export { o };', 'o')?.kind).toBe('none');
        expect(symbolValueFor('const o = { a: { set b(v) {} } }; export { o };', 'o')?.kind).toBe('none');
        expect(symbolValueFor('const o = []; export { o };', 'o')?.kind).toBe('array');
        expect(symbolValueFor('const o = () => {}; export { o };', 'o')?.kind).toBe('function');
        expect(symbolValueFor('const o = class {}; export { o };', 'o')?.kind).toBe('class');
        expect(symbolValueFor('const o = class { static x = 1 }; export { o };', 'o')?.kind).toBe('none');
        // conditional_var_is_not_assumed_fresh
        expect(symbolValueFor('export function f(a) { if (a) var x = {}; x.p = 1; }', 'x')?.kind).toBe('none');
    });

    it('records no value for a for-in/of head', () => {
        expect(symbolValueFor('for (const a of b) a;', 'a')?.initializedConstant ?? null).toBeNull();
    });

    it('applies the small-value inlining rule', () => {
        const once = symbolValueFor('const s = "a long string"; export default s;', 's');
        expect(once !== null && canInlineInitializedConstant(once)).toBe(true);
        const twice = symbolValueFor('const s = "a long string"; f(s, s);', 's');
        expect(twice !== null && canInlineInitializedConstant(twice)).toBe(false);
        const small = symbolValueFor('const n = 999; f(n, n);', 'n');
        expect(small !== null && canInlineInitializedConstant(small)).toBe(true);
        const written = symbolValueFor('let n = 1; n = 2; f(n);', 'n');
        expect(written !== null && canInlineInitializedConstant(written)).toBe(false);
    });
});

/** Liveness after Normalize, before any peephole pass. */
function deadAfterNormalize(source: string, sourceType: SourceType = 'module'): (name: string) => boolean {
    const { program, ctx } = setup(source, sourceType, false);
    normalize(program, ctx, NORMALIZE);
    finishNormalizePass(program, ctx);
    return (name) => functionIsDead(ctx.state.symbols, bindingSymbol(program, name));
}

describe('symbol liveness', () => {
    it('publishes dead recursive cycles', () => {
        // dce_recursive_unused_functions / remove_recursive_unused_function_declaration
        expect(deadAfterNormalize('function f() { f() }')('f')).toBe(true);
        const cycle = deadAfterNormalize('function c() { d() } function d() { c() }');
        expect(cycle('c') && cycle('d')).toBe(true);
        expect(deadAfterNormalize('function f() { console.log(1); f() }')('f')).toBe(true);
        expect(deadAfterNormalize('function f() { g(f) }')('f')).toBe(true);
    });

    it('keeps cycles with a live reference', () => {
        // The only external reference sits in code a later pass removes; before that it is live.
        const external = deadAfterNormalize('if (false) c(); function c() { d() } function d() { c() }');
        expect(external('c') || external('d')).toBe(false);
        expect(deadAfterNormalize('function f() { f(); } console.log(f);')('f')).toBe(false);
        expect(deadAfterNormalize('export function f() { f(); }')('f')).toBe(false);
        // keep_recursive_functions_referenced_outside_registered_functions
        const outside = deadAfterNormalize(
            'function a() { b() } function b() { a() } use(() => a, function () { b() }, class { m() { a() } });',
        );
        expect(outside('a') || outside('b')).toBe(false);
    });

    it('finds owners through nested scopes of every kind', () => {
        // remove_recursive_functions_through_nested_scope_kinds
        const nested = deadAfterNormalize(
            'function a(p = b) { { return () => function () { return class { m() { b() } } } } } function b() { a() }',
        );
        expect(nested('a') && nested('b')).toBe(true);
        // remove_recursive_unused_nested_in_live_function
        const inner = deadAfterNormalize('function live() { function inner() { inner() } return 1; } g(live());');
        expect(inner('inner')).toBe(true);
        expect(inner('live')).toBe(false);
    });

    it('respects Script roots, Annex B aliases and direct eval', () => {
        // dce_recursive_unused_functions_in_commonjs_and_script
        expect(deadAfterNormalize('function f() { f() }', 'script')('f')).toBe(false);
        expect(deadAfterNormalize('{ function f() { f() } }', 'script')('f')).toBe(false);
        expect(deadAfterNormalize('{ function f() { f() } }', 'commonjs')('f')).toBe(true);
        expect(deadAfterNormalize('function outer() { function c() { d() } function d() { c() } return 1 }', 'script')('c')).toBe(
            true,
        );
        expect(deadAfterNormalize('eval("x"); function f() { f() }')('f')).toBe(false);
    });

    it('marks exported and using bindings implicitly observable', () => {
        const { program, ctx } = setup('export var f; var g = 1; export { g }; export default function h() {} { using r = x; }');
        normalize(program, ctx, NORMALIZE);
        for (const name of ['f', 'g', 'h', 'r'])
            expect(isImplicitlyObservable(ctx.state.symbols, bindingSymbol(program, name))).toBe(true);
    });

    it('sees references Normalize drops before the first pass', () => {
        // normalize_flushes_before_initial_liveness
        expect(deadAfterNormalize('function f() { f() } void f;')('f')).toBe(true);
    });

    it('removes published dead functions in the full loop', () => {
        // Verify mode asserts no function survives the pass after its deadness is published.
        expect(functionsAfterLoop('function f() { f() }')).toEqual([]);
        expect(functionsAfterLoop('function c() { d() } function d() { c() }')).toEqual([]);
        expect(functionsAfterLoop('function f() { g(f) }')).toEqual([]);
        expect(functionsAfterLoop('function f() { f() } void f;')).toEqual([]);
        expect(
            functionsAfterLoop(
                'function a(p = b) { { return () => function () { return class { m() { b() } } } } } function b() { a() }',
            ),
        ).toEqual([]);
        expect(functionsAfterLoop('function live() { function inner() { inner() } return 1; } g(live());')).toEqual(['live']);
        expect(functionsAfterLoop('{ function f() { f() } }', 'commonjs')).toEqual([]);
        expect(functionsAfterLoop('function outer() { function c() { d() } function d() { c() } return 1 }', 'script')).toEqual([
            'outer',
        ]);
        // The only outside reference sits in code a later pass removes.
        expect(functionsAfterLoop('if (false) c(); function c() { d() } function d() { c() }')).toEqual([]);
    });

    it('keeps live and observable functions in the full loop', () => {
        expect(functionsAfterLoop('function f() { f(); } console.log(f);')).toEqual(['f']);
        expect(functionsAfterLoop('export function f() { f(); }')).toEqual(['f']);
        expect(functionsAfterLoop('function f() { f() }', 'script')).toEqual(['f']);
        expect(functionsAfterLoop('{ function f() { f() } }', 'script')).toEqual(['f']);
        expect(functionsAfterLoop('eval("x"); function f() { f() }')).toEqual(['f']);
        expect(
            functionsAfterLoop(
                'function a() { b() } function b() { a() } use(() => a, function () { b() }, class { m() { a() } });',
            ),
        ).toEqual(['a', 'b']);
    });
});

/** Names of the function declarations left after the whole run, in verify mode. */
function functionsAfterLoop(source: string, sourceType: SourceType = 'module'): string[] {
    const { program, semantic } = setup(source, sourceType);
    eliminateDeadCode(program, semantic, dceOptions(), sourceType, new Set(), true);
    expect(verifyRefFacts(semantic, program)).toEqual([]);
    return findAll(program, (visited) => visited.type === N.FunctionDeclaration).map(
        (declaration) => (fields(declaration).id as Node).name,
    );
}

function isTerminatedList(body: string): boolean {
    const { program } = parse(`function f() { ${body} }`, { ts: false, jsx: false, kind: 'script' });
    return statementsAreTerminated(fields(fields(fields(program).body[0]).body).body);
}

describe('keep-var and is-terminated', () => {
    it('collects hoisted var names from dead statements', () => {
        const { program } = setup(
            'if (x) { var a = 1; let b; for (var c in d) ; function f() { var inner; } } else var e;',
            'script',
        );
        const keepVar = createKeepVar();
        keepVarVisitStatement(keepVar, fields(program).body[0]);
        expect(keepVar.vars.map((kept) => kept.name)).toEqual(['a', 'c', 'e']);
        const declaration = keepVarVariableDeclaration(keepVar);
        expect(declaration === null ? '' : print(create.Program(0, 0, 0, [declaration]))).toBe('var a, c, e;');
    });

    it('detects terminated statement lists', () => {
        expect(isTerminatedList('return; var a; function f() {}')).toBe(true);
        expect(isTerminatedList('if (x) return; else throw y;')).toBe(true);
        expect(isTerminatedList('if (x) return;')).toBe(false);
        expect(isTerminatedList('try { return } finally { x() }')).toBe(false);
        expect(isTerminatedList('try { return } catch { throw e }')).toBe(true);
    });
});

describe('eliminateDeadCode', () => {
    it('runs Normalize and the loop to a fixed point, then rewrites Semantic counts', () => {
        const source =
            'let a = undefined, b = 1;;; console.log(a, NaN, Number.NaN, -1, void b, Infinity); new Map(); export { a };';
        const { program, semantic } = setup(source);
        const b = bindingSymbol(program, 'b');
        expect(semantic.uses[b]).toBe(1);
        const result = eliminateDeadCode(program, semantic, rolldownDceOptions(), 'module', new Set(), true);
        // `b` goes once `void b` no longer reads it, and the unused `new Map()` with it: rolldown's
        // `minify: false` output is this, less the `a` its linker then inlines as a constant
        expect(print(program)).toBe('let a = void 0;\nconsole.log(a, NaN, NaN, -1, void 0, Infinity);\nexport { a };');
        expect(result).toEqual({ iterations: 1, changed: true });
        expect(semantic.uses[b]).toBe(0);
        expect(verifyRefFacts(semantic, program)).toEqual([]);
    });

    it('reports an untouched program unchanged', () => {
        const { program, semantic } = setup('export function f(a) { return a + 1; }');
        expect(eliminateDeadCode(program, semantic, dceOptions(), 'module', new Set(), true)).toEqual({
            iterations: 0,
            changed: false,
        });
    });

    it('marks calls to @__NO_SIDE_EFFECTS__ functions pure, and drops the unused one', () => {
        const { program, semantic } = setup('function f() { return globalThis.x; }\nexport const y = f();\nf();\nexport { f };');
        eliminateDeadCode(program, semantic, dceOptions(), 'module', new Set([bindingSymbol(program, 'f')]), true);
        const code = print(program);
        expect(code).toContain('export const y = /* @__PURE__ */ f();');
        expect(code).not.toMatch(/^f\(\);$/m);
    });
});
