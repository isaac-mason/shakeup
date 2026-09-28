// Port of `oxc_mangler/src/keep_names.rs`.
//
// oxc asks, per symbol, whether its declaration node or any of its references sets a function's or class's
// `name`, reading the nodes and their parents out of `AstNodes`. shakeup's semantic keeps no node table, so
// one walk carrying each node's parent and grandparent asks the same questions at the nodes themselves.
import type { Semantic } from '../analysis/semantic.ts';
import { N, type Node, walkChildren } from '../ast/index.ts';

export type MangleOptionsKeepNames = {
    /** Preserve `name` property for functions. */
    function: boolean;
    /** Preserve `name` property for classes. */
    class: boolean;
};

export const keepNamesAllFalse = (): MangleOptionsKeepNames => ({ function: false, class: false });

export const keepNamesAllTrue = (): MangleOptionsKeepNames => ({ function: true, class: true });

/** oxc `From<bool> for MangleOptionsKeepNames`. */
export const keepNamesFrom = (keepNames: boolean): MangleOptionsKeepNames =>
    keepNames ? keepNamesAllTrue() : keepNamesAllFalse();

type NameSymbolCollector = {
    options: MangleOptionsKeepNames;
    semantic: Semantic;
    /** Indexed by symbol id: 1 when the symbol's name is kept. */
    symbolIds: Uint8Array;
};

/** The symbols used to set `name` properties of functions and classes, as a per-symbol flag array. */
export function collectNameSymbols(options: MangleOptionsKeepNames, semantic: Semantic, program: Node): Uint8Array {
    const collector: NameSymbolCollector = { options, semantic, symbolIds: new Uint8Array(semantic.symbols.length) };
    collect(collector, program, null, null);
    return collector.symbolIds;
}

/** oxc's `collect`, which filters every symbol by `is_name_set_declare_node || has_name_set_reference_node`:
 *  here the declaration test runs at each declaring node for the symbols it declares first, and the
 *  reference test at each resolved reference. */
function collect(collector: NameSymbolCollector, node: Node, parent: Node | null, grandParent: Node | null): void {
    switch (node.type) {
        case N.FunctionDeclaration:
        case N.FunctionExpression:
        case N.ClassDeclaration:
        case N.ClassExpression:
        case N.VariableDeclarator:
            forEachFirstDeclaredSymbol(collector.semantic, node, (symbolId) => {
                if (isNameSetDeclareNode(collector, node, symbolId)) collector.symbolIds[symbolId] = 1;
            });
            break;
        case N.IdentifierReference:
            if (node.sym > 0 && isNameSetReferenceNode(collector, node, parent, grandParent)) collector.symbolIds[node.sym] = 1;
            return;
    }
    walkChildren(node, (child) => {
        collect(collector, child, node, parent);
    });
}

/** Calls `cb` for each symbol whose first declaration (oxc `symbol_declaration`) is `node`. */
function forEachFirstDeclaredSymbol(semantic: Semantic, node: Node, cb: (symbolId: number) => void): void {
    const visit = (ident: Node | null): void => {
        if (ident === null || ident.type !== N.BindingIdentifier || ident.sym <= 0) return;
        if (semantic.symbols[ident.sym]?.decl === ident) cb(ident.sym);
    };
    switch (node.type) {
        case N.FunctionDeclaration:
        case N.FunctionExpression:
        case N.ClassDeclaration:
        case N.ClassExpression:
            visit(node.data.id);
            return;
        case N.VariableDeclarator:
            forEachBoundIdentifier(node.data.id, visit);
            return;
    }
}

function forEachBoundIdentifier(pattern: Node | null, cb: (ident: Node) => void): void {
    if (pattern === null) return;
    switch (pattern.type) {
        case N.BindingIdentifier:
            cb(pattern);
            return;
        case N.ObjectPattern:
            for (const property of pattern.data.properties) forEachBoundIdentifier(property, cb);
            return;
        case N.ObjectProperty:
            forEachBoundIdentifier(pattern.data.value, cb);
            return;
        case N.ArrayPattern:
            for (const element of pattern.data.elements) forEachBoundIdentifier(element, cb);
            return;
        case N.AssignmentPattern:
            forEachBoundIdentifier(pattern.data.left, cb);
            return;
        case N.RestElement:
            forEachBoundIdentifier(pattern.data.argument, cb);
            return;
    }
}

function isNameSetDeclareNode(collector: NameSymbolCollector, node: Node, symbolId: number): boolean {
    switch (node.type) {
        case N.FunctionDeclaration:
        case N.FunctionExpression:
            return collector.options.function && node.data.id !== null && node.data.id.sym === symbolId;
        case N.ClassDeclaration:
        case N.ClassExpression:
            return collector.options.class && node.data.id !== null && node.data.id.sym === symbolId;
        case N.VariableDeclarator: {
            const id = node.data.id;
            if (id.type === N.BindingIdentifier && id.sym === symbolId) {
                const init = node.data.init;
                return init !== null && isExpressionWhoseNameNeedsToBeKept(collector, init);
            }
            const assignPattern = findAssignBindingPatternKindOfSpecificSymbol(id, symbolId);
            if (assignPattern !== null)
                return isExpressionWhoseNameNeedsToBeKept(collector, (assignPattern.data as { right: Node }).right);
            return false;
        }
        default:
            return false;
    }
}

/**
 * oxc matches the reference's parent kind. Its `AssignmentTargetWithDefault` (`[foo = f] = []`) and
 * `AssignmentTargetPropertyIdentifier` (`({ foo = f } = {})`) are both an `AssignmentPattern` whose `left` is
 * the reference here, and that is the only way a reference is an `AssignmentPattern`'s left.
 */
function isNameSetReferenceNode(
    collector: NameSymbolCollector,
    node: Node,
    parent: Node | null,
    grandParent: Node | null,
): boolean {
    if (parent === null) return false;
    switch (parent.type) {
        case N.AssignmentExpression:
        case N.AssignmentPattern:
            return (
                isAssignmentTargetIdOfSpecificReference(parent.data.left as Node, node) &&
                isExpressionWhoseNameNeedsToBeKept(collector, parent.data.right as Node)
            );
        case N.TSAsExpression:
        case N.TSSatisfiesExpression:
        case N.TSNonNullExpression:
        case N.ComputedMemberExpression:
        case N.PrivateFieldExpression:
        case N.StaticMemberExpression:
            if (grandParent === null) return false;
            switch (grandParent.type) {
                case N.AssignmentExpression:
                case N.AssignmentPattern:
                    return (
                        isAssignmentTargetIdOfSpecificReference(grandParent.data.left as Node, node) &&
                        isExpressionWhoseNameNeedsToBeKept(collector, grandParent.data.right as Node)
                    );
                default:
                    return false;
            }
        default:
            return false;
    }
}

function findAssignBindingPatternKindOfSpecificSymbol(kind: Node, symbolId: number): Node | null {
    switch (kind.type) {
        case N.ObjectPattern:
            for (const property of kind.data.properties) {
                // oxc's `ObjectPattern.rest` is not one of its `properties`
                if (property.type !== N.ObjectProperty) continue;
                const value = findAssignBindingPatternKindOfSpecificSymbol(property.data.value, symbolId);
                if (value !== null) return value;
            }
            return null;
        case N.ArrayPattern:
            for (const element of kind.data.elements) {
                // nor is `ArrayPattern.rest` one of its `elements`
                if (element === null || element.type === N.RestElement) continue;
                const value = findAssignBindingPatternKindOfSpecificSymbol(element, symbolId);
                if (value !== null) return value;
            }
            return null;
        case N.AssignmentPattern:
            if (isBindingIdOfSpecificSymbol(kind.data.left, symbolId)) return kind;
            return findAssignBindingPatternKindOfSpecificSymbol(kind.data.left, symbolId);
        default:
            return null;
    }
}

function isBindingIdOfSpecificSymbol(patternKind: Node, symbolId: number): boolean {
    return patternKind.type === N.BindingIdentifier && patternKind.sym === symbolId;
}

function isAssignmentTargetIdOfSpecificReference(targetKind: Node, reference: Node): boolean {
    return targetKind.type === N.IdentifierReference && targetKind === reference;
}

function isExpressionWhoseNameNeedsToBeKept(collector: NameSymbolCollector, expr: Node): boolean {
    const isAnonymous =
        expr.type === N.ArrowFunctionExpression ||
        ((expr.type === N.FunctionExpression || expr.type === N.ClassExpression) && expr.data.id === null);
    if (!isAnonymous) return false;
    if (collector.options.class && collector.options.function) return true;
    const isClass = expr.type === N.ClassExpression;
    return (collector.options.class && isClass) || (collector.options.function && !isClass);
}
