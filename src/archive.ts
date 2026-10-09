import * as ZLIB from 'node:zlib';
import * as PATH from 'node:path';
import * as FS from 'node:fs';
import * as CRYPTO from 'node:crypto';
import { Transform, type Writable } from 'node:stream';
import { buildManifest, formatSignature, AUTHORITY } from './manifest.ts';

// Building an archive, in two steps that are deliberately separable.
//
// `bundle()` collects files off disk into an unsigned archive, behind the
// prefix that decides its shape: a `#!` launcher, a node binary, or nothing.
// `rebundle()` takes an existing archive and signs it. Signing is only ever
// `rebundle()`'s job, and the shape is never its business.
//
// The shape is decided first because it is part of what gets reviewed. The
// prefix runs — a launcher is a shell script, a binary is a runtime — so the
// archive an audit approves has to be the one that is signed, prefix and all.
// Signing still re-emits rather than appending: the certificate chain goes
// into `AUTHORITY.PEM`, which moves every offset after it. It does so behind
// the archive's own prefix, copied as it is:
//
//   bundle   → app.nzip  (prefix: shell-base)   unsigned, records its hash: reviewed
//   rebundle → app.nzip  (the same prefix)      signed over the finished bytes,
//                                               in place
//
// A signer is `{ chain, signAlg, sign(digest) }`: the chain goes into
// `AUTHORITY.PEM` *before* hashing, and `sign()` is called *after*, with the
// finished hash. `keySigner()` below is the offline-CA implementation;
// `sigstore.ts` provides the other one. Nothing here knows which it has.

/** One file about to become an archive member. */
export interface Member {
    /** The member's name inside the archive; a `/`-separated relative path. */
    name: string;
    data: Buffer;
    mode?: number | undefined;
    /** When it was last modified: its file's time, or the time a source archive gave it. */
    modified?: Date | undefined;
}

/** What a signer hands back once the finished hash exists. */
export interface Signature {
    signature: Buffer | Uint8Array;
    /**
     * Unsigned attributes to record beside the signature in the EOCD comment —
     * anything obtained *after* signing, which therefore cannot be inside what
     * the signature covers.
     */
    fields?: Record<string, string | undefined> | undefined;
}

/**
 * The two-phase signing interface. `chain` is known up front (it goes into
 * `AUTHORITY.PEM`, inside the hashed region); `sign()` is called afterwards
 * with the hash of the finished bytes.
 */
export interface Signer {
    kind?: string | undefined;
    /** Full PEM certificate chain, leaf first. */
    chain: string;
    /** Digest the signature over the whole-file hash uses. */
    signAlg: string;
    sign(digest: Buffer): Promise<Signature>;
}

/** What `emit()` reports once the file has been fully written. */
export interface EmitResult {
    /** The whole-file hash, hex: recorded in the archive, signed or not. */
    hash: string | null;
    signed: boolean;
}

export interface BundleOptions {
    /** Base directory the file list is relative to. */
    base: string;
    /** Member names, relative to `base`. */
    files: string[];
    /** A launcher or binary to prepend, making the result self-running. */
    prefix?: string | undefined;
    /** Digest for the whole-file hash and member digests (default: 'sha256'). */
    hashAlg?: string | undefined;
    /** Digest the signature uses (default: 'sha256'). */
    signAlg?: string | undefined;
    /** Shorthand for `signer: keySigner({ key, chain, signAlg })`. */
    key?: Buffer | string | CRYPTO.KeyObject | undefined;
    chain?: string | undefined;
    signer?: Signer | undefined;
    out: Writable;
}

export interface RebundleOptions {
    /** Path to the archive whose members are re-emitted, behind its own prefix. */
    source: string;
    hashAlg?: string | undefined;
    signAlg?: string | undefined;
    key?: Buffer | string | CRYPTO.KeyObject | undefined;
    chain?: string | undefined;
    signer?: Signer | undefined;
    out: Writable;
}

// Members, as `{ name, data, mode }`. Two sources: a directory plus a file
// list, or an existing archive.
//
// `AUTHORITY.PEM` is never carried across from a source archive — it describes
// the signing of the archive it came from, and a re-emitted archive gets a
// fresh one.
//
// A member's time is its file's — never the time the archive happens to be
// made — so the same files make the same archive, byte for byte. A source
// archive's members keep the times it gave them. `SOURCE_DATE_EPOCH`, when
// set, is the latest time any member may have (see `buildTime()`).
export async function *fromDirectory(base: string, files: string[]): AsyncGenerator<Member> {
    const latest = buildTime();
    for (const name of files) {
        const path = PATH.resolve(base, name);
        yield { name, data: FS.readFileSync(path), mode: 0o444, modified: clamp(FS.statSync(path).mtime, latest) };
    }
}

export async function *fromArchive(zip: ZLIB.ZipFile): AsyncGenerator<Member> {
    for (const [name, entry] of zip.entriesSync()) {
        if (name === AUTHORITY || entry.isDirectory) continue;
        yield { name, data: entry.contentSync(), mode: entry.mode || 0o444, modified: entry.modified };
    }
}

/**
 * `SOURCE_DATE_EPOCH`, as reproducible builds define it: the time of the
 * source (say, its last commit, `git log -1 --format=%ct`), in seconds. No
 * member is later than it, so a fresh checkout — whose files all carry the
 * time of the checkout — still makes the same archive. Unset, nothing is
 * clamped.
 */
export function buildTime(): Date | undefined {
    const configured = process.env['SOURCE_DATE_EPOCH']?.trim();
    if (!configured) return undefined;
    if (!/^\d+$/.test(configured)) throw new Error(`SOURCE_DATE_EPOCH is '${configured}', not a number of seconds`);
    return new Date(Number(configured) * 1000);
}

function clamp(time: Date, latest: Date | undefined): Date {
    return latest && time.getTime() > latest.getTime() ? latest : time;
}

// The earliest time a ZIP entry can carry: what a manifest of no members is dated.
const ZIP_EPOCH = new Date(1980, 0, 1);

// Yields a ZipEntry per member — each stamped, in its entry comment, with the
// hex digest of its own content — then a final `AUTHORITY.PEM` manifest entry
// declaring the algorithms and (when signing) carrying the certificate chain.
// Members are small (an application's own files; the heavy runtime is the
// prepended prefix, not an archive member), so each is held whole to hash it
// before the entry, whose comment must be fixed at creation time, is built.
async function *entries(
    members: AsyncIterable<Member> | Iterable<Member>,
    { hashAlg, signAlg, chain }: { hashAlg: string; signAlg?: string | undefined; chain?: string | undefined },
): AsyncGenerator<ZLIB.ZipEntry> {
    // The manifest is made here, not read from a file: it is dated as the
    // latest of the members, which is a time the same inputs always give.
    let latest: Date | undefined;
    for await (const { name, data, mode, modified } of members) {
        const digest = CRYPTO.createHash(hashAlg).update(data).digest('hex');
        if (modified && (!latest || modified.getTime() > latest.getTime())) latest = modified;
        yield await ZLIB.ZipEntry.create(name, data, { mode: mode ?? 0o444, comment: digest, ...(modified ? { modified } : {}) });
    }
    yield await ZLIB.ZipEntry.create(AUTHORITY, buildManifest({ hashAlg, signAlg, chain }), { mode: 0o444, modified: latest ?? buildTime() ?? ZIP_EPOCH });
}

/**
 * A Readable of the ZIP archive over `members`. Its members carry per-file
 * digests and its AUTHORITY.PEM manifest declares the algorithms and chain, but
 * the archive itself is left with an empty EOCD comment: the whole-file hash,
 * and any signature over it, are a property of the finished file and are
 * recorded by `emit()`. `baseOffset` seeds the archive's internal offsets for when it is
 * appended after a prefix.
 */
export function createArchive({ members, base, files, hashAlg = 'sha256', signAlg, chain, baseOffset = 0 }: {
    members?: AsyncIterable<Member> | Iterable<Member> | undefined;
    base?: string | undefined;
    files?: string[] | undefined;
    hashAlg?: string | undefined;
    signAlg?: string | undefined;
    chain?: string | undefined;
    baseOffset?: number | undefined;
}) {
    const source = members ?? fromDirectory(base ?? '.', files ?? []);
    return ZLIB.createZipArchive(entries(source, { hashAlg, signAlg, chain }), { baseOffset });
}

/**
 * A signer backed by a private key and a certificate chain already on disk —
 * the offline-CA path, and the shape `sigstore.ts` implements too.
 */
export function keySigner({ key, chain, signAlg = 'sha256' }: {
    key: Buffer | string | CRYPTO.KeyObject;
    chain: Buffer | string;
    signAlg?: string | undefined;
}): Signer {
    return {
        kind: 'key',
        chain: String(chain),
        signAlg,
        async sign(digest: Buffer): Promise<Signature> {
            return { signature: Buffer.from(CRYPTO.sign(signAlg, digest, key as CRYPTO.KeyLike)) };
        },
    };
}

/** Bytes to put before an archive: the first `length` bytes of the file at `path`. */
export interface Prefix {
    path: string;
    length: number;
}

// Writes `prefix` (when given) then the archive to `out`, without closing
// `out`. With no prefix the result is a plain archive — a `.nzip` meant to be
// run through `--vfs-load`; with one it is a self-running container (a shebang
// launcher or a SEA binary) that carries the archive in its tail. The
// whole-file hash runs over the prefix and then over the archive up to (but
// not including) the EOCD comment, and the comment records it. Without a
// signer that is the hash alone, so even an unsigned archive says what its
// bytes should hash to; with one, the hash is signed and both are recorded,
// so a verifier can validate the hash on its own (a cheap pre-mount integrity
// gate) and only then check the signature over it against the certificate:
//
//   UNSIGNED:<hash-of-region-hex>
//   SIGNED:<hash-of-region-hex>:<signature-hex>[:<NAME>=<value>]*
async function emit({ members, prefix: given, hashAlg = 'sha256', signer, out }: {
    members: AsyncIterable<Member> | Iterable<Member>;
    prefix?: string | Prefix | undefined;
    hashAlg?: string | undefined;
    signer?: Signer | undefined;
    out: Writable;
}): Promise<EmitResult> {
    const hasher = CRYPTO.createHash(hashAlg);
    const prefix = typeof given === 'string' ? { path: given, length: FS.statSync(given).size } : given;

    // 1. Stream the prefix straight to `out`, feeding the whole-file hash —
    //    and after it, if it needs one, a run of zeros that keeps an archive
    //    inside the prefix out of a ZIP reader's sight (see `separation()`).
    const padding = prefix ? separation(prefix) : 0;
    if (prefix) {
        await prepend(prefix, out, hasher);
        if (padding) {
            const zeros = Buffer.alloc(padding);
            hasher.update(zeros);
            await write(out, zeros);
        }
    }

    // 2. Build the archive (small) with an empty EOCD comment, in memory. The
    //    chain has to be embedded here, before anything is hashed — which is
    //    why a signer hands over its certificate up front and signs later.
    const archive = await collect(createArchive({
        members, hashAlg,
        signAlg: signer?.signAlg,
        chain: signer?.chain,
        baseOffset: prefix ? prefix.length + padding : 0,
    }));

    // 3. The hashed region is the prefix plus the archive minus its trailing
    //    2-byte (empty) comment-length field.
    const region = archive.subarray(0, archive.length - 2);
    hasher.update(region);
    const digest = hasher.digest();

    if (!signer) {
        await write(out, withComment(region, `UNSIGNED:${digest.toString('hex')}`));
        return { hash: digest.toString('hex'), signed: false };
    }

    // 4. Sign the hash, and record both as the EOCD comment. Anything the
    //    signer produced *after* signing — a transparency-log entry, a
    //    timestamp — comes back as fields and rides in the same comment, since
    //    it could not have been inside the hash it postdates.
    const { signature, fields } = await signer.sign(digest);

    const marker = formatSignature({
        hash: digest.toString('hex'),
        sig: Buffer.from(signature).toString('hex'),
        fields,
    });
    await write(out, withComment(region, marker));
    return { hash: digest.toString('hex'), signed: true };
}

// The hashed region, then the EOCD comment's length, then the comment.
function withComment(region: Buffer, marker: string): Buffer {
    const comment = Buffer.from(marker, 'ascii');
    if (comment.length > 0xffff) {
        throw new Error(`the marker is ${comment.length} bytes; a ZIP comment holds at most 65535`);
    }
    const length = Buffer.alloc(2);
    length.writeUInt16LE(comment.length, 0);
    return Buffer.concat([region, length, comment]);
}

/**
 * Build an archive from files on disk. `key`/`chain` are accepted as a
 * shorthand for `signer: keySigner({ key, chain, signAlg })`, so the
 * create-and-sign-in-one-step path stays available.
 */
export async function bundle({ base, files, prefix, hashAlg = 'sha256', signAlg = 'sha256', key, chain, signer, out }: BundleOptions): Promise<EmitResult> {
    const active = signer ?? (key && chain ? keySigner({ key, chain, signAlg }) : undefined);
    return emit({ members: fromDirectory(base, files), prefix, hashAlg, signer: active, out });
}

/**
 * Re-emit an existing archive with a new signature: the same members, behind
 * the same prefix. This is what `bundle sign` runs. `source` is a path to an
 * archive, signed or not — its members are read out, its old AUTHORITY.PEM is
 * dropped for one carrying the signer's chain, and everything is laid down
 * again behind the bytes that preceded it before the result is hashed and
 * signed as a whole. Which prefix an archive has is decided when it is
 * created, where it can be reviewed, and never here.
 */
export async function rebundle({ source, hashAlg = 'sha256', signAlg = 'sha256', key, chain, signer, out }: RebundleOptions): Promise<EmitResult> {
    const active = signer ?? (key && chain ? keySigner({ key, chain, signAlg }) : undefined);
    // The archive keeps the shape it was created with: whatever precedes it is
    // copied as it is, never chosen here.
    const length = prefixLength(source);
    const prefix = length ? { path: PATH.resolve(source), length } : undefined;
    const zip = ZLIB.ZipFile.openSync(PATH.resolve(source));
    try {
        // The member list is drained into memory before writing starts: the
        // source archive may be the file being overwritten, and in any case the
        // entries have to outlive the ZipFile handle closed below.
        const members: Member[] = [];
        for await (const member of fromArchive(zip)) members.push(member);
        if (!members.length) throw new Error(`'${source}' contains no members to sign`);
        return await emit({ members, prefix, hashAlg, signer: active, out });
    } finally {
        zip.closeSync();
    }
}

/**
 * Re-emit an existing archive's members behind a different prefix, unsigned:
 * what turns an application archive into an executable, the SEA base in
 * front. Like `bundle()`, it decides a shape, and so its result is what gets
 * reviewed and then signed. Any prefix the source had is left behind.
 */
export async function reprefix({ source, prefix, hashAlg = 'sha256', out }: {
    source: string;
    prefix: string;
    hashAlg?: string | undefined;
    out: Writable;
}): Promise<EmitResult> {
    const zip = ZLIB.ZipFile.openSync(PATH.resolve(source));
    try {
        const members: Member[] = [];
        for await (const member of fromArchive(zip)) members.push(member);
        if (!members.length) throw new Error(`'${source}' contains no members`);
        return await emit({ members, prefix, hashAlg, out });
    } finally {
        zip.closeSync();
    }
}

/**
 * The member names an archive holds, in order, excluding AUTHORITY.PEM — for
 * reporting what is about to be re-signed without reading every member's bytes.
 */
export function members(source: string): string[] {
    const zip = ZLIB.ZipFile.openSync(PATH.resolve(source));
    try {
        return [...zip.entriesSync()]
            .filter(([name, entry]) => name !== AUTHORITY && !entry.isDirectory)
            .map(([name]) => name);
    } finally {
        zip.closeSync();
    }
}

/**
 * How far back from the end of a file node's ZIP reader looks for the end of
 * an archive (`TAIL_LENGTH` in node's lib/internal/zip/constants.js): the
 * record, a maximal comment, the Zip64 locator and record, and some slack.
 */
export const READER_WINDOW = 22 + 0xffff + 20 + 56 + 4096;

/**
 * How many zero bytes to put between `prefix` and the archive after it, so
 * that no archive end inside the prefix is within the reader's window of the
 * end of the file.
 *
 * A prefix can carry an archive of its own: a SEA's file system is a ZIP in
 * its blob, near the end of the executable. With a small archive appended, the
 * reader looking back from the end finds two plausible archive ends, and
 * refuses the file as ambiguous — rightly, since two readers could disagree on
 * which archive it is. Moving the prefix's archive end out of the window,
 * however small what follows, leaves exactly one. The zeros are part of the
 * prefix, inside the signed region; a prefix with no archive end near its own
 * end gets none.
 */
export function separation(prefix: Prefix): number {
    const length = Math.min(prefix.length, READER_WINDOW);
    const tail = Buffer.alloc(length);
    const fd = FS.openSync(prefix.path, 'r');
    try {
        FS.readSync(fd, tail, 0, length, prefix.length - length);
    } finally {
        FS.closeSync(fd);
    }
    const last = tail.lastIndexOf(EOCD_SIGNATURE);
    return last < 0 ? 0 : Math.max(0, READER_WINDOW - (length - last));
}

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * How many bytes precede the archive in `source`: its prefix — a `#!`
 * launcher, a node binary — or 0 for a plain archive. Read from the archive's
 * own structure: the earliest local file header any central-directory record
 * points at, whether the offsets are absolute (as this package writes them) or
 * relative to the archive's start (as `cat prefix archive.zip` leaves them).
 */
export function prefixLength(source: string): number {
    const fd = FS.openSync(PATH.resolve(source), 'r');
    try {
        const size = FS.fstatSync(fd).size;
        const span = Math.min(size, READER_WINDOW);
        const tail = Buffer.alloc(span);
        FS.readSync(fd, tail, 0, span, size - span);
        let at = -1;
        for (let pos = tail.length - 22; pos >= 0; pos--) {
            if (tail.readUInt32LE(pos) === 0x06054b50 && pos + 22 + tail.readUInt16LE(pos + 20) === tail.length) { at = pos; break; }
        }
        if (at < 0) throw new Error(`'${source}' does not end in a ZIP archive`);
        const eocd = size - span + at;
        const records = tail.readUInt16LE(at + 10);
        const cdSize = tail.readUInt32LE(at + 12);
        const cdOffset = tail.readUInt32LE(at + 16);
        if (cdOffset === 0xffffffff || cdSize === 0xffffffff || records === 0xffff) {
            throw new Error(`'${source}' is a Zip64 archive, which cannot be signed here`);
        }
        // Where the central directory is, against where it says it is: 0 for
        // absolute offsets, the prefix's length for relative ones.
        const shift = eocd - cdSize - cdOffset;
        const directory = Buffer.alloc(cdSize);
        FS.readSync(fd, directory, 0, cdSize, eocd - cdSize);
        let first = Infinity;
        for (let pos = 0, n = 0; n < records; n++) {
            if (directory.readUInt32LE(pos) !== 0x02014b50) throw new Error(`'${source}' has a damaged central directory`);
            first = Math.min(first, directory.readUInt32LE(pos + 42));
            pos += 46 + directory.readUInt16LE(pos + 28) + directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
        }
        return records ? shift + first : eocd - cdSize;
    } finally {
        FS.closeSync(fd);
    }
}

function prepend(prefix: Prefix, out: Writable, sink: CRYPTO.Hash): Promise<void> {
    if (!prefix.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const tap = new Transform({
            transform(chunk: Buffer, _enc, cb) { sink.update(chunk); cb(null, chunk); },
        });
        FS.createReadStream(prefix.path, { start: 0, end: prefix.length - 1 }).on('error', reject)
            .pipe(tap).on('error', reject).on('end', () => resolve())
            .pipe(out, { end: false });
    });
}

async function collect(readable: AsyncIterable<Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of readable) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function write(out: Writable, buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        out.write(buffer, (err) => (err ? reject(err) : resolve()));
    });
}
