import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import * as FS from 'node:fs';

// Whether an archive's bytes hold together, and nothing more: its whole-file
// hash, the hash its end-of-central-directory comment records, and the digest
// every member carries in its entry comment. No certificate is looked at and
// no attestation is read, so this needs nothing but node's own modules —
// which is what lets a host that only pins its plugins by hash, and the
// plugin loader that checks them, carry no sigstore and no atproto code.
//
// Who signed the archive, and whether anyone vouches for it, is
// `manifest.ts`, which builds on this. The format itself is described there.

export const AUTHORITY = 'AUTHORITY.PEM';
const SIG_EOCD = 0x06054b50;
const CHUNK = 1 << 20;

/** An archive to be built or verified: a path on disk, or the bytes themselves. */
export type ArchiveSource = string | Buffer;

/** A parsed `SIGNED:<hash>:<sig>[:<NAME>=<value>]*` marker. */
export interface SignatureMarker {
    hash: string;
    sig: string;
    /** The trailing unsigned attributes, keyed by upper-case name. */
    fields: Map<string, string>;
}

/** What `checkIntegrity()` found. */
export interface IntegrityResult {
    /** The bytes hold together: the recorded hash, when there is one, and every member's digest. */
    ok: boolean;
    /** Why not, or what was checked. */
    reason: string;
    /** The digest the archive's manifest names for its hashes. */
    hashAlg?: string | undefined;
    /** The whole-file hash, hex. */
    hash?: string | undefined;
    /** `<alg>:<hex>`: the form attestations, install records and a host's parts name it by. */
    pin?: string | undefined;
    /** Member name -> recorded hex digest. */
    digests?: Map<string, string> | undefined;
    /** Whether it carries a signature marker. Whether the signature is any good is not looked at. */
    signed?: boolean | undefined;
}

/**
 * Check that an archive's bytes are what they say they are: the whole-file
 * hash against the one its comment records (`SIGNED:` or `UNSIGNED:`), and
 * — with `deep`, the default — every member's content against its digest.
 * An archive that records no hash at all is not one of ours, and not ok.
 *
 * It says nothing about who made the archive: anyone can recompute these.
 * Compare `pin` with a hash someone you trust gave you, and it says that
 * these are those bytes.
 */
export function checkIntegrity(source: ArchiveSource, { deep = true, archive }: {
    deep?: boolean | undefined;
    /** An archive already open over `source`; left open for the caller. */
    archive?: ZLIB.ZipFile | ZLIB.ZipBuffer | undefined;
} = {}): IntegrityResult {
    let reader: ArchiveReader | undefined;
    try {
        const io = sourceOf(source);
        reader = readerFor(archive ?? io.open());
        const present = new Map<string, ZLIB.ZipEntry>();
        for (const [name, entry] of reader.entries()) present.set(name, entry);
        const authority = present.get(AUTHORITY);
        if (!authority) return { ok: false, reason: 'no manifest entry: not an archive bundle made' };
        const hashAlg = hashAlgOf(authority.contentSync());
        const eocd = locateEocd(io.tail(), io.size);
        const comment = eocd.comment.toString('ascii');
        const marker = parseSignature(comment);
        const recorded = marker ? marker.hash : parseUnsigned(comment);
        if (!recorded) return { ok: false, reason: 'the archive records no hash of itself', hashAlg };
        const hash = regionHash(io, hashAlg, eocd.start + 20);
        const found = { hashAlg, hash, pin: `${hashAlg}:${hash}`, signed: marker !== null };
        if (hash !== recorded) return { ok: false, reason: 'archive hash does not match the recorded hash', ...found };
        const digests = memberDigests(present, hashAlg, deep);
        if (typeof digests === 'string') return { ok: false, reason: digests, ...found };
        return { ok: true, reason: deep ? 'the hash and every member digest check out' : 'the hash checks out, and every member carries a digest', ...found, digests };
    } catch (err) {
        if (isStructuralError(err)) {
            const reason = (err as { code?: string }).code === 'ERR_BUNDLE_TRAILING_BYTES' ? message(err) : `not a readable ZIP archive: ${message(err)}`;
            return { ok: false, reason };
        }
        throw err;
    } finally {
        if (!archive) reader?.close();
    }
}

/**
 * Every member's recorded digest, checked against its content when `deep`;
 * or, as a string, the first way that fails. The manifest and directories
 * carry none.
 */
export function memberDigests(present: Map<string, ZLIB.ZipEntry>, hashAlg: string, deep: boolean): Map<string, string> | string {
    const digests = new Map<string, string>();
    for (const [name, entry] of present) {
        if (name === AUTHORITY || entry.isDirectory) continue;
        const recorded = entry.comment || '';
        if (!/^[0-9a-f]+$/i.test(recorded)) return `member carries no digest: ${name}`;
        digests.set(name, recorded.toLowerCase());
        if (!deep) continue;
        let actual: string;
        try {
            actual = CRYPTO.createHash(hashAlg).update(entry.contentSync()).digest('hex');
        } catch {
            return `member could not be read: ${name}`;
        }
        if (actual !== recorded.toLowerCase()) return `digest mismatch: ${name}`;
    }
    return digests;
}

/** The digest an `AUTHORITY.PEM` names for the whole-file hash and the members. */
export function hashAlgOf(content: Buffer | string): string {
    const text = Buffer.isBuffer(content) ? content.toString('utf-8') : String(content);
    const head = text.split('\n\n', 1)[0]!;
    for (const line of head.split('\n')) {
        if (line.startsWith('!hash ')) return line.slice('!hash '.length).trim() || 'sha256';
    }
    return 'sha256';
}

/**
 * The whole-file hash of `source` — what a signature covers and what an
 * attestation names — without verifying anything. Null when `source` is not an
 * archive with a manifest. This is the "which proofs do I need?" question asked
 * before a verification that will need them; the verification recomputes it.
 */
export function wholeFileHash(source: ArchiveSource): { hashAlg: string; hash: string } | null {
    let reader: ArchiveReader | undefined;
    try {
        const io = sourceOf(source);
        reader = readerFor(io.open());
        let authority: ZLIB.ZipEntry | undefined;
        for (const [name, entry] of reader.entries()) if (name === AUTHORITY) authority = entry;
        if (!authority) return null;
        const hashAlg = hashAlgOf(authority.contentSync());
        const eocd = locateEocd(io.tail(), io.size);
        return { hashAlg, hash: regionHash(io, hashAlg, eocd.start + 20) };
    } catch {
        return null;
    } finally {
        reader?.close();
    }
}

/**
 * The whole-file hash as `<alg>:<hex>` — `sha256:3f1a…` — the form a host's
 * `bundle.parts` pins a part by. Null for anything that is not an archive
 * with a manifest.
 */
export function pinOf(source: ArchiveSource): string | null {
    const found = wholeFileHash(source);
    return found ? `${found.hashAlg}:${found.hash}` : null;
}

/**
 * The whole-file hash an unsigned archive records — `UNSIGNED:<hash>`, which
 * `bundle create` writes — or null. It says what the bytes should hash to,
 * not who made them: anyone can recompute it, so it catches damage and
 * accidents, and only a signature speaks to authorship.
 */
export function parseUnsigned(comment: string): string | null {
    const m = /^UNSIGNED:([0-9a-f]+)$/.exec(String(comment).trim());
    return m ? m[1]!.toLowerCase() : null;
}

/**
 * Parse an EOCD comment of the form
 * `SIGNED:<hash-hex>:<signature-hex>[:<NAME>=<value>]*`, or null when the
 * archive is unsigned (no such marker). Field values never contain a `:`, which
 * is what keeps splitting on it unambiguous (base64 does not use one).
 */
export function parseSignature(comment: string): SignatureMarker | null {
    const m = /^SIGNED:([0-9a-f]+):([0-9a-f]+)((?::[A-Za-z0-9_]+=[^:]*)*)$/.exec(String(comment).trim());
    if (!m) return null;
    const fields = new Map<string, string>();
    for (const part of m[3]!.split(':')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        fields.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
    }
    return { hash: m[1]!.toLowerCase(), sig: m[2]!.toLowerCase(), fields };
}

/**
 * The signature marker carried by `source`, or null when it carries none —
 * including when it is not a ZIP at all. Reads only the tail of the file, so it
 * is cheap enough to use as a "does this claim to be one of ours?" test before
 * committing to a full verification.
 */
export function signatureOf(source: ArchiveSource): SignatureMarker | null {
    try {
        const io = sourceOf(source);
        return parseSignature(locateEocd(io.tail(), io.size).comment.toString('ascii'));
    } catch {
        return null;
    }
}

/**
 * Whether `source` ends in a ZIP archive: one whose end-of-central-directory
 * record, comment included, runs exactly to the end of the file. A file can
 * contain an archive without ending in one — a SEA's own embedded file system
 * sits inside its blob, with more of the executable after it — and only an
 * archive at the very end is one that was appended.
 */
export function endsInArchive(source: ArchiveSource): boolean {
    try {
        const io = sourceOf(source);
        locateEocd(io.tail(), io.size);
        return true;
    } catch {
        return false;
    }
}

// Damage to the *structure* rather than to the contents: a file that no longer
// parses as a ZIP, or one with bytes after the end of the archive. Both mean
// the same thing to a caller — this is not the archive that was signed.
export function isStructuralError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && (code.startsWith('ERR_ZIP_') || code === 'ERR_BUNDLE_TRAILING_BYTES');
}

// A reader over either archive flavour. `ZipFile` and `ZipBuffer` expose the
// same information under different names — `entriesSync()` against `entries()`,
// `getSync()` against `get()` — and only one of them can be closed.
export interface ArchiveReader {
    entries(): Iterable<[string, ZLIB.ZipEntry]>;
    close(): void;
}

export function readerFor(archive: ZLIB.ZipFile | ZLIB.ZipBuffer): ArchiveReader {
    if (archive instanceof ZLIB.ZipBuffer) {
        return { entries: () => archive.entries(), close: () => {} };
    }
    return { entries: () => archive.entriesSync(), close: () => archive.closeSync() };
}

// Where the bytes come from, abstracted over "a path" and "a Buffer": a
// statable size, a tail read for the EOCD, a chunked hash feed for the signed
// region, and an archive opener.
export interface Source {
    size: number;
    tail(): Buffer;
    feed(sink: CRYPTO.Hash, end: number): void;
    open(): ZLIB.ZipFile | ZLIB.ZipBuffer;
}

export function sourceOf(source: ArchiveSource): Source {
    return Buffer.isBuffer(source) ? bufferSource(source) : pathSource(source);
}

/** The hash of the first `end` bytes: the region a signature covers. */
export function regionHash(io: Source, hashAlg: string, end: number): string {
    const hash = CRYPTO.createHash(hashAlg);
    io.feed(hash, end);
    return hash.digest('hex');
}

function pathSource(path: string): Source {
    const size = FS.statSync(path).size;
    return {
        size,
        tail() {
            const len = Math.min(size, 22 + 0xffff);
            const buf = Buffer.alloc(len);
            const fd = FS.openSync(path, 'r');
            try { FS.readSync(fd, buf, 0, len, size - len); } finally { FS.closeSync(fd); }
            return buf;
        },
        feed(sink, end) {
            const fd = FS.openSync(path, 'r');
            try {
                const buf = Buffer.allocUnsafe(Math.min(CHUNK, end));
                let pos = 0;
                while (pos < end) {
                    const read = FS.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
                    if (read <= 0) throw new Error('unexpected end of file');
                    sink.update(buf.subarray(0, read));
                    pos += read;
                }
            } finally {
                FS.closeSync(fd);
            }
        },
        open: () => openArchive(path),
    };
}

function bufferSource(buf: Buffer): Source {
    return {
        size: buf.length,
        tail: () => buf.subarray(Math.max(0, buf.length - (22 + 0xffff))),
        feed: (sink, end) => { sink.update(buf.subarray(0, end)); },
        open: () => new ZLIB.ZipBuffer(buf),
    };
}

/**
 * Find the end-of-central-directory record in `tail` (the last bytes of a file
 * of total length `size`) and return { start, comment } with `start` absolute.
 * The EOCD must be the last structure in the file, so its comment runs to EOF.
 */
export function locateEocd(tail: Buffer, size: number): { start: number; comment: Buffer } {
    const floor = Math.max(0, tail.length - (22 + 0xffff));
    // The EOCD's comment must end at the end of the file, and that is not a
    // nicety: the hash covers everything up to the comment, so anything *after*
    // it would be bytes nobody signed. Accepting an EOCD that ends early — as
    // this used to, as a fallback — let a signed archive be given a tail of
    // arbitrary data while still verifying. A ZIP reader ignores that tail; a
    // reader of some other format may not.
    for (let pos = tail.length - 22; pos >= floor; pos--) {
        if (tail.readUInt32LE(pos) !== SIG_EOCD) continue;
        const clen = tail.readUInt16LE(pos + 20);
        if (pos + 22 + clen !== tail.length) continue;
        return { start: size - tail.length + pos, comment: tail.subarray(pos + 22, pos + 22 + clen) };
    }
    // Say which of the two it is, because they mean different things: a file
    // that is not a ZIP at all, or one with something appended to it.
    for (let pos = tail.length - 22; pos >= floor; pos--) {
        if (tail.readUInt32LE(pos) !== SIG_EOCD) continue;
        const end = pos + 22 + tail.readUInt16LE(pos + 20);
        throw Object.assign(
            new Error(`${tail.length - end} bytes follow the end of the archive, and nothing signs them`),
            { code: 'ERR_BUNDLE_TRAILING_BYTES' });
    }
    throw new Error('no end of central directory record found');
}

function openArchive(path: string): ZLIB.ZipFile {
    try {
        return ZLIB.ZipFile.openSync(path);
    } catch (err) {
        // A path that is itself a mount point resolves to the mounted tree
        // rather than to bytes, and opening a directory as a ZIP fails deep
        // inside with a confusing message. (A container's *own* path is not one
        // of these: `--vfs-load` leaves it readable, which is what lets a
        // launcher verify itself. This is for a directory mount, or a mount
        // deliberately placed over an archive.)
        let isDir = false;
        try { isDir = FS.statSync(path).isDirectory(); } catch { /* fall through */ }
        if (isDir) {
            throw new Error(`cannot verify '${path}': it is mounted as a live filesystem ` +
                `(the running container cannot read its own container bytes by path — ` +
                `verify it under a different name)`);
        }
        throw err;
    }
}

/** An error's message, for errors that arrive as `unknown`. */
export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
