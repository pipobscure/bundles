import * as VFS from 'node:vfs';
import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import * as PATH from 'node:path';
import * as FS from 'node:fs';
import { AUTHORITY, signatureOf, verifySync, type VerificationResult } from './manifest.ts';

// A `node:vfs` file provider for signed archives — `.bundle` files — layered on
// the built-in `ZipProvider`. It is what turns "this archive is signed" into
// "this archive is what runs":
//
//   * At mount time (`open()` below) the whole-file hash is recomputed, the
//     signature over it is checked against the leaf certificate in
//     `AUTHORITY.PEM`, and that chain is anchored in the trust store. An
//     archive that fails any of those never becomes a filesystem at all.
//
//   * At *fetch* time every member is hashed as it is read and compared with
//     the digest recorded for it in the archive that was verified at mount.
//     The mount-time hash already covers every member's bytes, but it covers
//     them *as they were when the file was hashed* — a `ZipFile` reads members
//     lazily from an open fd, so anything that rewrites the file underneath a
//     running program would otherwise be served unchecked. Verified content is
//     kept (members are an application's own files, not the runtime), so each
//     member is read and hashed at most once and what later reads see is the
//     copy that was verified, not a fresh read of the file.
//
// Registering this with `vfs.registerProvider()` puts it ahead of the built-in
// ZIP provider, so `--vfs-mount` hands it the source first. It claims files by
// extension (`.bundle`) *and* by content — anything carrying our signature
// marker — so renaming a signed archive cannot quietly downgrade it to the
// unverified built-in provider.

export const EXTENSION = '.bundle';

const READ_FLAGS = FS.constants.O_WRONLY | FS.constants.O_RDWR | FS.constants.O_CREAT |
    FS.constants.O_TRUNC | FS.constants.O_APPEND | FS.constants.O_EXCL;

export interface ProviderOptions {
    /** File suffixes claimed outright (default: ['.bundle']). */
    extensions?: string[] | undefined;
    /**
     * Also claim any file carrying our signature marker, whatever it is named
     * (default: true). This is what keeps a renamed archive from falling
     * through to the built-in ZIP provider, which checks nothing.
     */
    claimSigned?: boolean | undefined;
    /**
     * Extra trusted roots, as PEM text or paths to PEM files (default: the
     * `BUNDLE_ROOTS` environment variable, a path-delimiter-separated list).
     */
    roots?: string[] | undefined;
    /**
     * Accept a good signature whose chain is not anchored in the trust store
     * (default: the `BUNDLE_ALLOW_UNTRUSTED` environment variable).
     */
    allowUntrusted?: boolean | undefined;
    /**
     * Recompute every member digest at mount instead of on fetch
     * (default: false — fetches check them anyway).
     */
    deep?: boolean | undefined;
    /** Require this sigstore signing identity (default: `BUNDLE_IDENTITY`). */
    identity?: string | undefined;
    /** Require this sigstore OIDC issuer (default: `BUNDLE_ISSUER`). */
    issuer?: string | undefined;
    /** Path to the sigstore trust root (default: `BUNDLE_SIGSTORE_ROOT`). */
    trustedRoot?: string | undefined;
    /** Identifier reported in diagnostics (default: 'bundle'). */
    name?: string | undefined;
}

interface Settings {
    [kSettings]: true;
    name: string;
    extensions: string[];
    claimSigned: boolean;
    extraRoots: string[];
    allowUntrusted: boolean;
    deep: boolean;
    identity: string | undefined;
    issuer: string | undefined;
    trustedRoot: string | undefined;
}

/**
 * Verify `path` and return a provider that serves it, or throw. `options` are
 * the same as `register()`'s.
 */
export function open(path: string, options?: ProviderOptions | Settings): BundleProvider {
    const opts = settings(options);
    const resolved = PATH.resolve(path);

    // One ZipFile is opened here and handed to both the verification and the
    // provider: the central directory is read once, and the digests the
    // provider checks against are the ones the verified hash covered.
    const archive = ZLIB.ZipFile.openSync(resolved);
    try {
        const res = verifySync(resolved, {
            archive, deep: opts.deep, extraRoots: opts.extraRoots,
            trustedRoot: opts.trustedRoot, identity: opts.identity, issuer: opts.issuer,
        });
        const acceptable = res.state === 'valid' || (opts.allowUntrusted && res.state === 'valid-untrusted');
        if (!acceptable) throw refusal(resolved, res);
        return new BundleProvider(archive, { hashAlg: res.hashAlg, digests: res.digests });
    } catch (err) {
        archive.closeSync();
        throw err;
    }
}

/**
 * Register this provider with `node:vfs` so the `--vfs-mount` startup flag
 * selects it for signed archives. Meant to be preloaded, before `--vfs-mount`
 * picks a provider:
 *
 *   node --experimental-vfs -r @pipobscure/bundle/register --vfs-load --vfs-mount app.bundle
 */
export function register(options?: ProviderOptions): Settings {
    const opts = settings(options);
    VFS.registerProvider({
        name: opts.name,
        canHandle: (resolvedPath, stats) => stats.isFile() && claims(resolvedPath, opts),
        create: (resolvedPath) => open(resolvedPath, opts),
    });
    return opts;
}

/**
 * A read-only `ZipProvider` that will not hand out a member's content until
 * that content has been hashed and matched against the digest recorded for it.
 */
export class BundleProvider extends VFS.ZipProvider {
    #archive: ZLIB.ZipFile;
    #hashAlg: string;
    #digests: Map<string, string>;
    #verified: VFS.MemoryProvider;

    /**
     * `digests` is the member-name -> hex-digest map from a `verifySync()` of
     * this very archive; `hashAlg` the algorithm those digests are in.
     */
    constructor(archive: ZLIB.ZipFile, { hashAlg = 'sha256', digests = new Map<string, string>() }: {
        hashAlg?: string | undefined;
        digests?: Map<string, string> | undefined;
    } = {}) {
        super(archive);
        this.#archive = archive;
        this.#hashAlg = hashAlg;
        this.#digests = digests;
        this.#verified = new VFS.MemoryProvider();

        // The manifest itself carries no digest of its own — it is what names
        // the algorithms — but its bytes were read during the mount-time check,
        // which the whole-file hash covered. Keep that copy so every path the
        // mount serves comes from verified bytes.
        if (archive.has(AUTHORITY)) {
            const entry = archive.getSync(AUTHORITY);
            this.#keep(AUTHORITY, entry.contentSync(), entry.mode);
        }
    }

    // A signed archive is a fixed artifact: any write would invalidate the
    // signature it was mounted on, so the mount is read-only regardless of how
    // the underlying archive was opened.
    override get readonly(): boolean { return true; }

    override async open(path: string, flags?: string | number, mode?: number) {
        const name = normalize(path);
        if (reads(flags) && this.#check(name)) return this.#verified.open(path, flags, mode);
        return super.open(path, flags, mode);
    }

    override openSync(path: string, flags?: string | number, mode?: number) {
        const name = normalize(path);
        if (reads(flags) && this.#check(name)) return this.#verified.openSync(path, flags, mode);
        return super.openSync(path, flags, mode);
    }

    // Whether `name` can be served from verified content, reading and checking
    // it on first use. `false` means this is not a member with a recorded
    // digest (a directory, or nothing at all) and the base provider should
    // answer — including with the ENOENT/EISDIR it would normally raise.
    #check(name: string): boolean {
        if (this.#verified.existsSync(`/${name}`)) return true;
        const recorded = this.#digests.get(name);
        if (recorded === undefined) return false;

        const entry = this.#archive.getSync(name);
        const content = entry.contentSync();
        const actual = CRYPTO.createHash(this.#hashAlg).update(content).digest('hex');
        if (actual !== recorded) {
            throw Object.assign(new Error(
                `bundle: content of '${name}' does not match its signed digest ` +
                `(expected ${recorded}, got ${actual})`), { code: 'ERR_BUNDLE_INTEGRITY', member: name });
        }
        this.#keep(name, content, entry.mode);
        return true;
    }

    #keep(name: string, content: Buffer, mode: number): void {
        const dir = PATH.posix.dirname(`/${name}`);
        if (dir !== '/' && dir !== '.') this.#verified.mkdirSync(dir, { recursive: true });
        this.#verified.writeFileSync(`/${name}`, content, { mode: mode || 0o444 });
    }
}

// Whether this provider should back `resolvedPath` (already known to be a
// file): by name for the extensions it owns, and by content for anything
// carrying our signature marker.
function claims(resolvedPath: string, opts: Settings): boolean {
    const lower = resolvedPath.toLowerCase();
    if (opts.extensions.some((ext) => lower.endsWith(ext))) return true;
    return opts.claimSigned && signatureOf(resolvedPath) !== null;
}

function refusal(path: string, res: VerificationResult): Error {
    const detail = res.subject ? `${res.reason} [${res.subject.replace(/\n/g, ', ')}]` : res.reason;
    return Object.assign(new Error(`bundle: refusing to mount '${path}': ${res.state} — ${detail}`),
        { code: 'ERR_BUNDLE_UNTRUSTED', state: res.state });
}

// VFS paths are normalized to `/`-rooted POSIX paths; ZIP member names
// have no leading slash.
function normalize(path: string): string {
    return path.startsWith('/') ? path.slice(1) : path;
}

// Whether `flags` opens purely for reading — the only case verified content can
// answer. Anything else goes to the base provider, which refuses it (EROFS)
// because this provider is read-only. Mirrors how `node:fs` itself reads flags:
// a string means what it says, a number is a bitmask, anything else is 'r'.
function reads(flags: string | number | undefined): boolean {
    if (typeof flags === 'string') return flags === 'r';
    if (typeof flags !== 'number') return true;
    return (flags & READ_FLAGS) === 0;
}

const kSettings: unique symbol = Symbol('bundle.settings');

function settings(options: ProviderOptions | Settings = {}): Settings {
    if ((options as Settings)[kSettings]) return options as Settings;
    const opts = options as ProviderOptions;
    return {
        [kSettings]: true,
        name: opts.name ?? 'bundle',
        extensions: (opts.extensions ?? [EXTENSION]).map((ext) => ext.toLowerCase()),
        claimSigned: opts.claimSigned ?? true,
        extraRoots: pems(opts.roots ?? envList('BUNDLE_ROOTS')),
        allowUntrusted: opts.allowUntrusted ?? envFlag('BUNDLE_ALLOW_UNTRUSTED'),
        deep: opts.deep ?? false,
        identity: opts.identity ?? (process.env['BUNDLE_IDENTITY'] || undefined),
        issuer: opts.issuer ?? (process.env['BUNDLE_ISSUER'] || undefined),
        trustedRoot: opts.trustedRoot ?? (process.env['BUNDLE_SIGSTORE_ROOT'] || undefined),
    };
}

// Accepts roots as PEM text or as paths to PEM files, so a caller can pass
// either and `BUNDLE_ROOTS` can name files.
function pems(roots: string[] | undefined): string[] {
    return (roots ?? []).map((root) => (root.includes('-----BEGIN') ? root : FS.readFileSync(root, 'utf-8')));
}

function envList(name: string): string[] {
    return (process.env[name] ?? '').split(PATH.delimiter).filter(Boolean);
}

function envFlag(name: string): boolean {
    const value = process.env[name];
    return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}
