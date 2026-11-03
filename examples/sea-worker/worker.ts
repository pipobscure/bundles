// One worker of the pool. Started by `new Worker(new URL('./worker.ts', …))`
// from index.ts, so this file is read out of the archive — in a standalone
// executable, out of the executable itself, verified like everything else.

import { parentPort, workerData, threadId } from 'node:worker_threads';
import { count } from './lib/primes.ts';

const [from, to] = workerData as [number, number];
parentPort!.postMessage({ threadId, from, to, primes: count(from, to), script: import.meta.url });
