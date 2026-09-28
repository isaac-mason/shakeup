// rolldown's `optimization.inlineConst`, in its default mode (`Smart`, one pass).
//
// A module's exported, never-reassigned top-level bindings whose initialiser evaluates to a primitive
// are constants (`ast_scanner`: `visit_variable_declaration`, `scan_export_default_decl`, and the
// `IsNotReassigned` retain in `mod.rs`). Every read of one, in its own module or through an import or
// a namespace member, is replaced by the value when the value is small (`safe_to_inline`) or when the
// read sits in an `if` test, a `?:` test or a logical expression (`module_finalizers`,
// `SmartInlineConst`). An imported read of a small constant does not keep its declaration alive
// (`is_bypassed_inlined_constant`).
//
// Not ported: CommonJS `exports.x = 1` constants, which rolldown resolves through facade symbols
// shakeup does not have.
import { evaluateValue } from '../analysis/const-eval.ts';
import type { ConstantValue } from '../analysis/constant-value.ts';
import { scopeOf, symbolOf } from '../analysis/semantic.ts';
import { N, type Node, walkChildren } from '../ast/index.ts';
import { type Graph, type Linked, type Module, packRef, refMod } from './graph-types.ts';
import { namespaceLocals } from './link.ts';

/** `ConstExportMeta::new`: whether a value is small enough to inline wherever it is read. */
export function isSafeToInline(value: ConstantValue): boolean {
    switch (value.kind) {
        case 'number':
            return Number.isInteger(value.value) && value.value >= -99 && value.value <= 999;
        case 'bigint':
            return false;
        case 'string':
            return utf8Length(value.value) <= 3;
        default:
            return true;
    }
}

/** Rust's `str::len`, which `safe_to_inline` compares against. */
function utf8Length(text: string): number {
    let length = 0;
    for (const char of text) {
        const code = char.codePointAt(0) as number;
        length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return length;
}

/** Statements that hold statements. Outside a function or class a declaration can only sit in one
 *  of these, never inside an expression. */
function holdsStatements(node: Node): boolean {
    switch (node.type) {
        case N.BlockStatement:
        case N.IfStatement:
        case N.ForStatement:
        case N.ForInStatement:
        case N.ForOfStatement:
        case N.WhileStatement:
        case N.DoWhileStatement:
        case N.LabeledStatement:
        case N.SwitchStatement:
        case N.SwitchCase:
        case N.TryStatement:
        case N.CatchClause:
            return true;
        default:
            return false;
    }
}

/**
 * The constants `mod` exports, keyed by `packRef`. Declarations are evaluated in source order against
 * the module's own constants so far, exported or not, as the scanner does; only exported ones are kept.
 */
function collectModuleConstants(mod: Module, linked: Linked, out: Map<number, ConstantValue>): void {
    const semantic = mod.semantic;
    const rootScope = scopeOf(semantic, mod.program);
    const local = new Map<number, ConstantValue>();
    const context = { constantOf: (ident: Node) => local.get(ident.sym) ?? null };
    const isWritten = (sym: number): boolean => (semantic.refs[sym]?.writes ?? 0) > 0;
    const exported = new Set<number>();
    for (const exp of mod.namedExports.values()) if (exp.rec === -1 && exp.symbol !== 0) exported.add(exp.symbol);

    const addConstant = (sym: number, init: Node | null): void => {
        if (sym === 0 || init === null || isWritten(sym)) return;
        const value = evaluateValue(init, context);
        if (value !== null) local.set(sym, value);
    };
    const visitDeclaration = (declaration: Node, atRootScope: boolean): void => {
        if (declaration.type !== N.VariableDeclaration) return;
        const declarators = declaration.data.declarations;
        if (declarators.length === 1) {
            const only = declarators[0];
            if (only.type !== N.VariableDeclarator || only.data.id.type !== N.BindingIdentifier) return;
            const sym = symbolOf(semantic, only.data.id);
            if (sym !== 0 && semantic.symbols[sym].scope === rootScope) addConstant(sym, only.data.init);
            return;
        }
        if (!atRootScope) return;
        for (const declarator of declarators)
            if (declarator.type === N.VariableDeclarator && declarator.data.id.type === N.BindingIdentifier)
                addConstant(symbolOf(semantic, declarator.data.id), declarator.data.init);
    };
    // In source order, since each initialiser sees only the constants before it. Not into functions:
    // a declaration in a function body binds in that function, never at the root. An explicit stack,
    // because the AST can nest deeper than the call stack allows.
    const visitStatements = (statements: Node[]): void => {
        const stack: Node[] = [];
        const atRoot: boolean[] = [];
        for (let i = statements.length - 1; i >= 0; i--) {
            stack.push(statements[i]);
            atRoot.push(true);
        }
        const children: Node[] = [];
        const pushChild = (child: Node): void => {
            children.push(child);
        };
        while (stack.length > 0) {
            const statement = stack.pop() as Node;
            const atRootScope = atRoot.pop() as boolean;
            if (statement.type === N.VariableDeclaration) {
                visitDeclaration(statement, atRootScope);
                continue;
            }
            if (statement.type === N.ExportNamedDeclaration) {
                const declaration = statement.data.declaration;
                if (declaration !== null) visitDeclaration(declaration, atRootScope);
                continue;
            }
            if (statement.type === N.ExportDefaultDeclaration) {
                visitDefaultExport(statement.data.declaration);
                continue;
            }
            if (!holdsStatements(statement)) continue;
            children.length = 0;
            walkChildren(statement, pushChild);
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push(children[i]);
                atRoot.push(false);
            }
        }
    };
    const visitDefaultExport = (declaration: Node): void => {
        if (declaration.type === N.FunctionDeclaration || declaration.type === N.ClassDeclaration) return;
        const value = evaluateValue(declaration, context);
        const reused = reusedDefaultSymbol(mod, declaration);
        if (reused !== 0) {
            exported.add(reused);
            if (value !== null) local.set(reused, value);
            return;
        }
        const defaultRef = linked.defaultRefs.get(mod.idx);
        if (value !== null && defaultRef !== undefined) out.set(defaultRef, value);
    };
    visitStatements(mod.program.data.body as Node[]);

    for (const [sym, value] of local) if (exported.has(sym) && !isWritten(sym)) out.set(packRef(mod.idx, sym), value);
}

/**
 * `export default name` names `name` itself when rolldown can reuse its symbol for the default export:
 * declared before the export, not an import, declared once and never written.
 */
function reusedDefaultSymbol(mod: Module, declaration: Node): number {
    if (declaration.type !== N.IdentifierReference) return 0;
    const semantic = mod.semantic;
    const sym = symbolOf(semantic, declaration);
    if (sym === 0 || mod.namedImports.has(sym)) return 0;
    const decl = semantic.symbols[sym].decl;
    if (decl === null || decl.start > declaration.start) return 0;
    if (semantic.redeclarations.has(sym)) return 0;
    if ((semantic.refs[sym]?.writes ?? 0) > 0) return 0;
    return sym;
}

/** The constant `ident` reads, following an import to its canonical binding. */
function constantRead(mod: Module, linked: Linked, rootScope: number, ident: Node): ConstantValue | null {
    const sym = ident.sym;
    if (sym === 0) return null;
    if (mod.namedImports.has(sym)) {
        const bind = linked.binds.get(packRef(mod.idx, sym));
        return bind !== undefined && bind.kind === 'found' ? (linked.constExports.get(bind.ref) ?? null) : null;
    }
    if (mod.semantic.symbols[sym].scope !== rootScope) return null;
    return linked.constExports.get(packRef(mod.idx, sym)) ?? null;
}

/** The constant `ns.name` reads, when `ns` is a namespace import of a module whose exports are known. */
function constantMemberRead(linked: Linked, namespaces: Map<number, number>, member: Node): ConstantValue | null {
    if (member.type !== N.StaticMemberExpression) return null;
    const object = member.data.object;
    if (object.type !== N.IdentifierReference) return null;
    const target = namespaces.get(object.sym);
    if (target === undefined) return null;
    const bind = linked.exportMaps.get(target)?.get(member.data.property.name);
    return bind !== undefined && bind.kind === 'found' ? (linked.constExports.get(bind.ref) ?? null) : null;
}

/** Whether any read in `mod` could resolve to a constant: its own, an import of one, or a member of
 *  a namespace that exports one. */
function mayReadConstant(
    mod: Module,
    linked: Linked,
    exportingModules: ReadonlySet<number>,
    namespaces: Map<number, number>,
): boolean {
    if (exportingModules.has(mod.idx)) return true;
    for (const sym of mod.namedImports.keys()) {
        const bind = linked.binds.get(packRef(mod.idx, sym));
        if (bind !== undefined && bind.kind === 'found' && linked.constExports.has(bind.ref)) return true;
    }
    for (const target of namespaces.values()) {
        const exports = linked.exportMaps.get(target);
        if (exports === undefined) continue;
        for (const bind of exports.values()) if (bind.kind === 'found' && linked.constExports.has(bind.ref)) return true;
    }
    return false;
}

/** Every read in `mod` that prints as a constant, in the finalizer's order of decision. */
function moduleConstInlines(mod: Module, linked: Linked, namespaces: Map<number, number>): Map<Node, ConstantValue> {
    const out = new Map<Node, ConstantValue>();
    const rootScope = scopeOf(mod.semantic, mod.program);
    const writeTargets = new Set<Node>();
    const markTarget = (node: Node): void => {
        if (node.type === N.StaticMemberExpression || node.type === N.IdentifierReference) {
            writeTargets.add(node);
            return;
        }
        if (node.type === N.ComputedMemberExpression) return;
        walkChildren(node, markTarget);
    };
    const decide = (node: Node, value: ConstantValue | null, smart: boolean): void => {
        if (value !== null && (smart || isSafeToInline(value))) out.set(node, value);
    };
    // Explicit stack: the AST can nest deeper than the call stack allows.
    const stack: Node[] = [mod.program];
    const smartStack: boolean[] = [false];
    const push = (node: Node, smart: boolean): void => {
        stack.push(node);
        smartStack.push(smart);
    };
    let childrenSmart = false;
    const pushChild = (child: Node): void => {
        stack.push(child);
        smartStack.push(childrenSmart);
    };
    while (stack.length > 0) {
        const node = stack.pop() as Node;
        const smart = smartStack.pop() as boolean;
        switch (node.type) {
            case N.ImportDeclaration:
                continue;
            case N.ExportNamedDeclaration: {
                const declaration = node.data.declaration as Node | null;
                if (declaration !== null) push(declaration, smart);
                continue;
            }
            case N.AssignmentExpression:
                markTarget(node.data.left);
                break;
            case N.UpdateExpression:
                markTarget(node.data.argument);
                break;
            case N.ForInStatement:
            case N.ForOfStatement:
                markTarget(node.data.left);
                break;
            case N.IdentifierReference:
                if (!writeTargets.has(node)) decide(node, constantRead(mod, linked, rootScope, node), smart);
                continue;
            case N.StaticMemberExpression:
                if (!writeTargets.has(node) && node.data.optional !== true) {
                    const value = constantMemberRead(linked, namespaces, node);
                    if (value !== null) {
                        decide(node, value, smart);
                        continue;
                    }
                }
                break;
            case N.IfStatement:
            case N.ConditionalExpression:
                push(node.data.test, true);
                push(node.data.consequent, smart);
                if (node.data.alternate !== null) push(node.data.alternate, smart);
                continue;
            case N.LogicalExpression:
                push(node.data.left, true);
                push(node.data.right, true);
                continue;
        }
        childrenSmart = smart;
        walkChildren(node, pushChild);
    }
    return out;
}

/**
 * Collect every module's constants into `linked.constExports`, then decide each read. Runs after link
 * (imports resolve through `linked.binds`) and before treeshake, which must see the same decisions the
 * emitter prints.
 */
export function computeConstInlines(graph: Graph, linked: Linked): void {
    linked.constExports = new Map();
    linked.constInlines = new Map();
    for (const mod of graph.modules) if (!mod.external) collectModuleConstants(mod, linked, linked.constExports);
    if (linked.constExports.size === 0) return;
    const exportingModules = new Set<number>();
    for (const ref of linked.constExports.keys()) exportingModules.add(refMod(ref));
    for (const mod of graph.modules) {
        if (mod.external) continue;
        const namespaces = namespaceLocals(mod, linked);
        if (!mayReadConstant(mod, linked, exportingModules, namespaces)) continue;
        const inlines = moduleConstInlines(mod, linked, namespaces);
        if (inlines.size > 0) linked.constInlines.set(mod.idx, inlines);
    }
}

/** The value of `ref` when it is a constant every read prints as, whatever the read's position. */
export function safeConstantOf(linked: Linked, ref: number): ConstantValue | undefined {
    const value = linked.constExports.get(ref);
    return value !== undefined && isSafeToInline(value) ? value : undefined;
}
