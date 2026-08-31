import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFS } from '../src/ast/ast.ts';

// The cheap half of what a code GENERATOR would have bought.
//
// `ast/create.ts` is hand-written and stays that way: it changed in 11 of this repo's 434 commits,
// and a drift audit across all 126 builders found exactly ONE mismatch (`NewExpression` ordered
// `pure` and `typeArguments` differently from `DEFS`) with no observable consequence. Generating one
// file to prevent that is a bad trade — oxc amortises its generator across 18 outputs and 15 checked-in
// files; shakeup would have one, and already generates its walkers at RUNTIME with no build step.
//
// What generation WOULD have guaranteed for free is that a builder can never disagree with the
// schema. These two checks buy that guarantee directly, and they are the whole reason the file can
// stay hand-written with confidence.
//
// Both parse `create.ts`/`build.ts` as TEXT rather than calling the builders, deliberately: the
// question is what the SOURCE says, and a builder that assigns fields in the wrong ORDER produces a
// node that is `toEqual`-identical to a correct one while carrying a different V8 hidden class. Only
// reading the literal can see that.

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const CREATE = src('../src/ast/create.ts');
const BUILD = src('../src/ast/build.ts');

/** Field names a builder's `node(...)` data literal assigns, in source order. */
function builderFields(source: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const re = /node\(N\.([A-Za-z]+), [^,]+, [^,]+, ((?:'[^']*'|[^,])+), /g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        let i = re.lastIndex;
        while (/\s/.test(source[i])) i++;
        if (source[i] !== '{') {
            out.set(m[1], []); // null-data node
            continue;
        }
        let depth = 0;
        let j = i;
        for (; j < source.length; j++) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}' && --depth === 0) break;
        }
        out.set(m[1], topLevelKeys(source.slice(i + 1, j)));
    }
    return out;
}

/** Keys of a top-level object literal body, honouring nesting, strings and ES6 shorthand. */
function topLevelKeys(body: string): string[] {
    const keys: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    let colon = -1;
    const push = (seg: string, colonAt: number): void => {
        const t = seg.trim();
        if (t === '') return;
        // Shorthand (`{ callee, body }`) has no `:` — the key IS the expression.
        keys.push(colonAt < 0 ? t : seg.slice(0, colonAt).trim());
    };
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (quote !== null) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') quote = c;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ':' && depth === 0 && colon < 0) colon = i;
        else if (c === ',' && depth === 0) {
            push(body.slice(start, i), colon < 0 ? -1 : colon - start);
            start = i + 1;
            colon = -1;
        }
    }
    push(body.slice(start), colon < 0 ? -1 : colon - start);
    return keys;
}

const BUILT = builderFields(CREATE);
const DECLARED = new Map<string, string[]>(
    (DEFS as readonly { name: string; fields: Record<string, unknown> | null }[]).map((d) => [
        d.name,
        d.fields === null ? [] : Object.keys(d.fields),
    ]),
);

describe('create.ts builders agree with DEFS', () => {
    // A builder that omits a field leaves it `undefined` where the schema promises a value, and
    // every reader (walk, clone, print) trusts the schema. A builder that invents one puts a field
    // on the node that nothing will ever walk or clone.
    it('assigns exactly the fields the schema declares', () => {
        const wrong: string[] = [];
        for (const [type, built] of BUILT) {
            const declared = DECLARED.get(type);
            if (declared === undefined) continue;
            const missing = declared.filter((f) => !built.includes(f));
            const extra = built.filter((f) => !declared.includes(f));
            if (missing.length > 0 || extra.length > 0) wrong.push(`${type}: missing=[${missing}] extra=[${extra}]`);
        }
        expect(wrong).toEqual([]);
    });

    // Insertion order fixes the hidden class. Two construction sites for one node type that disagree
    // on order make every downstream `n.data.x` polymorphic — which is why the codebase treats the
    // node+data shape as fixed. `DEFS` order is the one authority, and `set()` (retyping in place)
    // writes literals in schema order too.
    it('assigns them in schema order', () => {
        const wrong: string[] = [];
        for (const [type, built] of BUILT) {
            const declared = DECLARED.get(type);
            if (declared === undefined) continue;
            const common = built.filter((f) => declared.includes(f));
            const expected = declared.filter((f) => built.includes(f));
            if (JSON.stringify(common) !== JSON.stringify(expected))
                wrong.push(`${type}: builder=[${common}] defs=[${expected}]`);
        }
        expect(wrong).toEqual([]);
    });
});

describe('every node type is constructible', () => {
    // The gap this closes is not tidiness. Six pass files each hand-rolled a private
    // `node(N.IdentifierReference, …)` helper precisely because `create.ts` had no builder for the
    // null-data leaves — the duplication `ast/build.ts` now exists to prevent. A type with no
    // builder anywhere is an invitation to do it a seventh time.
    it('has a builder in create.ts or build.ts for all 152 types', () => {
        const keywordTypes = [...CREATE.matchAll(/typeof N\.(TS[A-Za-z]+)/g)].map((m) => m[1]);
        const uncovered = [...DECLARED.keys()].filter(
            (name) =>
                !new RegExp(`^export const ${name} = \\(`, 'm').test(CREATE) &&
                !new RegExp(`node\\(N\\.${name},`).test(BUILD) &&
                !keywordTypes.includes(name), // reachable via `create.keyword(s, e, N.TSxKeyword)`
        );
        expect(uncovered).toEqual([]);
    });
});
