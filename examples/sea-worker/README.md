# sea-worker

Counts the primes up to a limit on a pool of worker threads. The primes do not
matter. What matters is this line in [`index.ts`](index.ts):

```js
new Worker(new URL('./worker.ts', import.meta.url), { workerData: range })
```

and whether it still works when the program is a standalone executable built by
[`bundle sea`](../../docs/cli.md#sea):

> can a SEA start a worker from one of its own files, when that file is not on
> disk but a member of the archive inside the executable?

Yes. Everything below was run, not assumed.

## Build and run it

From source first, mounted the way any bundle is:

```sh
node --experimental-vfs --vfs-load=examples/sea-worker -- 2000000 4
```

Then as one executable. It is built unsigned and refuses to run until it is
signed:

```sh
printf 'package.json\nindex.ts\nworker.ts\nlib/primes.ts\n' > sea-worker.manifest
bundle create --base examples/sea-worker --files sea-worker.manifest --output sea-worker.unsigned.nzip
bundle sea --output sea-worker.unsigned \
    --identity '<your workflow>' --issuer https://token.actions.githubusercontent.com \
    sea-worker.unsigned.nzip
bundle sign sea-worker.unsigned            # -> sea-worker
```

To try it offline, sign it against the repository's throwaway test PKI
(`node tools/testpki.ts`) instead: `bundle sea --root build/certs/root.pem …`,
then `bundle sign --key build/certs/leaf.key --chain build/certs/chain.pem …`.

Run it from an empty directory, so nothing on disk can stand in for the archive:

```
$ mkdir empty && cd empty && ../sea-worker 2000000 4
main:    file:///dev/null/vfs/2/index.ts
thread 1: 2…500001 has 41538 primes  (file:///dev/null/vfs/2/worker.ts)
thread 2: 500002…1000001 has 36960 primes  (file:///dev/null/vfs/2/worker.ts)
thread 3: 1000002…1500001 has 35657 primes  (file:///dev/null/vfs/2/worker.ts)
thread 4: 1500002…2000000 has 34778 primes  (file:///dev/null/vfs/2/worker.ts)
148933 primes up to 2000000, on 4 threads, in 299 ms
```

Every worker ran `worker.ts` from the mount, the same place the main thread runs
from, and `worker.ts` imported `lib/primes.ts` from there too. The application
is 3 KB; the executable is 151 MB, nearly all of it node.

## What it demonstrates

**A worker starts with nothing mounted, and the executable fixes that.** A
fresh thread has neither the file system node gives a SEA's main thread nor the
application the launcher mounted, so `./worker.ts` would not resolve. The
executable runs a preload in every thread: in a worker it verifies the same
archive again, under the same policy, and mounts it at the same path, before the
worker's script loads. Nothing in this example knows that happens. The code is
the same `new Worker(new URL(…))` it would be on disk.

**A worker's code is verified like the main thread's.** It is read from the
signed archive, member digests checked as it is read, so a worker is not a way
around the signature.

**The worker's relative imports resolve inside the archive.** `worker.ts`
imports `./lib/primes.ts`, so the worker gets the whole application, not just
its own script.

## The one thing to keep

The main thread tells its workers what it mounted through the environment
(`BUNDLE_SEA_THREAD`), because a copy of the environment is the one thing a
worker inherits without being asked. A `Worker` given an `env` of its own loses
that, and the worker refuses to start:

```
Error: bundle: this worker cannot tell what its main thread mounted — BUNDLE_SEA_THREAD is not in its environment. A Worker given an env of its own must carry it over.
```

If you need a custom environment, spread `process.env` into it, or pass
`BUNDLE_SEA_THREAD` on yourself.
