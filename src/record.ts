import { preload, sibling } from './preload.ts';
import type * as Recorder from './recorder.ts';

// The preload that puts manifest recording back where `--vfs-manifest` used to
// be: registering a recording provider is all it does, so `--vfs-mount` finds
// it already in place when it picks a provider for a directory.
//
//   BUNDLE_MANIFEST=app.manifest node --experimental-vfs \
//       -r @pipobscure/bundle/record --vfs-load=./lib
//
// `--import @pipobscure/bundle/record` works just as well: mounting is deferred
// until both `-r` and `--import` preloads have run, and this module imports
// cleanly from ESM.
//
// Configure it through the environment — a preload takes no arguments:
//
//   BUNDLE_MANIFEST  where to write the file list; unset records nothing
//
// For anything more (recording an archive mount, several manifests, keeping an
// existing list), import `@pipobscure/bundle/recorder` and call `register()` or
// `recording()` from a preload module of your own.

preload(() => {
    sibling<typeof Recorder>(import.meta.filename, 'recorder').register();
});
