// The "config as script" dev paradigm: no CLI, no shakeup.config.js — this script IS the build
// definition. It imports the programmatic node API and drives a warm, incremental watch-build loop.
//   npx tsx examples/watch-build.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from '../src/node/index.ts';

// A throwaway project to build. In a real script this is just your repo's src.
const root = mkdtempSync(join(tmpdir(), 'shakeup-watch-'));
const srcDir = join(root, 'src');
mkdirSync(srcDir);
writeFileSync(join(srcDir, 'util.ts'), 'export const greet = (n: string): string => `hi ${n}`;\n');
writeFileSync(join(srcDir, 'index.ts'), "import { greet } from './util';\nexport const msg = greet('world');\n");

let builds = 0;
const handle = watch({
    entry: join(srcDir, 'index.ts'),
    outDir: join(root, 'dist'),
    external: [],
    onRebuild: (result, events) => {
        builds++;
        const trigger = events === null ? 'initial' : events.map((e) => `${e.kind} ${e.id.split('/').pop()}`).join(', ');
        const { parsed, reused } = result.parseStats;
        console.log(
            `build #${builds} [${trigger}] — ${result.chunks.length} chunk, parsed ${parsed} / reused ${reused}, ${result.chunks[0]?.code.length ?? 0} bytes`,
        );
    },
});

// Edit one module after a beat: the watcher fires, and the rebuild reuses every unchanged module.
setTimeout(() => {
    writeFileSync(join(srcDir, 'util.ts'), 'export const greet = (n: string): string => `hello ${n}!`;\n');
}, 200);

setTimeout(() => {
    handle.close();
    rmSync(root, { recursive: true, force: true });
    console.log('done — one initial build, one incremental rebuild, cleaned up.');
    process.exit(0);
}, 700);
