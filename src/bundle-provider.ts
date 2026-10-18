import * as VFS from 'node:vfs';
import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import * as PATH from 'node:path';
import * as FS from 'node:fs';
import { AUTHORITY } from './integrity.ts';

// The provider that serves a verified archive's members, each checked against
// its digest the first time it is read. What decides *whether* an archive is
// mounted is someone else's business — a signature (provider.ts), the
// runtime's plugin rules (plugin-verifier.ts), or a host's pin
// (plugin-pinned.ts) — so this is kept apart from all of them, and needs
// nothing but node's own modules.

const READ_FLAGS = FS.constants.O_WRONLY | FS.constants.O_RDWR | FS.constants.O_CREAT |
    FS.constants.O_TRUNC | FS.constants.O_APPEND | FS.constants.O_EXCL;

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
