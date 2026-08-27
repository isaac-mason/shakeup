import { describe, expect, it } from 'vitest';
import { N, type Node, node } from '../src/ast.ts';
import * as create from '../src/parser/create.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';
import { wrapModuleBody } from '../src/passes/wrap-module.ts';

// The shape is pinned by PRINTING it, not by poking at fields: what matters is the emitted wrapper,
// and a field assertion would pass while the printer disagreed.
const print = (stmt: Node, minify = false): string => {
    const program = node(N.Program, 0, 0, '', { body: [stmt], hashbang: null, sourceType: 'module', scopeId: 0 } as never);
    const p = createPrinter({ minify }, {});
    printModule(p, program);
    return finishPrinter(p).trim();
};
const stmt = (text: string): Node =>
    create.ExpressionStatement(0, 0, 0, create.CallExpression(0, 0, 0, node(N.IdentifierReference, 0, 0, text, null), [], null));

describe('wrapModuleBody builds the wrapper as AST', () => {
    it('emits `var name = /*@__PURE__*/ helper((exports, module) => { … })`', () => {
        const out = print(wrapModuleBody({ name: 'require_a', helper: '__commonJS', params: ['exports', 'module'], body: [stmt('side')], pure: true }));
        expect(out).toContain('var require_a =');
        expect(out).toContain('__commonJS(');
        expect(out).toContain('(exports, module) =>');
        expect(out).toContain('side()');
        expect(out).toContain('__PURE__');
    });

    it('emits NO parameter list when the module references neither binding', () => {
        // rolldown pushes `exports` only for `ModuleOrExports` and `module` only for `ModuleRef`
        // (`ast_factory.rs:759-786`), so a module touching neither gets `()` — not `(exports)`.
        const out = print(wrapModuleBody({ name: 'require_a', helper: '__commonJS', params: [], body: [], pure: true }));
        expect(out).toMatch(/__commonJS\(\(\)\s*=>/);
        expect(out).not.toContain('exports');
    });

    it('omits the pure annotation when asked', () => {
        // rolldown marks `__commonJS` pure but NOT `__esm` — `new_with_pure` vs `new`.
        const out = print(wrapModuleBody({ name: 'init_a', helper: '__esm', params: [], body: [stmt('go')], pure: false }));
        expect(out).toContain('__esm(');
        expect(out).not.toContain('__PURE__');
    });

    it('keeps the body statements, in order, inside the closure', () => {
        const out = print(wrapModuleBody({ name: 'w', helper: '__commonJS', params: ['exports'], body: [stmt('first'), stmt('second')], pure: true }));
        expect(out.indexOf('first()')).toBeLessThan(out.indexOf('second()'));
        // Inside the closure, not beside it.
        expect(out.indexOf('=>')).toBeLessThan(out.indexOf('first()'));
    });

    it('round-trips through the minified printer', () => {
        const out = print(wrapModuleBody({ name: 'w', helper: '__commonJS', params: ['exports'], body: [stmt('x')], pure: true }), true);
        expect(out).toMatch(/var w=.*__commonJS\(exports=>\{x\(\)\}\)/);
    });
});
