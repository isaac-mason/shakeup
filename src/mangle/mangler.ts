// Port of `oxc_mangler/src/lib.rs`.
//
// oxc reads `Scoping`, `AstNodes` and the class table from a `SemanticBuilder` built with nodes and the class
// table. shakeup's `Semantic` has the scope tree, the symbols and, when created with `createSemantic(true)`,
// each reference's scope (`refPairs`); the rest oxc reads off nodes (declaration scopes, direct `eval`, the
// class table) comes from one walk of the program, `collectScopingFacts`.
import { analyze, createSemantic, type Semantic, SYM, scopeOf } from '../analysis/semantic.ts';
import { descendChildren, N, type Node, walkChildren } from '../ast/index.ts';
import { sortUnstableBy } from '../util/rust-sort-unstable.ts';
import { base54 } from './base54.ts';
import { collectNameSymbols, keepNamesAllFalse, type MangleOptionsKeepNames } from './keep-names.ts';

export type MangleOptions = {
    /** Mangle names declared in the top level scope. Null: true for a module (oxc also says true for CommonJS,
     *  which shakeup never parses as). */
    topLevel: boolean | null;
    /** Keep function / class names. */
    keepNames: MangleOptionsKeepNames;
    /** Names that bindings must not be renamed to, and that bindings already carrying them keep. */
    reserved: ReadonlySet<string>;
    /** Use `slot_0`, `slot_1`, ... instead of base54 names. */
    debug: boolean;
};

export const defaultMangleOptions = (): MangleOptions => ({
    topLevel: null,
    keepNames: keepNamesAllFalse(),
    reserved: new Set(),
    debug: false,
});

function topLevelOf(options: MangleOptions, isModule: boolean): boolean {
    return options.topLevel ?? isModule;
}

type Slot = number;

/** Symbols the main assignment pass skipped. */
const SLOT_UNASSIGNED: Slot = -1;

export type ManglerReturn = {
    /** The new name of every renamed symbol, by symbol id; the printer reads it through `nameOf`. oxc writes
     *  these into `Scoping`. */
    names: Map<number, string>;
    /** One map per class, in the order the class bodies appear: private member name (without `#`) to its
     *  mangled name. */
    classPrivateMappings: Map<string, string>[];
};

/** Mangle `program` over a fresh semantic, as oxc's `Mangler::build` does. `isModule` is the source type. */
export function build(options: MangleOptions, program: Node, isModule: boolean): ManglerReturn {
    const semantic = createSemantic(true);
    analyze(semantic, program, isModule);
    return buildWithSemantic(options, semantic, program);
}

/** `semantic` must be built from `program` as it is now, with `createSemantic(true)`. Its `isModule` is the
 *  source type. */
export function buildWithSemantic(options: MangleOptions, semantic: Semantic, program: Node): ManglerReturn {
    if (semantic.refPairs === null) throw new Error('the mangler needs a semantic built with createSemantic(true)');
    const facts = collectScopingFacts(semantic, program);
    const classPrivateMappings = collectPrivateMembersFromSemantic(facts.classes);
    const names = buildWithSemanticImpl(options, semantic, facts, program, options.debug ? debugName : base54);
    return { names, classPrivateMappings };
}

/** The five stages: collect constraints, assign slots, rank slots by reference count, generate that many
 *  names, give each slot its name. */
function buildWithSemanticImpl(
    options: MangleOptions,
    semantic: Semantic,
    facts: ScopingFacts,
    program: Node,
    generateName: (n: number) => string,
): Map<number, string> {
    const constraints = collectConstraints(semantic, program, options);
    const slots = computeSlotAssignment(semantic, facts, constraints);
    const ranking = tallySlotRanking(semantic, facts, constraints, slots);
    const names = generateNameTable(semantic, facts, constraints, ranking, slots, generateName);
    return applyNameTable(names, ranking);
}

type ClassTable = {
    /** Enclosing class per class id, -1 for none. */
    parentIds: number[];
    /** Per class id, its elements in order. */
    elements: ClassElement[][];
};

/** oxc's class `Element`, reduced to what the mangler reads. Only private elements are recorded: a public one
 *  has no effect on any result here. */
type ClassElement = { name: string; isPrivate: boolean };

/** Returns one map per class, in declaration order. */
export function collectPrivateMembersFromSemantic(classes: ClassTable): Map<string, string>[] {
    const privateMemberCount = classes.elements.map(
        (classElements) => classElements.filter((element) => element.isPrivate).length,
    );
    const parentPrivateMemberCount = classes.parentIds.map((_, classId) => {
        let sum = 0;
        for (let id = classes.parentIds[classId]; id !== -1; id = classes.parentIds[id]) sum += privateMemberCount[id];
        return sum;
    });
    return classes.elements.map((classElements, classId) => {
        const mappings = new Map<string, string>();
        let i = 0;
        for (const element of classElements) {
            if (!element.isPrivate) continue;
            // Parent classes' names are not reused: nesting a class in a class is rare, and reusing names the
            // child does not see would need liveness analysis.
            mappings.set(element.name, base54(parentPrivateMemberCount[classId] + i));
            i++;
        }
        return mappings;
    });
}

function isSpecialName(name: string): boolean {
    return name === 'arguments';
}

type SlotFrequency = { slot: Slot; frequency: number; symbolIds: number[] };

/** Phase 1 output: names and symbols mangling must not rename or shadow. */
type Constraints = {
    topLevel: boolean;
    reserved: ReadonlySet<string>;
    /** Names of top-level exports, kept when `topLevel` so importers still resolve. */
    exportedNames: Set<string>;
    exportedSymbols: Uint8Array | null;
    /** Names preserved by the `keepNames` option. */
    keepNameNames: Set<string>;
    keepNameSymbols: Uint8Array | null;
};

/** Phase 2 output: each symbol's slot, plus the names a direct `eval` can see. */
type SlotAssignment = {
    slots: Int32Array;
    totalSlots: number;
    evalReservedNames: Set<string>;
};

/** Phase 3 output: slots ranked by reference count, hottest first. */
type SlotRanking = { frequencies: SlotFrequency[] };

/** Phase 4 output: the names to hand out, shortest first. */
type NameTable = { names: string[] };

function collectConstraints(semantic: Semantic, program: Node, options: MangleOptions): Constraints {
    const topLevel = topLevelOf(options, semantic.isModule);
    const { exportedNames, exportedSymbols } =
        topLevel && semantic.isModule
            ? collectExportedSymbols(program, semantic.symbols.length)
            : { exportedNames: new Set<string>(), exportedSymbols: null };
    const { keepNameNames, keepNameSymbols } = collectKeepNameSymbols(options.keepNames, semantic, program);
    return { topLevel, reserved: options.reserved, exportedNames, exportedSymbols, keepNameNames, keepNameSymbols };
}

/** Whether a binding with this name must keep it. */
function isKeptName(constraints: Constraints, name: string): boolean {
    return isSpecialName(name) || (constraints.reserved.size > 0 && constraints.reserved.has(name));
}

/**
 * Phase 2: give every manglable binding a slot, reusing a slot across scopes whose live ranges do not overlap.
 * Scopes are walked top-down; each scope's bindings take the slots not live in it, and fresh slots only when
 * none are free. `slotLiveness[slot]` holds the scopes a slot passes through live.
 */
function computeSlotAssignment(semantic: Semantic, facts: ScopingFacts, constraints: Constraints): SlotAssignment {
    const keepNameSymbols = constraints.keepNameSymbols;
    const evalReservedNames = new Set<string>();
    const scopesLen = semantic.scopes.length;
    const symbolsLen = semantic.symbols.length;
    const words = (scopesLen + 31) >>> 5;

    const slots = new Int32Array(symbolsLen).fill(SLOT_UNASSIGNED);
    const slotLiveness: Uint32Array[] = [];
    const tmpBindings: number[] = [];
    const reusableSlots: number[] = [];
    const ancestorSet = new Uint32Array(words);
    const ancestors: number[] = [];

    for (let scopeId = 1; scopeId < scopesLen; scopeId++) {
        const bindings = facts.bindings[scopeId];
        if (bindings.length === 0) continue;
        // Bindings a direct `eval` can reach keep their names, and nothing may shadow them.
        if (facts.directEval[scopeId] === 1) {
            for (const symbolId of bindings) evalReservedNames.add(symbolNameOf(semantic, symbolId));
            continue;
        }

        tmpBindings.length = 0;
        for (const symbolId of bindings)
            if (keepNameSymbols === null || keepNameSymbols[symbolId] === 0) tmpBindings.push(symbolId);
        if (tmpBindings.length === 0) continue;
        // Declaration order: `bindings` is in symbol id order already.
        orderShadowedFunctionExpressionName(semantic, facts, scopeId, tmpBindings);

        let slot = slotLiveness.length;

        reusableSlots.length = 0;
        for (let s = 0; s < slotLiveness.length && reusableSlots.length < tmpBindings.length; s++) {
            if (!hasBit(slotLiveness[s], scopeId)) reusableSlots.push(s);
        }

        const remainingCount = tmpBindings.length - reusableSlots.length;
        for (let s = slot; s < slot + remainingCount; s++) reusableSlots.push(s);

        slot += remainingCount;
        while (slotLiveness.length < slot) slotLiveness.push(new Uint32Array(words));

        ancestors.length = 0;
        for (
            let ancestorId = semantic.scopes[scopeId].parent;
            ancestorId !== 0;
            ancestorId = semantic.scopes[ancestorId].parent
        ) {
            ancestors.push(ancestorId);
            setBit(ancestorSet, ancestorId);
        }

        for (let i = 0; i < tmpBindings.length; i++) {
            const symbolId = tmpBindings[i];
            const assignedSlot = reusableSlots[i];
            slots[symbolId] = assignedSlot;

            // The scopes this symbol is alive in: from each use, walk up to (not including) `scopeId`.
            const slotLivenessBitset = slotLiveness[assignedSlot];
            const markUsedScope = (usedScopeId: number): void => {
                for (let ancestorId = usedScopeId; ancestorId !== 0; ancestorId = semantic.scopes[ancestorId].parent) {
                    if (ancestorId === scopeId || hasBit(ancestorSet, ancestorId)) break;
                    if (hasBit(slotLivenessBitset, ancestorId)) break;
                    setBit(slotLivenessBitset, ancestorId);
                }
            };
            const referencePairs = (semantic.refPairs as number[][])[symbolId];
            if (referencePairs !== undefined) for (let k = 1; k < referencePairs.length; k += 2) markUsedScope(referencePairs[k]);
            // `var` is hoisted, so the scopes where it is declared count too (`function f() { { var x; let y; } }`).
            for (const declaredScopeId of facts.declarationScopes[symbolId]) markUsedScope(declaredScopeId);
            markUsedScope(scopeId);
        }

        for (const ancestorId of ancestors) clearBit(ancestorSet, ancestorId);
        // oxc repairs a named function expression whose name a body declaration shadows here: the shadower
        // takes over the binding and orphans the name's symbol. shakeup's semantic binds both to one symbol
        // (`declare` returns the existing symbol), which is already the repaired outcome.
    }

    return { slots, totalSlots: slotLiveness.length, evalReservedNames };
}

/**
 * oxc gives a body declaration that shadows a named function expression's name (`var foo`, a parameter `foo`)
 * a symbol of its own, declared where it appears, and the name's own symbol drops out of the scope's
 * bindings. shakeup has one symbol for both, with the name's id, so it would sort first. Move it to where
 * oxc's shadowing symbol sorts: among the scope's bindings, by declaration order.
 */
function orderShadowedFunctionExpressionName(
    semantic: Semantic,
    facts: ScopingFacts,
    scopeId: number,
    tmpBindings: number[],
): void {
    const owner = semantic.scopes[scopeId].node;
    if (owner === null || owner.type !== N.FunctionExpression) return;
    const id = owner.data.id;
    if (id === null || id.sym <= 0) return;
    const index = tmpBindings.indexOf(id.sym);
    if (index === -1) return;
    const shadowingOrder = facts.shadowingDeclarationOrder[id.sym];
    if (shadowingOrder === -1) return;
    tmpBindings.splice(index, 1);
    let at = 0;
    while (at < tmpBindings.length && facts.declarationOrder[tmpBindings[at]] < shadowingOrder) at++;
    tmpBindings.splice(at, 0, id.sym);
}

/** Phase 3: count references per slot and sort hottest first, skipping symbols that are kept, exported (at the
 *  top level), visible to `eval`, or special (`arguments`). */
function tallySlotRanking(semantic: Semantic, facts: ScopingFacts, constraints: Constraints, slots: SlotAssignment): SlotRanking {
    const exportedSymbols = constraints.exportedSymbols;
    const keepNameSymbols = constraints.keepNameSymbols;
    const rootScopeId = facts.rootScopeId;
    const referencePairs = semantic.refPairs as number[][];
    const frequencies: SlotFrequency[] = [];
    for (let slot = 0; slot < slots.totalSlots; slot++) frequencies.push({ slot: 0, frequency: 0, symbolIds: [] });

    for (let symbolId = 0; symbolId < slots.slots.length; symbolId++) {
        const slot = slots.slots[symbolId];
        if (slot === SLOT_UNASSIGNED) continue;
        const symbolScopeId = semantic.symbols[symbolId].scope;
        if (
            symbolScopeId === rootScopeId &&
            (!constraints.topLevel || (exportedSymbols !== null && exportedSymbols[symbolId] === 1))
        )
            continue;
        if (facts.directEval[symbolScopeId] === 1) continue;
        if (isKeptName(constraints, symbolNameOf(semantic, symbolId))) continue;
        if (keepNameSymbols !== null && keepNameSymbols[symbolId] === 1) continue;
        const frequency = frequencies[slot];
        frequency.slot = slot;
        frequency.frequency += (referencePairs[symbolId]?.length ?? 0) / 2;
        frequency.symbolIds.push(symbolId);
    }

    const retained = frequencies.filter((x) => x.symbolIds.length > 0);
    // `sort_unstable_by_key(|x| Reverse(x.frequency))`: tied slots land where Rust's unstable sort puts them.
    // 32 is the small-sort threshold of a 40-byte `Freeze` element.
    sortUnstableBy(retained, (a, b) => a.frequency > b.frequency, 32);
    return { frequencies: retained };
}

/** Phase 4: one name per slot, shortest first. The i-th name is the i-th shortest candidate that is not a
 *  keyword, a global the program references, a kept or `eval`-visible name, or, at the top level, taken. */
function generateNameTable(
    semantic: Semantic,
    facts: ScopingFacts,
    constraints: Constraints,
    ranking: SlotRanking,
    slots: SlotAssignment,
    generateName: (n: number) => string,
): NameTable {
    const rootUnresolvedReferences = new Set<string>();
    for (const node of semantic.unresolved) rootUnresolvedReferences.add(node.name);
    const rootBindings = new Set<string>();
    for (const symbolId of facts.bindings[facts.rootScopeId]) rootBindings.add(symbolNameOf(semantic, symbolId));
    const isReserved = (name: string): boolean =>
        RESERVED_KEYWORDS.has(name) ||
        isKeptName(constraints, name) ||
        rootUnresolvedReferences.has(name) ||
        (rootBindings.has(name) && (!constraints.topLevel || constraints.exportedNames.has(name))) ||
        constraints.keepNameNames.has(name) ||
        slots.evalReservedNames.has(name);

    const count = ranking.frequencies.length;
    const names: string[] = [];
    let candidate = 0;
    for (let i = 0; i < count; i++) {
        let name = generateName(candidate++);
        while (isReserved(name)) name = generateName(candidate++);
        names.push(name);
    }
    return { names };
}

/**
 * Phase 5: give each slot its name. Names are bucketed by length; each bucket goes to the next hottest slots,
 * handed out in slot order (declaration order) so neighbours get similar names, which gzip compresses better.
 */
function applyNameTable(nameTable: NameTable, ranking: SlotRanking): Map<number, string> {
    const out = new Map<number, string>();
    const names = nameTable.names;
    let frequencyIndex = 0;
    let groupStart = 0;
    while (groupStart < names.length) {
        let groupEnd = groupStart + 1;
        while (groupEnd < names.length && names[groupEnd].length === names[groupStart].length) groupEnd++;
        const symbolsRenamedInThisBatch = ranking.frequencies.slice(frequencyIndex, frequencyIndex + groupEnd - groupStart);
        frequencyIndex += symbolsRenamedInThisBatch.length;
        sortBatchBySlot(symbolsRenamedInThisBatch);
        for (let i = 0; i < symbolsRenamedInThisBatch.length; i++) {
            const newName = names[groupStart + i];
            for (const symbolId of symbolsRenamedInThisBatch[i].symbolIds) out.set(symbolId, newName);
        }
        groupStart = groupEnd;
    }
    return out;
}

/** Source order: slots are numbered in declaration order, and no two in a batch share one. */
function sortBatchBySlot(symbols: SlotFrequency[]): void {
    symbols.sort((a, b) => a.slot - b.slot);
}

function collectExportedSymbols(program: Node, symbolsLen: number): { exportedNames: Set<string>; exportedSymbols: Uint8Array } {
    const exportedSymbols = new Uint8Array(symbolsLen);
    const exportedNames = new Set<string>();
    const add = (id: Node): void => {
        exportedNames.add(id.name);
        if (id.sym > 0) exportedSymbols[id.sym] = 1;
    };
    for (const statement of (program.data as { body: Node[] }).body) {
        if (statement.type !== N.ExportNamedDeclaration) continue;
        const decl = statement.data.declaration;
        if (decl === null) continue;
        if (decl.type === N.VariableDeclaration) {
            // Every bound name, not just a plain identifier: `export const { find } = x` exports `find`.
            for (const declarator of decl.data.declarations) {
                if (declarator.type === N.VariableDeclarator) forEachBoundName(declarator.data.id, add);
            }
        } else {
            const id = declarationId(decl);
            if (id !== null) add(id);
        }
    }
    return { exportedNames, exportedSymbols };
}

/** oxc `Declaration::id`. */
function declarationId(decl: Node): Node | null {
    switch (decl.type) {
        case N.FunctionDeclaration:
        case N.ClassDeclaration:
            return decl.data.id;
        case N.TSEnumDeclaration:
            return decl.data.id;
        case N.TSModuleDeclaration:
            return decl.data.id.type === N.BindingIdentifier ? decl.data.id : null;
        default:
            return null;
    }
}

/** oxc `BoundNames` over a binding pattern. */
function forEachBoundName(pattern: Node | null, cb: (id: Node) => void): void {
    if (pattern === null) return;
    switch (pattern.type) {
        case N.BindingIdentifier:
            cb(pattern);
            return;
        case N.ObjectPattern:
            for (const property of pattern.data.properties) forEachBoundName(property, cb);
            return;
        case N.ObjectProperty:
            forEachBoundName(pattern.data.value, cb);
            return;
        case N.ArrayPattern:
            for (const element of pattern.data.elements) forEachBoundName(element, cb);
            return;
        case N.AssignmentPattern:
            forEachBoundName(pattern.data.left, cb);
            return;
        case N.RestElement:
            forEachBoundName(pattern.data.argument, cb);
            return;
    }
}

function collectKeepNameSymbols(
    keepNames: MangleOptionsKeepNames,
    semantic: Semantic,
    program: Node,
): { keepNameNames: Set<string>; keepNameSymbols: Uint8Array | null } {
    if (!keepNames.function && !keepNames.class) return { keepNameNames: new Set(), keepNameSymbols: null };
    const ids = collectNameSymbols(keepNames, semantic, program);
    const keepNameNames = new Set<string>();
    for (let symbolId = 0; symbolId < ids.length; symbolId++)
        if (ids[symbolId] === 1) keepNameNames.add(symbolNameOf(semantic, symbolId));
    return { keepNameNames, keepNameSymbols: ids };
}

function debugName(n: number): string {
    return `slot_${n}`;
}

/** oxc_syntax `RESERVED_KEYWORDS`: keywords, future reserved words and the contextually disallowed ones. */
const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
    'let',
    'static',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'new',
    'null',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
]);

const symbolNameOf = (semantic: Semantic, symbolId: number): string => semantic.symbols[symbolId].decl?.name ?? '';

const hasBit = (bits: Uint32Array, index: number): boolean => (bits[index >>> 5] & (1 << (index & 31))) !== 0;
const setBit = (bits: Uint32Array, index: number): void => {
    bits[index >>> 5] |= 1 << (index & 31);
};
const clearBit = (bits: Uint32Array, index: number): void => {
    bits[index >>> 5] &= ~(1 << (index & 31));
};

// ---------------------------------------------------------------------------------------------------------
// What oxc reads off `AstNodes` and the class table.

type ScopingFacts = {
    rootScopeId: number;
    /** Per scope, the symbols it owns in id order: oxc's `iter_bindings`. */
    bindings: number[][];
    /** Per scope, 1 when it or a descendant calls `eval` directly: oxc's `ScopeFlags::DirectEval`. */
    directEval: Uint8Array;
    /** Per symbol, the scope of each of its declaration nodes: oxc's `symbol_declaration` and
     *  `symbol_redeclarations`, read through `AstNode::scope_id`. */
    declarationScopes: number[][];
    /** Per symbol, the walk order of its first declaration. */
    declarationOrder: Int32Array;
    /** Per named function expression's symbol, the walk order of the body declaration that shadows the name;
     *  -1 when none does. */
    shadowingDeclarationOrder: Int32Array;
    classes: ClassTable;
};

type FactsWalk = {
    semantic: Semantic;
    facts: ScopingFacts;
    nextDeclarationOrder: number;
    /** oxc `ClassTableBuilder::current_class_id`, -1 for none. */
    currentClassId: number;
    /** The scope the node being visited sits in: oxc's `AstNode::scope_id`. */
    scope: number;
};

function collectScopingFacts(semantic: Semantic, program: Node): ScopingFacts {
    const scopesLen = semantic.scopes.length;
    const symbolsLen = semantic.symbols.length;
    const rootScopeId = scopeOf(semantic, program);
    const bindings: number[][] = [];
    for (let scopeId = 0; scopeId < scopesLen; scopeId++) bindings.push([]);
    const declarationScopes: number[][] = [];
    for (let symbolId = 0; symbolId < symbolsLen; symbolId++) {
        declarationScopes.push([]);
        const symbol = semantic.symbols[symbolId];
        if (symbol.decl === null || symbol.scope === 0) continue;
        bindings[symbol.scope].push(symbolId);
    }
    const facts: ScopingFacts = {
        rootScopeId,
        bindings,
        directEval: new Uint8Array(scopesLen),
        declarationScopes,
        declarationOrder: new Int32Array(symbolsLen).fill(-1),
        shadowingDeclarationOrder: new Int32Array(symbolsLen).fill(-1),
        classes: { parentIds: [], elements: [] },
    };
    visitFacts({ semantic, facts, nextDeclarationOrder: 0, currentClassId: -1, scope: 0 }, program);
    return facts;
}

/** The scope `node` opens, or 0. Checked against the scope table, since a node keeps a `scopeId` from an older
 *  analysis when this one gave it none (a function body block). */
function ownScopeOf(semantic: Semantic, node: Node): number {
    const scopeId = scopeOf(semantic, node);
    return scopeId !== 0 && semantic.scopes[scopeId]?.node === node ? scopeId : 0;
}

/** Records `node`'s facts and descends, with `walk.scope` the scope `node` sits in; leaves `walk.scope` as found. */
function visitFacts(walk: FactsWalk, node: Node): void {
    const scope = walk.scope;
    const ownScope = ownScopeOf(walk.semantic, node);
    const inner = ownScope !== 0 ? ownScope : scope;
    switch (node.type) {
        case N.BindingIdentifier:
            recordDeclaration(walk, node, scope);
            return;
        case N.CallExpression: {
            // oxc `visit_call_expression`: `eval(...)`, whatever `eval` resolves to.
            const callee = node.data.callee;
            if (!node.data.optional && callee.type === N.IdentifierReference && callee.name === 'eval')
                markDirectEval(walk, scope);
            break;
        }
        case N.FunctionDeclaration:
        case N.FunctionExpression:
            visitFunctionFacts(walk, node, scope, inner);
            return;
        case N.ClassDeclaration:
        case N.ClassExpression:
            visitClassFacts(walk, node, scope, inner);
            return;
        case N.SwitchStatement:
            // The discriminant is evaluated outside the switch's scope.
            visitFacts(walk, node.data.discriminant);
            walk.scope = inner;
            for (const switchCase of node.data.cases) visitFacts(walk, switchCase);
            walk.scope = scope;
            return;
    }
    walk.scope = inner;
    descendChildren(walk, node, visitFacts);
    walk.scope = scope;
}

/** A function's declaration node is the function, which sits outside the scope it opens. */
function visitFunctionFacts(walk: FactsWalk, node: Node, scope: number, inner: number): void {
    walk.scope = inner;
    walkChildren(node, (child, field) => {
        if (field === 'id') recordDeclaration(walk, child, scope);
        else visitFacts(walk, child);
    });
    walk.scope = scope;
}

/** oxc declares the class when it enters the body, after the heritage. */
function visitClassFacts(walk: FactsWalk, node: Node, scope: number, inner: number): void {
    let classId = -1;
    const outerClassId = walk.currentClassId;
    walk.scope = inner;
    walkChildren(node, (child, field) => {
        if (field === 'id') {
            recordDeclaration(walk, child, scope);
            return;
        }
        if (field === 'body' && classId === -1) classId = declareClassBody(walk, node);
        visitFacts(walk, child);
    });
    walk.scope = scope;
    if (classId === -1) declareClassBody(walk, node);
    walk.currentClassId = outerClassId;
}

function recordDeclaration(walk: FactsWalk, ident: Node, scope: number): void {
    const symbolId = ident.sym;
    if (symbolId <= 0 || symbolId >= walk.semantic.symbols.length) return;
    const facts = walk.facts;
    facts.declarationScopes[symbolId].push(scope);
    const order = walk.nextDeclarationOrder++;
    if (facts.declarationOrder[symbolId] === -1) facts.declarationOrder[symbolId] = order;
    else if ((walk.semantic.symbols[symbolId].flags & SYM.FN_EXPR_NAME) !== 0 && facts.shadowingDeclarationOrder[symbolId] === -1)
        facts.shadowingDeclarationOrder[symbolId] = order;
}

function markDirectEval(walk: FactsWalk, scope: number): void {
    const semantic = walk.semantic;
    for (let scopeId = scope; scopeId !== 0 && walk.facts.directEval[scopeId] === 0; scopeId = semantic.scopes[scopeId].parent) {
        walk.facts.directEval[scopeId] = 1;
    }
}

/** oxc `ClassTableBuilder::declare_class_body`. Makes the class current; the caller restores the outer one. */
function declareClassBody(walk: FactsWalk, classNode: Node): number {
    const classes = walk.facts.classes;
    const classId = classes.parentIds.length;
    classes.parentIds.push(walk.currentClassId);
    const elements: ClassElement[] = [];
    for (const element of (classNode.data as { body: Node[] }).body) {
        let key: Node;
        if (element.type === N.PropertyDefinition) key = element.data.key;
        else if (element.type === N.MethodDefinition) {
            // a constructor, or a TypeScript overload with no body
            if (element.data.kind === 'constructor' || (element.data.value.data as { body: Node | null }).body === null) continue;
            key = element.data.key;
        } else continue;
        if (key.type !== N.PrivateIdentifier) continue;
        elements.push({ name: key.name[0] === '#' ? key.name.slice(1) : key.name, isPrivate: true });
    }
    classes.elements.push(elements);
    walk.currentClassId = classId;
    return classId;
}
