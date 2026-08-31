import * as VFS from 'node:vfs';
import * as FS from 'node:fs';
import { isMainThread } from 'node:worker_threads';

// Manifest recording, in userland: the replacement for the `--vfs-manifest`
// flag now that mounting is `--vfs-mount` and provider selection is the only
// place a mount can be influenced.
//
//   node -r @pipobscure/bundle/record --vfs-load --vfs-mount ./lib
//
// The idea is unchanged — run the application once and write down every file it
// actually reads through the mount, which is the exact set an archive of it
// needs to contain — but it is now a *provider* that does it rather than a hook
// inside `node:vfs`. `recording()` wraps a provider class and records reads on
// the way through; `register()` installs a recording `RealFSProvider` so a
// directory mount picks it up.
//
// Two differences from the flag it replaces, both deliberate:
//
//   * The flag hooked `readFile()`/`readFileSync()` only. Those are where the
//     module loader and ordinary `fs.readFile` calls converge, but a
//     `createReadStream()` goes through `open()` and a handle instead, and was
//     never recorded. Here read-only `open()`s are recorded too: a file that
//     was opened but never read is harmless in a bundle, while a streamed file
//     that is missing from one is not.
//
//   * Recording is a property of a mount rather than of the process, so with
//     several `--vfs-mount` directories every recorded path lands in the same
//     list. With one mount — the case the flag supported at all — it is the
//     same file the flag produced.

// The manifest file itself: which paths have been written, and the appending.
// Paths are appended as soon as they are read rather than buffered and flushed
// at exit, so nothing is lost if the process is killed instead of exiting.
export class Manifest {
    #path;
    #seen = new Set();

    // `truncate` starts a fresh list. It defaults to true only on the main
    // thread: worker threads inherit `execArgv`, so this preload runs in them
    // too, and a worker must append to what the main thread already wrote
    // rather than wipe it mid-run. Concurrent appends are safe without any
    // coordination — O_APPEND writes do not interleave.
    constructor(path, { truncate = isMainThread } = {}) {
        this.#path = path;
        if (truncate) FS.writeFileSync(path, '');
    }

    get path() { return this.#path; }

    // Record one VFS path, once. Best effort: bookkeeping must never break the
    // read that triggered it.
    record(path) {
        try {
            const relative = String(path).replace(/^\/+/, '');
            if (relative === '' || this.#seen.has(relative)) return;
            this.#seen.add(relative);
            FS.appendFileSync(this.#path, `${relative}\n`);
        } catch {
            // ignored
        }
    }
}

// Wrap a provider class so every read through it is recorded in `manifest`.
// Works over any `VirtualProvider` subclass — a `RealFSProvider` for a
// directory mount, a `ZipProvider` or the signed-archive provider from
// './provider.js' for an archive one — and leaves the constructor signature of
// the class it wraps untouched:
//
//   const Recording = recording(VFS.RealFSProvider, new Manifest('app.manifest'));
//   const provider = new Recording('/path/to/directory');
export function recording(Base, manifest) {
    return class Recording extends Base {
        async readFile(path, options) {
            const content = await super.readFile(path, options);
            manifest.record(path);
            return content;
        }

        readFileSync(path, options) {
            const content = super.readFileSync(path, options);
            manifest.record(path);
            return content;
        }

        async open(path, flags, mode) {
            const handle = await super.open(path, flags, mode);
            if (reads(flags)) manifest.record(path);
            return handle;
        }

        openSync(path, flags, mode) {
            const handle = super.openSync(path, flags, mode);
            if (reads(flags)) manifest.record(path);
            return handle;
        }
    };
}

// Register a recording `RealFSProvider` so a `--vfs-mount` of a directory is
// backed by it. Meant to be preloaded, before the mounts are made:
//
//   BUNDLE_MANIFEST=app.manifest node -r @pipobscure/bundle/record \
//       --experimental-vfs --vfs-load --vfs-mount ./lib
//
// With no manifest destination there is nothing to record, so nothing is
// registered and directory mounts are left exactly as node makes them.
//
// options.manifest - where to write the file list (default: the BUNDLE_MANIFEST
//                    environment variable)
// options.truncate - start a fresh list (default: true on the main thread)
// options.name     - identifier reported in diagnostics (default: 'bundle-manifest')
export function register(options = {}) {
    const configured = options.manifest ?? process.env.BUNDLE_MANIFEST;
    if (!configured) return null;

    const manifest = configured instanceof Manifest ? configured : new Manifest(configured, options);
    const Recording = recording(VFS.RealFSProvider, manifest);
    VFS.registerProvider({
        name: options.name ?? 'bundle-manifest',
        // Directory mounts only: an archive mount has its own provider (and,
        // for a `.bundle`, one that verifies what it serves), and quietly
        // replacing it here would be the wrong trade for a file list.
        canHandle: (_resolvedPath, stats) => stats.isDirectory(),
        create: (resolvedPath) => new Recording(resolvedPath),
    });
    return manifest;
}

// Whether `flags` opens for reading. Mirrors how `node:fs` reads them: a string
// means what it says, a number is a bitmask, anything else is 'r'.
function reads(flags) {
    if (typeof flags === 'string') return flags[0] === 'r' || flags.includes('+');
    if (typeof flags !== 'number') return true;
    return (flags & (FS.constants.O_WRONLY | FS.constants.O_TRUNC)) === 0;
}
