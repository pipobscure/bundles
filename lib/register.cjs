'use strict';

// The preload entry point: registering the signed-archive provider is all this
// does, so `--vfs-mount` finds it already in place when it picks a provider for
// its source.
//
//   node --experimental-vfs -r @pipobscure/bundle/register --vfs-load --vfs-mount app.bundle
//
// `--import @pipobscure/bundle/register` works just as well: mounting is
// deferred until both `-r` and `--import` preloads have run, and this module
// imports cleanly from ESM. Either way the point is that registering is a
// preload flag and nothing more — no module of your own to write.
//
// Configure it through the environment — a preload takes no arguments:
//
//   BUNDLE_ROOTS            extra trusted root certificates, as a
//                         path-delimiter-separated list of PEM files
//   BUNDLE_ALLOW_UNTRUSTED  accept a good signature whose chain is not anchored
//                         in the trust store
//
// For anything more, import `@pipobscure/bundle/provider` and call `register()`
// with options from a preload module of your own.

try {
    require('./provider.js').register();
} catch (err) {
    if (err && (err.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || err.code === 'MODULE_NOT_FOUND') && /node:vfs/.test(err.message)) {
        throw new Error('bundle: node:vfs is unavailable — run node with --experimental-vfs', { cause: err });
    }
    throw err;
}
