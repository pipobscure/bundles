'use strict';

// The preload that puts manifest recording back where `--vfs-manifest` used to
// be: registering a recording provider is all it does, so `--vfs-mount` finds
// it already in place when it picks a provider for a directory.
//
//   NAPP_MANIFEST=app.manifest node --experimental-vfs \
//       -r @pipobscure/napp/record --vfs-load --vfs-mount ./lib
//
// `--import @pipobscure/napp/record` works just as well: mounting is deferred
// until both `-r` and `--import` preloads have run, and this module imports
// cleanly from ESM.
//
// Configure it through the environment — a preload takes no arguments:
//
//   NAPP_MANIFEST  where to write the file list; unset records nothing
//
// For anything more (recording an archive mount, several manifests, keeping an
// existing list), import `@pipobscure/napp/recorder` and call `register()` or
// `recording()` from a preload module of your own.

try {
    require('./recorder.js').register();
} catch (err) {
    if (err && (err.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || err.code === 'MODULE_NOT_FOUND') && /node:vfs/.test(err.message)) {
        throw new Error('napp: node:vfs is unavailable — run node with --experimental-vfs', { cause: err });
    }
    throw err;
}
