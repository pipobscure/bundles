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
// Why this is a runner rather than a `-r` preload: node hands registered
// providers every source, directories included, so a recording provider *can*
// now be installed from a preload — `src/record.ts` is exactly that. What a
// preload cannot give you is the mount point, and the cross-check wants the
// entry point resolved against the mount it made, so the mount is made here.
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
