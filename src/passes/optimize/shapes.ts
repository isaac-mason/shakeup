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
import { N, type Node, walk } from '../../ast.ts';

/** Declaration start offset → the aggregate's field names, in order. */
export type ShapeTable = Map<number, string[]>;

/** `type X = …` / `interface X { … }` declared in this module. */
function typeAliases(program: Node): Map<string, Node> {
    const out = new Map<string, Node>();
    walk(program, (n) => {
        if (n.type === N.TSTypeAliasDeclaration) {
            const d = n.data as { id: Node; typeAnnotation: Node };
            out.set(d.id.name, d.typeAnnotation);
        } else if (n.type === N.TSInterfaceDeclaration) {
            const d = n.data as { id: Node; body: Node[] };
            // Represent an interface by a synthetic member list; `shapeOf` handles both.
            out.set(d.id.name, { ...n, type: N.TSTypeLiteral, data: { members: d.body } } as Node);
        }
        return undefined;
    });
    return out;
}

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
 * Capture aggregate shapes from type annotations. Call on the TYPED AST, before `tsStrip`.
 * Only declarations with a type annotation and a NON-literal initialiser are recorded — a literal
 * initialiser already tells SROA the shape, and is more precise than the annotation.
 */
export function captureShapes(program: Node): ShapeTable {
    const table: ShapeTable = new Map();
    const aliases = typeAliases(program);
    if (aliases.size === 0 && !hasInlineAnnotation(program)) return table;
    walk(program, (n) => {
        if (n.type !== N.VariableDeclaration) return undefined;
        const vd = n.data as { declarations: Node[] };
        if (vd.declarations.length !== 1) return undefined;
        const d = vd.declarations[0].data as { id: Node; typeAnnotation: Node | null; init: Node | null };
        if (d.init === null || d.typeAnnotation === null) return undefined;
        if (d.init.type === N.ArrayExpression || d.init.type === N.ObjectExpression) return undefined;
        const ann = (d.typeAnnotation.data as { typeAnnotation: Node }).typeAnnotation;
        const fields = shapeOf(ann, aliases);
        if (fields !== null) table.set(n.start, fields);
        return undefined;
    });
    return table;
}

/** Cheap probe so a module with no inline type literals and no aliases skips the walk entirely. */
function hasInlineAnnotation(program: Node): boolean {
    let found = false;
    walk(program, (n) => {
        if (found) return false;
        if (n.type === N.TSTypeLiteral || n.type === N.TSTupleType) found = true;
        return undefined;
    });
    return found;
}
