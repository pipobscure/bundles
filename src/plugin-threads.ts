import * as THREADS from 'node:worker_threads';
import { Worker } from './plugins.ts';

// `node:worker_threads`, as a plugin sees it: the same module, except that
// its `Worker` starts a thread that has the plugins this one has, mounted at
// the same places (see `Worker` in plugins.ts). The loader's resolve hook
// answers `worker_threads` with this for every import from inside a plugin,
// so a plugin's own
//
//   new Worker(new URL('./scan.js', import.meta.url))
//
// starts a worker that finds `scan.js` where the plugin left it. Everything
// else here is node's own, so nothing else a plugin does with threads
// changes. The host's own imports get node's module, as always.

export * from 'node:worker_threads';
export { Worker };

const threads = { ...THREADS, Worker };
export default threads;
// What `require('worker_threads')` returns from a CommonJS plugin.
export { threads as 'module.exports' };
