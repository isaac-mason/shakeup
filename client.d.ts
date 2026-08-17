// shakeup ambient client types — the `vite/client` equivalent. These teach TypeScript about the
// import forms shakeup's plugins add (asset / worker / css), which have no real module on disk.
//
// Reference it once from a project's `env.d.ts` (or any ambient `.d.ts`):
//     /// <reference types="shakeup/client" />
//
// Each declaration matches ONLY what the corresponding plugin actually handles — a bare `*.png`
// import is deliberately NOT declared, because the asset plugin resolves assets via `?url`, not by
// extension.

// ── worker plugin: `?worker` / `?worker&inline` ──────────────────────────────
// The default export is the WorkerWrapper — `new W()` gives a module Worker.
declare module '*?worker' {
    const workerConstructor: new (options?: { name?: string }) => Worker;
    export default workerConstructor;
}
declare module '*?worker&inline' {
    const workerConstructor: new (options?: { name?: string }) => Worker;
    export default workerConstructor;
}

// ── asset plugin: `?url` ─────────────────────────────────────────────────────
// The default export is a runtime URL string for the asset.
declare module '*?url' {
    const src: string;
    export default src;
}

// ── css plugin: `.css` ───────────────────────────────────────────────────────
// A side-effect import (the plugin injects a <style> or is a no-op); no meaningful bindings.
declare module '*.css' {}
