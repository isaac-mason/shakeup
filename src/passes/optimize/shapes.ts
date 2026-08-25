// Type-shape oracle for SROA — reads the STRUCTURE of a written type annotation.
//
// SROA normally takes its shape from a literal initialiser (`const v = [a, b]`). When the initialiser
// is opaque (`const v: Vec3 = mk()`) the shape has to come from the TYPE instead, which is what this
// provides: `Vec3` → `['x', 'y']`.
//
// WHY IT RUNS EARLY: shakeup erases type annotations in `tsStrip`, during scan and BEFORE any
// optimizer pass. So shapes are captured on the still-typed AST and handed to SROA as a side table
// keyed by source offset.
//
// SCOPE — IN-FILE TYPES ONLY. An inline type literal, a tuple type, or a `type`/`interface` declared
// in the SAME module. A type imported from a library's `.d.ts` is NOT resolvable: shakeup's resolver
// probes `.tsx/.ts/.jsx/.js/.json` and never loads declaration files, because a bundler's module graph
// is a graph of things that emit runtime code. Supporting those needs a type-source resolver and a
// type-only module kind — tracked separately in the roadmap.
//
// It models only the structure of WRITTEN annotations — no inference, no narrowing, no conditional or
// mapped types. Anything unmodelled returns `null`, and `null` is always safe: SROA simply does not fire.
import { N, type Node } from '../../ast.ts';
import { hookTable, type Visitor } from '../traverse.ts';

/** Declaration start offset → the aggregate's field names, in order. */
export type ShapeTable = Map<number, string[]>;

/** Field names of a property-signature list, or `null` if any member is not a plain required field. */
function membersToFields(members: readonly Node[]): string[] | null {
    const out: string[] = [];
    for (const m of members) {
        if (m.type !== N.TSPropertySignature) return null; // index signature, call signature, method
        const d = m.data as { key: Node; computed: boolean; optional: boolean; readonly?: boolean };
        if (d.computed || d.optional) return null; // an optional field may be absent — shape unknown
        const key = d.key.type === N.IdentifierName || d.key.type === N.StringLiteral ? d.key.name : null;
        if (key === null || out.includes(key)) return null;
        out.push(key);
    }
    return out.length > 0 ? out : null;
}

/** Field names for a type node, following in-file aliases. `depth` guards a cyclic alias. */
function shapeOf(type: Node, aliases: ReadonlyMap<string, Node>, depth = 0): string[] | null {
    if (depth > 8) return null;
    if (type.type === N.TSTypeLiteral) return membersToFields((type.data as { members: Node[] }).members);
    if (type.type === N.TSTupleType) {
        const els = (type.data as { elementTypes: Node[] }).elementTypes;
        return els.length > 0 ? els.map((_, i) => String(i)) : null;
    }
    if (type.type === N.TSTypeReference) {
        const name = (type.data as { typeName: Node; typeArguments: Node | null }).typeName;
        if (name.type === N.TSQualifiedName) return null; // `NS.Type` — not an in-file alias
        const target = aliases.get(name.name);
        return target === undefined ? null : shapeOf(target, aliases, depth + 1);
    }
    return null;
}

/**
 * Shape capture as a VISITOR, folded into the single TS/JSX lowering traversal.
 *
 * It used to be up to THREE separate `walk()`s of every TS module — `typeAliases`, a
 * `hasInlineAnnotation` probe, and the main scan — 397,700 nodes on a crashcat bundle, 19.6% of the
 * whole walk budget, purely to read annotations the traversal was about to visit anyway.
 *
 * WHY RESOLUTION IS DEFERRED. A `type`/`interface` may be declared AFTER the declaration that
 * references it, so the alias table is only complete once the walk ends. The visitor therefore
 * RECORDS (annotation node, declaration offset) pairs and resolves them afterwards. Resolution is
 * then O(annotated declarations), not another walk.
 *
 * WHY THE RECORDED NODES STAY VALID. `tsStrip` runs in the same traversal and erases annotations —
 * but it erases them by NULLING THE FIELD on the declarator, not by mutating the annotation node, and
 * removes type declarations by dropping the statement. The nodes we hold references to are simply
 * detached, and still readable. The collector is also ordered FIRST in the pass list, so it sees each
 * node before `tsStrip` touches it.
 *
 * Module-level state, reset at Program enter — the same single-threaded-traversal pattern
 * `alias-inline` uses. That keeps the visitor a SHARED CONSTANT, which matters because `traverse`
 * caches its per-node-type hook tables on the visitor array's identity.
 */
let ALIASES: Map<string, Node> | null = null;
let PENDING: { start: number; ann: Node }[] | null = null;

export const shapeCollector: Visitor = {
    name: 'shapeCollector',
    enter: hookTable({
        [N.Program]: () => {
            ALIASES = new Map();
            PENDING = [];
        },
        [N.TSTypeAliasDeclaration]: (n) => {
            const d = n.data as { id: Node; typeAnnotation: Node };
            ALIASES?.set(d.id.name, d.typeAnnotation);
        },
        [N.TSInterfaceDeclaration]: (n) => {
            const d = n.data as { id: Node; body: Node[] };
            // Represent an interface by a synthetic member list; `shapeOf` handles both.
            ALIASES?.set(d.id.name, { ...n, type: N.TSTypeLiteral, data: { members: d.body } } as Node);
        },
        [N.VariableDeclaration]: (n) => {
            // Only declarations with an annotation and a NON-literal initialiser are recorded — a
            // literal initialiser already tells SROA the shape, more precisely than the annotation.
            const vd = n.data as { declarations: Node[] };
            if (vd.declarations.length !== 1) return;
            const d = vd.declarations[0].data as { id: Node; typeAnnotation: Node | null; init: Node | null };
            if (d.init === null || d.typeAnnotation === null) return;
            if (d.init.type === N.ArrayExpression || d.init.type === N.ObjectExpression) return;
            PENDING?.push({ start: n.start, ann: (d.typeAnnotation.data as { typeAnnotation: Node }).typeAnnotation });
        },
    }),
    exit: null,
};

/** Resolve what {@link shapeCollector} recorded, once the traversal has seen every alias. */
export function resolveShapes(): ShapeTable {
    const table: ShapeTable = new Map();
    const aliases = ALIASES;
    const pending = PENDING;
    ALIASES = null;
    PENDING = null;
    if (aliases === null || pending === null) return table;
    for (const { start, ann } of pending) {
        const fields = shapeOf(ann, aliases);
        if (fields !== null) table.set(start, fields);
    }
    return table;
}
