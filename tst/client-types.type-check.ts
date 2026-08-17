/// <reference path="../client.d.ts" />
// Type-only: proves shakeup/client's ambient declarations resolve the plugin import forms. Compiled
// by `tsc --noEmit` (not run by vitest — no `.test.ts` suffix, and these specifiers have no real
// module on disk; the ambient wildcards make them resolve).

import assetUrl from './nonexistent.png?url';
import InlineWorker from './nonexistent.worker?worker&inline';
import Worker1 from './nonexistent.worker?worker';
import './nonexistent.css';

// the asset URL is a string
export const _url: string = assetUrl;

// the worker default export is a `new`-able WorkerWrapper → a Worker
export const _w: Worker = new Worker1();
export const _wi: Worker = new InlineWorker({ name: 'mesh' });
