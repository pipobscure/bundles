#!/usr/bin/env node
import * as PATH from 'node:path';
import * as VFS from 'node:vfs';
import { pathToFileURL } from 'node:url';
import { Manifest, recording } from '../src/recorder.ts';
import { packageRoot } from '../src/files.ts';

// Runs this package's CLI through a recording mount of the package root, so
// every file the run actually reads is written down. `tools/pack.ts` uses the
// result as a check on the member list it computed, and this is also where the
// recording provider itself gets exercised over a real tree rather than a
// fixture.
//
// Why this is a runner rather than a `-r` preload: node consults registered
// providers when `--vfs-mount` is handed a *file*, and mounts a directory with
// its own `RealFSProvider` without asking. So a directory mount cannot be
// influenced from a preload, and the mount has to be made here — which also
// means the mount point is the generated one this process is told, and the
// entry point has to be resolved against it.
//
//   BUNDLE_MANIFEST=read.manifest node --experimental-vfs tools/observe.ts help

const destination = process.env['BUNDLE_MANIFEST'];
if (!destination) {
    process.stderr.write('observe: set BUNDLE_MANIFEST to where the file list should go\n');
    process.exit(64);
}

const ROOT = packageRoot();
const manifest = new Manifest(destination, { truncate: true });
const Recording = recording(VFS.RealFSProvider, manifest);
const vfs = VFS.create(new Recording(ROOT), { emitExperimentalWarning: false });
const mount = vfs.mount();

// The CLI reads `process.argv.slice(2)`, and `import.meta.filename` inside the
// mount is what makes its sibling lookups (the register preload, the skills)
// resolve to mounted paths rather than real ones.
const entry = PATH.join(mount, 'dist', 'main.js');
process.argv = [process.argv[0]!, entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
