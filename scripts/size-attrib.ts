/**
 * WHERE THE SIZE GAP IS, charged by construct.
 *
 * `standing` says shakeup's crashcat bundle is N bytes bigger than rolldown's. It does not say what
 * those bytes ARE, and the answer has repeatedly inverted the obvious ranking: the biggest RAW item
 * on this corpus (routing 43 `Symbol.toStringTag` stamps through a helper, −3,330 raw) makes the
 * BROTLI output bigger, and the property-name axis that once held 20,326 bytes now holds 553.
 *
 * The original version of this measurement was ad-hoc and thrown away, so every later ranking was a
 * guess dressed as a number. This is the script it should have been.
 *
 * METHOD. Parse both minified bundles with shakeup's own parser and charge every byte to exactly one
 * bucket. LEAVES are charged their own span; STRUCTURE is what is left over — punctuation, keywords,
 * and whitespace — computed as `total - sum(leaves)` rather than measured, so the buckets always sum
 * to the file. Node COUNTS come along because "more bytes" and "more constructs" are different
 * diagnoses: a bigger `identifiers` bucket from longer names is a mangler problem, and the same
 * bucket from more occurrences is a code-shape problem.
 *
 * Both bundles are minified, and neither bundler mangles property names, so `member names` compares
 * directly. `identifiers` does not compare name-for-name — both mangle — which is why it is split
 * into the length and count components.
 *
 * Usage: `pnpm sizeattrib` — add `--out <dir>` to also write both bundles for eyeballing.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { bundle as shakeupBundle } from '../src/bundler/bundle.ts';
import { N, type Node, walkChildren } from '../src/ast/index.ts';
import { parse } from '../src/parser/index.ts';

const ENTRY = '/Users/isaacmason/Development/crashcat/src/index.ts';
const EXTERNAL = ['math', 'math/shapes', 'three'];

const diskFs = {
    read: (i: string) => (existsSync(i) && statSync(i).isFile() ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
    isFile: (i: string) => existsSync(i) && statSync(i).isFile(),
};

/** The buckets, in the order they are reported. `structure` is derived, never accumulated. */
type Attrib = {
    total: number;
    identifiers: number;
    identCount: number;
    memberNames: number;
    memberCount: number;
    strings: number;
    stringCount: number;
    numbers: number;
    numberCount: number;
    nodes: number;
    byType: Map<string, number>;
};

const NAME_OF = new Map<number, string>(Object.entries(N).map(([k, v]) => [v as number, k]));

function attribute(code: string): Attrib {
    const r = parse(code, { ts: false, jsx: false, kind: 'module' });
    if (r.errors.length > 0) throw new Error(`parse failed at ${r.errors[0].pos}: ${r.errors[0].msg}`);
    const a: Attrib = {
        total: code.length,
        identifiers: 0,
        identCount: 0,
        memberNames: 0,
        memberCount: 0,
        strings: 0,
        stringCount: 0,
        numbers: 0,
        numberCount: 0,
        nodes: 0,
        byType: new Map(),
    };
    // Explicit stack rather than recursion: a minified bundle nests deeply enough to overflow, the
    // same reason `deshadowLocals` and `walkRefIdents` gave up on recursion.
    const stack: Node[] = [r.program];
    while (stack.length > 0) {
        const n = stack.pop() as Node;
        a.nodes++;
        const tn = NAME_OF.get(n.type) ?? String(n.type);
        a.byType.set(tn, (a.byType.get(tn) ?? 0) + 1);
        const span = n.end - n.start;
        switch (n.type) {
            case N.IdentifierReference:
            case N.BindingIdentifier:
                a.identifiers += span;
                a.identCount++;
                break;
            case N.IdentifierName:
                a.memberNames += span;
                a.memberCount++;
                break;
            case N.StringLiteral:
                a.strings += span;
                a.stringCount++;
                break;
            // A TEMPLATE counts as a string, and forgetting that is not a detail: rolldown prints
            // its lowered enum member names as `` `SPHERE` `` where shakeup prints `"SPHERE"`, so
            // counting only StringLiteral reported rolldown as having 2 strings to shakeup's 231 and
            // charged it a 3,903-byte difference that does not exist. Only the QUASIS are charged —
            // the TemplateLiteral's own span would swallow its interpolated expressions.
            case N.TemplateElement:
                a.strings += span;
                a.stringCount++;
                break;
            case N.NumericLiteral:
                a.numbers += span;
                a.numberCount++;
                break;
            default:
                break;
        }
        walkChildren(n, (c) => stack.push(c));
    }
    return a;
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);

function report(sk: Attrib, rd: Attrib): void {
    const structure = (x: Attrib): number => x.total - x.identifiers - x.memberNames - x.strings - x.numbers;
    const rows: [string, number, number, number, number][] = [
        ['identifiers', sk.identifiers, rd.identifiers, sk.identCount, rd.identCount],
        ['member names', sk.memberNames, rd.memberNames, sk.memberCount, rd.memberCount],
        ['strings', sk.strings, rd.strings, sk.stringCount, rd.stringCount],
        ['numbers', sk.numbers, rd.numbers, sk.numberCount, rd.numberCount],
        ['structure (derived)', structure(sk), structure(rd), 0, 0],
    ];
    console.log(`\n${' '.repeat(21)}${pad('shakeup', 10)}${pad('rolldown', 10)}${pad('delta', 9)}   occurrences`);
    for (const [name, s, r, sc, rc] of rows) {
        const occ = sc === 0 && rc === 0 ? '' : `   ${pad(sc, 7)} vs ${pad(rc, 7)}  (${sc - rc >= 0 ? '+' : ''}${sc - rc})`;
        console.log(`  ${name.padEnd(19)}${pad(s, 10)}${pad(r, 10)}${pad(`${s - r >= 0 ? '+' : ''}${s - r}`, 9)}${occ}`);
    }
    console.log(`  ${'TOTAL'.padEnd(19)}${pad(sk.total, 10)}${pad(rd.total, 10)}${pad(`+${sk.total - rd.total}`, 9)}`);

    // Identifiers do not compare name-for-name (both mangle), so split the delta into its two
    // causes. Same total can mean "our names are longer" or "we emit more of them", and the fixes
    // are unrelated — mangler quality vs code shape.
    const skMean = sk.identifiers / sk.identCount;
    const rdMean = rd.identifiers / rd.identCount;
    const fromLength = (skMean - rdMean) * rd.identCount;
    const fromCount = (sk.identCount - rd.identCount) * skMean;
    console.log(
        `\n  identifiers split: longer names ${Math.round(fromLength)}b · more occurrences ${Math.round(fromCount)}b` +
            ` (${sk.identCount - rd.identCount} extra at mean ${skMean.toFixed(2)} vs ${rdMean.toFixed(2)})`,
    );

    console.log('\n  NODE COUNTS, largest excess first (a construct we emit and rolldown does not):');
    const deltas = [...sk.byType]
        .map(([t, c]) => [t, c, rd.byType.get(t) ?? 0] as const)
        .filter(([, c, r]) => c - r !== 0)
        .sort((x, y) => y[1] - y[2] - (x[1] - x[2]));
    for (const [t, c, r] of deltas.slice(0, 12)) console.log(`    ${pad(c - r, 7)}  ${t.padEnd(28)} ${c} vs ${r}`);
    console.log(`    ${pad(sk.nodes - rd.nodes, 7)}  ${'TOTAL NODES'.padEnd(28)} ${sk.nodes} vs ${rd.nodes}`);
}

const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;

const skCode = (
    await shakeupBundle({ entry: ENTRY, fs: diskFs, external: EXTERNAL, output: { minify: true, optimize: true } } as never)
).chunks
    .map((c: { code: string }) => c.code)
    .join('\n');

const { rolldown } = await import('rolldown');
const b = await rolldown({ input: ENTRY, external: EXTERNAL, logLevel: 'silent' });
const rdCode = (await b.generate({ format: 'esm', minify: true })).output
    .map((o: { code?: string }) => o.code ?? '')
    .join('\n');
await b.close?.();

if (outDir !== null) {
    writeFileSync(`${outDir}/shakeup.js`, skCode);
    writeFileSync(`${outDir}/rolldown.js`, rdCode);
    console.log(`wrote ${outDir}/shakeup.js and ${outDir}/rolldown.js`);
}

report(attribute(skCode), attribute(rdCode));
