import * as VFS from 'node:vfs';
import * as ZLIB from 'node:zlib';
import * as PATH from 'node:path';
import { checkIntegrity } from './integrity.ts';
import { BundleProvider } from './bundle-provider.ts';
import { mountAt } from './mounts.ts';

// Mounting a plugin its host pins by hash: one of the host's own parts, or a
// plugin the host names in `use(scope, { verify: { pins } })`. The pin is the
// whole question. Its bytes must hash to it and hold together, and then it is
// mounted through `BundleProvider`, which checks every member against its
// digest as it is read — so what was checked here is what runs, even if the
// file is changed underneath the process.
//
// Nothing about signatures or attestations is looked at, so this needs no
// sigstore and no atproto: a host that only pins its parts carries none of
// that. Under a verifying runtime, plugins.ts hands pinned plugins to the
// runtime's own verifier instead, which also applies the blocks it carries.
//
// Loaded by plugins.ts the first time something pinned is mounted.

/**
 * Check that `file` is the archive `pin` names, and mount it; or throw an
 * error whose `reasons` say why not.
 */
export function mountPinned(file: string, pin: string, { by, at }: {
    /** Who pins it, as a refusal says: `this app`, `@ordner.fyi/suite's parts`. */
    by: string;
    /** Where to mount it — the mount point another thread has it at. */
    at?: string | undefined;
}): { root: string } {
    const path = PATH.resolve(file);
    const archive = ZLIB.ZipFile.openSync(path);
    let mounted = false;
    try {
        const found = checkIntegrity(path, { archive, deep: false });
        if (!found.ok) throw refusal(path, [found.reason]);
        if (found.pin !== pin.toLowerCase()) {
            throw refusal(path, [`its whole-file hash is ${found.pin}, and ${by} pins ${pin}`]);
        }
        const provider = new BundleProvider(archive, { hashAlg: found.hashAlg, digests: found.digests });
        const root = mountAt(VFS as never, () => VFS.create(provider, { emitExperimentalWarning: false }), at);
        mounted = true;
        return { root };
    } finally {
        if (!mounted) archive.closeSync();
    }
}

function refusal(path: string, reasons: string[]): Error {
    return Object.assign(new Error(`bundle: refusing to load the plugin '${path}': ${reasons.join('; ')}`),
        { code: 'ERR_BUNDLE_UNTRUSTED', reasons });
}
