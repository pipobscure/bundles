import { isScope } from './scopes.ts';

// The parts an app is made of, as its package.json declares them:
//
//   "bundle": {
//     "parts": [
//       { "package": "@ordner.fyi/auth", "url": "auth.nzip", "hash": "sha256:3f1a…" },
//       …
//     ]
//   }
//
// A part is an archive that ships beside the app — the URL is resolved
// against the one the app was fetched from — and is installed as a plugin in
// the app's scope. It is trusted because the app names its hash: the app's
// archive is signed or attested, and the hash is inside what that covers, so
// whoever vouches for the app vouches for exactly these parts. A part needs
// no signature of its own, and no attestation.
//
// `hash` is the part's whole-file hash, as `<alg>:<hex>`: the hash
// attestations name, `bundle verify` reports and `bundle parts` prints. It is
// not the sha256 of the file, which also covers the archive's trailing comment
// — where a signature goes, added after the hash exists.
//
// Read by the installer, and by the plugin loader, which pins an app's parts
// to these hashes as it loads them; so it needs nothing but this.

/** One part an app declares. */
export interface Part {
    /** The package name inside the part: what the app imports, and what it is installed as. */
    package: string;
    /** Where it is, resolved against the URL the app was fetched from. */
    url: string;
    /** Its whole-file hash, `<alg>:<hex>`. */
    hash: string;
}

/** What a pin looks like: `<alg>:<hex>`. */
export const PIN_PATTERN = '^[a-z0-9-]+:[0-9a-f]{32,}$';

/**
 * The parts a package.json declares under `bundle.parts`, checked; or
 * undefined when it declares none. A declaration that does not hold together
 * is an error, never a quietly shorter list.
 */
export function readParts(manifest: unknown, where: string): Part[] | undefined {
    const bundle = (manifest as { bundle?: unknown } | null)?.bundle;
    if (bundle === undefined || bundle === null || typeof bundle !== 'object') return undefined;
    const parts = (bundle as { parts?: unknown }).parts;
    if (parts === undefined) return undefined;
    if (!Array.isArray(parts)) throw new Error(`${where}: bundle.parts must be a list`);
    const seen = new Set<string>();
    return parts.map((part, i) => {
        const at = `${where}: bundle.parts[${i}]`;
        if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error(`${at} must be an object`);
        const { package: pkg, url, hash, ...rest } = part as Record<string, unknown>;
        const unknown = Object.keys(rest);
        if (unknown.length) throw new Error(`${at}: unknown setting '${unknown[0]}' (expected package, url, hash)`);
        if (typeof pkg !== 'string' || !isScope(pkg)) throw new Error(`${at}: package must be a package name`);
        if (typeof url !== 'string' || !url) throw new Error(`${at}: url must be a non-empty string`);
        if (typeof hash !== 'string' || !new RegExp(PIN_PATTERN).test(hash)) throw new Error(`${at}: hash must be the part's whole-file hash, as <alg>:<hex> — 'bundle parts' prints it`);
        if (seen.has(pkg)) throw new Error(`${at}: ${pkg} is declared twice`);
        seen.add(pkg);
        return { package: pkg, url, hash };
    });
}

/** The pins parts make: package name to hash. */
export function pinsOf(parts: Part[]): Record<string, string> {
    return Object.fromEntries(parts.map((part) => [part.package, part.hash]));
}
