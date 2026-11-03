// Counts the primes up to a limit on a pool of worker threads.
//
// The point is not the primes. It is that `new Worker(new URL('./worker.ts',
// import.meta.url))` works when this program is a standalone executable built
// by `bundle sea`: the worker's script is a member of the archive inside the
// executable, not a file on disk, and a fresh thread starts with nothing
// mounted. The executable sets every worker up as its main thread is — the
// same archive, verified again, mounted at the same path — before the
// worker's script loads, so the URL below resolves and nothing it reads goes
// unchecked.
//
//   node --experimental-vfs --vfs-load=. -- 2000000 4    from source
//   ./sea-worker 2000000 4                               the signed executable

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { split } from './lib/primes.ts';

interface Result { threadId: number; from: number; to: number; primes: number; script: string }

const limit = Number(process.argv[2] ?? 2_000_000);
const threads = Number(process.argv[3] ?? Math.min(4, availableParallelism()));
if (!Number.isSafeInteger(limit) || limit < 2 || !Number.isSafeInteger(threads) || threads < 1) {
    console.error('usage: sea-worker [limit >= 2] [threads >= 1]');
    process.exit(64);
}

function work(range: [number, number]): Promise<Result> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: range });
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited with ${code}`)); });
    });
}

const started = performance.now();
const results = await Promise.all(split(limit, threads).map(work));
const elapsed = performance.now() - started;

console.log(`main:    ${import.meta.url}`);
for (const { threadId, from, to, primes, script } of results) {
    console.log(`thread ${threadId}: ${from}…${to} has ${primes} primes  (${script})`);
}
const total = results.reduce((sum, { primes }) => sum + primes, 0);
console.log(`${total} primes up to ${limit}, on ${results.length} threads, in ${Math.round(elapsed)} ms`);
