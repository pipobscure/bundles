'use strict';

// The preload entry point: registering the signed-archive provider is all this
// does, so `--vfs-mount` finds it already in place when it picks a provider for
// its source.
//
//   node --experimental-vfs -r @pipobscure/napp/register --vfs-load --vfs-mount app.napp
//
// `--import @pipobscure/napp/register` works just as well: mounting is
// deferred until both `-r` and `--import` preloads have run, and this module
// imports cleanly from ESM. Either way the point is that registering is a
// preload flag and nothing more — no module of your own to write.
//
// Configure it through the environment — a preload takes no arguments:
//
//   NAPP_ROOTS            extra trusted root certificates, as a
//                         path-delimiter-separated list of PEM files
//   NAPP_ALLOW_UNTRUSTED  accept a good signature whose chain is not anchored
//                         in the trust store
//
// For anything more, import `@pipobscure/napp/provider` and call `register()`
// with options from a preload module of your own.

try {
    require('./provider.js').register();
} catch (err) {
    if (err && (err.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || err.code === 'MODULE_NOT_FOUND') && /node:vfs/.test(err.message)) {
        throw new Error('napp: node:vfs is unavailable — run node with --experimental-vfs', { cause: err });
    }
    throw err;
}
