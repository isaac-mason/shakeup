// Port of oxc_minifier/src/peephole/remove_unused_private_members.rs. shakeup has no `ClassBody` node,
// so both functions take the class and read its member list.

import { mayHaveSideEffects } from '../../../analysis/side-effects.ts';
import { type DataOf, N, type Node } from '../../../ast/index.ts';
import { privateMemberIsUsed } from '../state.ts';
import { scopeContainsDirectEval } from '../syntax.ts';
import { currentScopeFlags, type DceCtx, dropClassElement } from '../traverse-context.ts';

/** Remove private fields and methods the traversal saw no use of. */
export function removeUnusedPrivateMembers(ctx: DceCtx, classNode: Node): void {
    if (scopeContainsDirectEval(currentScopeFlags(ctx))) return;

    const body = (classNode.data as DataOf<'ClassExpression'>).body;
    let kept = 0;
    for (const element of body) {
        const keep = keepClassElement(ctx, element);
        // Walk the dropped element so references inside are recorded as removed.
        if (!keep) dropClassElement(ctx, element);
        else body[kept++] = element;
    }
    // An empty list may be the parser's shared frozen one.
    if (kept !== body.length) body.length = kept;
}

function keepClassElement(ctx: DceCtx, element: Node): boolean {
    switch (element.type) {
        case N.PropertyDefinition: {
            // Also oxc's `AccessorProperty`, which keeps by the same rule.
            const { key, value } = element.data as DataOf<'PropertyDefinition'>;
            if (key.type !== N.PrivateIdentifier) return true;
            if (privateMemberIsUsed(ctx.state.privateMemberUsage, key.name)) return true;
            return value !== null && mayHaveSideEffects(value, ctx);
        }
        case N.MethodDefinition: {
            const key = (element.data as DataOf<'MethodDefinition'>).key;
            if (key.type !== N.PrivateIdentifier) return true;
            return privateMemberIsUsed(ctx.state.privateMemberUsage, key.name);
        }
        default:
            return true;
    }
}

/** The `#name`s the class declares. */
export function declaredPrivateMemberNames(classNode: Node): string[] {
    const names: string[] = [];
    for (const element of (classNode.data as DataOf<'ClassExpression'>).body) {
        if (element.type !== N.PropertyDefinition && element.type !== N.MethodDefinition) continue;
        const key = (element.data as { key: Node }).key;
        if (key.type === N.PrivateIdentifier) names.push(key.name);
    }
    return names;
}
