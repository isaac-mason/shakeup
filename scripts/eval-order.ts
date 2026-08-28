/**
 * Module EVALUATION ORDER for a module both `require`d and statically imported — roadmap item #1.
 *
 * Run: `pnpm evalorder`
 *
 * Each shape is bundled by shakeup AND rolldown and executed, and compared against NODE running the
 * unbundled sources. Node is the oracle; rolldown is the alignment reference.
 *
 * Every arm runs in a FRESH PROCESS. An earlier version shared `globalThis` between arms and produced
 * nonsense — the orders looked stable and were an artifact of leaked state.
 *
 * Shapes 5-7 exist to exercise the parts of rolldown's `esm_init_obligations.rs` we are choosing what
 * to do about: the nested-re-export carve-out, cross-chunk registration, and the emergent-cycle
 * fixpoint (`Project`). See `llm/notes/cjs-eval-order-plan.md`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle } from '../src/index.ts';

const diskFs = {
    read: (i: string) => (existsSync(i) ? readFileSync(i, 'utf8') : null),
    exists: (i: string) => existsSync(i),
};

type Shape = { files: Record<string, string>; entry?: string; split?: boolean };

const SHAPES: Record<string, Shape> = {
    'esm first, then cjs': {
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'b.cjs': "globalThis.ORDER.push('b');\nconst e = require('./e.js');\nmodule.exports = e.v;\n",
            'main.js': "import './e.js';\nimport b from './b.cjs';\nglobalThis.ORDER.push('main');\nexport const out = b;\n",
        },
    },
    'cjs first, then esm': {
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'b.cjs': "globalThis.ORDER.push('b');\nconst e = require('./e.js');\nmodule.exports = e.v;\n",
            'main.js': "import b from './b.cjs';\nimport './e.js';\nglobalThis.ORDER.push('main');\nexport const out = b;\n",
        },
    },
    'never-reached require': {
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'b.cjs': "globalThis.ORDER.push('b');\nif (globalThis.NEVER) require('./e.js');\nmodule.exports = 1;\n",
            'main.js': "import b from './b.cjs';\nimport './e.js';\nglobalThis.ORDER.push('main');\nexport const out = b;\n",
        },
    },
    'deep chain via middle esm': {
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'mid.js': "import { v } from './e.js';\nexport const w = v;\n",
            'b.cjs': "globalThis.ORDER.push('b');\nconst m = require('./mid.js');\nmodule.exports = m.w;\n",
            'main.js': "import b from './b.cjs';\nimport './mid.js';\nglobalThis.ORDER.push('main');\nexport const out = b;\n",
        },
    },
    // Exercises the nested-re-export carve-out: a wrapped ancestor barrel should own the init, so the
    // inner record must NOT emit one of its own.
    're-export chain to target': {
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'barrel.js': "export { v } from './e.js';\n",
            'b.cjs': "globalThis.ORDER.push('b');\nconst m = require('./barrel.js');\nmodule.exports = m.v;\n",
            'main.js': "import b from './b.cjs';\nimport './barrel.js';\nglobalThis.ORDER.push('main');\nexport const out = b;\n",
        },
    },
    // Exercises cross-chunk registration: the init call and the wrapper land in different chunks.
    'init across a chunk boundary': {
        split: true,
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'b.cjs': "globalThis.ORDER.push('b');\nconst e = require('./e.js');\nmodule.exports = e.v;\n",
            'lazy.js': "import b from './b.cjs';\nimport './e.js';\nglobalThis.ORDER.push('lazy');\nexport const l = b;\n",
            'main.js': "globalThis.ORDER.push('main');\nexport const out = import('./lazy.js').then((m) => m.l);\n",
        },
    },
    // Decides whether rolldown's `Project` fixpoint has a counterpart problem here: does our lowering
    // add cross-chunk init imports that close a cycle the chunker never saw?
    'cross-chunk cycle': {
        split: true,
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'b.cjs': "globalThis.ORDER.push('b');\nconst e = require('./e.js');\nmodule.exports = e.v;\n",
            'a.js': "import b from './b.cjs';\nglobalThis.ORDER.push('a');\nexport const a = b;\nexport const later = () => import('./c.js');\n",
            'c.js': "import { a } from './a.js';\nimport './e.js';\nglobalThis.ORDER.push('c');\nexport const c = a;\n",
            'main.js':
                "import { a, later } from './a.js';\nglobalThis.ORDER.push('main');\nexport const out = later().then((m) => [a, m.c]);\n",
        },
    },
    // Already working; must not regress.
    'require-ONLY target': {
        files: {
            'e.js': "globalThis.ORDER.push('e');\nexport const v = 1;\n",
            'b.cjs': "globalThis.ORDER.push('b');\nconst e = require('./e.js');\nmodule.exports = e.v;\n",
            'main.js': "import b from './b.cjs';\nglobalThis.ORDER.push('main');\nexport const out = b;\n",
        },
    },
};

/** Evaluate `entry` in a FRESH process and report the recorded order. */
function orderOf(dir: string, entry: string): string {
    const runner = join(dir, `__run-${entry.replace(/[^\w]/g, '_')}.mjs`);
    writeFileSync(
        runner,
        `globalThis.ORDER = [];\nconst m = await import('./${entry}');\nawait m.out?.catch?.(() => {});\nawait m.out;\nconsole.log(JSON.stringify(globalThis.ORDER));\n`,
    );
    try {
        return execFileSync(process.execPath, [runner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
        const err = String((e as { stderr?: Buffer }).stderr ?? '').split('\n')[0];
        return `THREW ${err.slice(0, 46)}`;
    }
}

let diverge = 0;
let unaligned = 0;
for (const [name, shape] of Object.entries(SHAPES)) {
    const d = mkdtempSync(join(tmpdir(), 'evalorder-'));
    for (const [f, src] of Object.entries(shape.files)) writeFileSync(join(d, f), src);
    const entry = join(d, shape.entry ?? 'main.js');
    const node = orderOf(d, shape.entry ?? 'main.js');

    // EACH BUNDLER WRITES INTO ITS OWN DIRECTORY. A bundler's entry chunk is named `main.js`, the
    // same as the source — writing it beside the sources overwrote them, and the next bundler then
    // bundled the PREVIOUS bundler's output. That reported rolldown as diverging from Node on six
    // shapes when it matches on all eight.
    const shakeDir = mkdirSync(join(d, 'out-shakeup'), { recursive: true }) ?? join(d, 'out-shakeup');
    const rdDir = mkdirSync(join(d, 'out-rolldown'), { recursive: true }) ?? join(d, 'out-rolldown');

    let ours: string;
    const r = await bundle({ entry, fs: diskFs, output: {} } as never);
    if (r.errors.length > 0) ours = `BUILD ${r.errors[0].slice(0, 40)}`;
    else {
        // Multi-chunk output has to be written out whole, or the dynamic import dangles.
        for (const c of r.chunks) writeFileSync(join(shakeDir, c.fileName), c.code);
        for (const a of r.assets ?? []) writeFileSync(join(shakeDir, a.fileName), a.source as string);
        ours = orderOf(shakeDir, r.chunks.find((c) => c.isEntry)?.fileName ?? 'main.js');
    }

    let rd: string;
    try {
        const { rolldown } = await import('rolldown');
        const b = await rolldown({ input: entry, logLevel: 'silent' });
        const { output } = await b.generate({ format: 'es' });
        for (const o of output)
            if (o.type === 'chunk')
                writeFileSync(join(rdDir, (o as { fileName: string }).fileName), (o as { code: string }).code);
        const rdEntry = output.find((o) => o.type === 'chunk' && (o as { isEntry: boolean }).isEntry) as
            | { fileName: string }
            | undefined;
        rd = rdEntry === undefined ? 'NO ENTRY' : orderOf(rdDir, rdEntry.fileName);
    } catch (e) {
        rd = `ERR ${(e as Error).message.slice(0, 40)}`;
    }

    const okNode = ours === node;
    const okRd = rd === node;
    if (!okNode) diverge++;
    if (!okRd) unaligned++;
    console.log(
        `${name.padEnd(28)} node=${node.padEnd(26)} shakeup=${ours.padEnd(26)} ${okNode ? 'match ' : 'DIVERGE'}   rolldown=${rd.padEnd(26)} ${okRd ? '' : '(rolldown differs too)'}`,
    );
}
console.log(`\n${Object.keys(SHAPES).length} shapes · shakeup diverges on ${diverge} · rolldown diverges on ${unaligned}`);
