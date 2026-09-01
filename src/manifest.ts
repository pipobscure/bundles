import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import * as TLS from 'node:tls';
import * as FS from 'node:fs';
import * as SIGSTORE from './sigstore.ts';

// The signature is staged so a verifier can gate cheaply before doing more:
//
//   * Integrity — a single hash covers the *entire file*: the prepended
//     launcher/binary (when there is one), every member, the whole central
//     directory (member comments included) and the fixed part of the
//     end-of-central-directory record, up to but excluding the EOCD's 2-byte
//     comment-length field. The EOCD must be the last thing in the file, so the
//     hashed region is simply everything before its trailing comment.
//
//   * Authenticity — the leaf certificate signs that hash (not the file), so
//     once the hash is known the signature check needs no re-read of the file.
//
//   * Per-member integrity — every member also carries the hex digest of its
//     own content in its ZIP entry comment, the same guarantee applied one file
//     at a time. This is what `provider.ts` re-checks on each member fetch, so
//     content handed to a running program is verified as it is read and not
//     merely at the moment the archive was mounted.
//
// Both are recorded in the EOCD comment — which the whole-file hash stops short
// of — as a single marker:
//
//   SIGNED:<hash-of-region-hex>:<signature-hex>[:<NAME>=<value>]*
//
// A verifier can validate the hash on its own (a pre-mount integrity gate),
// then check the signature over that hash against the certificate, and only a
// signed archive (one carrying this marker) is gated at all.
//
// The trailing `NAME=value` fields are the unsigned-attribute region this
// format needs and every code-signing scheme eventually grows: anything
// obtained *after* the signature exists cannot be inside what the signature
// covers, so it goes here instead — the same placement RFC 3161 timestamp
// tokens get in CMS `unsignedAttrs`. Today the only field is `SIGSTORE=`, a
// base64 sigstore bundle carrying the transparency-log entry and timestamp
// that establish *when* the archive was signed. Fields are optional and
// unknown ones are ignored, so a two-field marker written by an older version
// still parses.
//
// The manifest is the `AUTHORITY.PEM` member: it declares the algorithms and
// carries the certificate chain (the signing authority) — hence the name, which
// is also a real, extractable filename a plain zip utility will happily pull
// out when auditing:
//
//   !manifest 2                     <- magic + format version
//   !hash sha256                    <- digest for the whole-file hash and members
//   !sign sha256                    <- digest the signature (over that hash) uses
//                                   <- blank line (present only when signed)
//   -----BEGIN CERTIFICATE-----     <- full PEM chain, leaf first, embedded so
//   ...                                a verifier is self-contained

const MAGIC = 'manifest';
const VERSION = '2';
export const AUTHORITY = 'AUTHORITY.PEM';
const SIG_EOCD = 0x06054b50;
const CHUNK = 1 << 20;

/** What a verification concluded, in increasing order of confidence. */
export type VerificationState = 'unsigned' | 'invalid' | 'valid-untrusted' | 'valid';

/** The archive-side surface of `AUTHORITY.PEM`. */
export interface ManifestFields {
    /** Format version, absent when the member was not a manifest at all. */
    version?: string | undefined;
    /** Digest used for the whole-file hash and for member digests. */
    hashAlg: string;
    /** Digest the signature over the whole-file hash uses; absent when unsigned. */
    signAlg?: string | undefined;
    /** The certificate chain, leaf first; empty when unsigned. */
    chain: CRYPTO.X509Certificate[];
}

/** A parsed `SIGNED:<hash>:<sig>[:<NAME>=<value>]*` marker. */
export interface SignatureMarker {
    hash: string;
    sig: string;
    /** The trailing unsigned attributes, keyed by upper-case name. */
    fields: Map<string, string>;
}

export interface VerificationResult {
    state: VerificationState;
    reason: string;
    /** Subject of the leaf certificate, when the archive named one. */
    subject?: string | undefined;
    /** True for anything but `unsigned` — the archive claimed a signature. */
    signed: boolean;
    /** True only for `valid`. */
    trusted: boolean;
    hashAlg?: string | undefined;
    /** Member name -> recorded hex digest, from the archive that was hashed. */
    digests?: Map<string, string> | undefined;
    /** True when the archive was signed through sigstore. */
    sigstore?: boolean | undefined;
    /** The sigstore signing identity (a SAN), once established. */
    identity?: string | undefined;
    /** The sigstore OIDC issuer, once established. */
    issuer?: string | undefined;
    /** When the signature was witnessed, per the transparency log. */
    signedAt?: Date | undefined;
}

export interface VerifyOptions {
    /** Additional trusted PEM roots, besides system + NODE_EXTRA_CA_CERTS. */
    extraRoots?: string[] | undefined;
    /**
     * Reference time for certificate validity (default: now). Ignored on the
     * sigstore path, which derives the signing time from the archive's own log
     * entry instead.
     */
    now?: number | undefined;
    /**
     * Also recompute every member's content digest (default: true). With
     * `false` only the presence of the digests is checked; the whole-file hash
     * already covers the members' bytes, so this is the right trade for a mount
     * that re-checks each member as it is actually read.
     */
    deep?: boolean | undefined;
    /**
     * An already-open archive over `source` to read entries from. When given it
     * is left open for the caller; otherwise one is opened and closed here.
     */
    archive?: ZLIB.ZipFile | ZLIB.ZipBuffer | undefined;
    /**
     * Path to a sigstore trust root, for sigstore-signed archives
     * (default: BUNDLE_SIGSTORE_ROOT, else the TUF cache, else the seed).
     */
    trustedRoot?: string | undefined;
    /** Require this sigstore signing identity (SAN). */
    identity?: string | undefined;
    /** Require this sigstore OIDC issuer. */
    issuer?: string | undefined;
}

/** An archive to be built or verified: a path on disk, or the bytes themselves. */
export type ArchiveSource = string | Buffer;

/**
 * How each state is reported, and the exit code that goes with it.
 *
 * The codes are part of the CLI's contract — a script branching on
 * `bundle verify` depends on them — so they live here with the states they
 * describe rather than in `cli.ts`. That also keeps the `bundle` launcher from
 * having to load the CLI to find out what exit code a refusal deserves.
 */
export const STATES: Record<VerificationState, { code: number; label: string; note: string }> = {
    'unsigned':        { code: 3, label: 'UNSIGNED',          note: 'archive carries no signature' },
    'invalid':         { code: 2, label: 'INVALID',           note: 'manifest is wrong or does not cover the whole archive' },
    'valid-untrusted': { code: 1, label: 'VALID (UNTRUSTED)', note: 'signature is good but the certificate is not trusted' },
    'valid':           { code: 0, label: 'VALID',             note: 'signature is good and the certificate is trusted' },
};

// Build the manifest content from the algorithms and (when signing) the
// certificate chain.
export function buildManifest({ hashAlg = 'sha256', signAlg, chain }: {
    hashAlg?: string | undefined;
    signAlg?: string | undefined;
    chain?: string | undefined;
} = {}): Buffer {
    let body = `!${MAGIC} ${VERSION}\n!hash ${hashAlg}\n`;
    if (signAlg && chain) body += `!sign ${signAlg}\n\n` + String(chain).replace(/\s*$/, '') + '\n';
    return Buffer.from(body, 'utf-8');
}

// Split manifest bytes into { version, hashAlg, signAlg, chain }.
export function parseManifest(content: Buffer | string): ManifestFields {
    const text = Buffer.isBuffer(content) ? content.toString('utf-8') : String(content);
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const pem = split >= 0 ? text.slice(split + 2) : '';
    const directives: Record<string, string> = {};
    for (const line of head.split('\n')) {
        if (!line || line[0] !== '!') continue;
        const sp = line.indexOf(' ');
        if (sp < 0) directives[line.slice(1)] = '';
        else directives[line.slice(1, sp)] = line.slice(sp + 1);
    }
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    return {
        version: directives[MAGIC],
        hashAlg: directives['hash'] || 'sha256',
        signAlg: directives['sign'],
        chain: blocks.map((block) => new CRYPTO.X509Certificate(block)),
    };
}

/**
 * Verify an archive. `source` is a filesystem path (opened read-only and read
 * in chunks) or a Buffer of the whole file.
 *
 * `digests` on the result is the member-name -> hex-digest map read from the
 * entry comments of the very archive that was just hashed. A caller that goes
 * on to serve those members (see provider.ts) should keep this map rather than
 * re-reading the comments later, so what it checks content against is what the
 * signature covered.
 */
export function verifySync(source: ArchiveSource, options: VerifyOptions = {}): VerificationResult {
    const io = Buffer.isBuffer(source) ? bufferSource(source) : pathSource(source);
    const opened = options.archive ?? io.open();
    const reader = readerFor(opened);
    try {
        return inspect(reader, io, options);
    } finally {
        if (!options.archive) reader.close();
    }
}

/**
 * Promise-returning wrapper around `verifySync`, for callers that treat
 * verification as an asynchronous step. Hashing is CPU-bound either way, so the
 * work still runs to completion synchronously.
 */
export async function verify(source: ArchiveSource, options?: VerifyOptions): Promise<VerificationResult> {
    return verifySync(source, options);
}

// A reader over either archive flavour. `ZipFile` and `ZipBuffer` expose the
// same information under different names — `entriesSync()` against `entries()`,
// `getSync()` against `get()` — and only one of them can be closed.
interface ArchiveReader {
    entries(): Iterable<[string, ZLIB.ZipEntry]>;
    close(): void;
}

function readerFor(archive: ZLIB.ZipFile | ZLIB.ZipBuffer): ArchiveReader {
    if (archive instanceof ZLIB.ZipBuffer) {
        return { entries: () => archive.entries(), close: () => {} };
    }
    return { entries: () => archive.entriesSync(), close: () => archive.closeSync() };
}

// The staged check itself. Split out so `verifySync` owns only the lifetime of
// the archive it may have opened.
function inspect(reader: ArchiveReader, io: Source, options: VerifyOptions): VerificationResult {
    const { extraRoots, now = Date.now(), deep = true, trustedRoot, identity, issuer } = options;
    const present = new Map<string, ZLIB.ZipEntry>();
    for (const [name, entry] of reader.entries()) present.set(name, entry);

    const authority = present.get(AUTHORITY);
    if (!authority) return result('unsigned', 'no manifest entry');

    const { hashAlg, signAlg, chain } = parseManifest(authority.contentSync());

    // The signature lives in the EOCD comment as `SIGNED:<hash>:<sig>`; the
    // region the hash covers ends just before the comment's length field.
    const eocd = locateEocd(io.tail(), io.size);
    const marker = parseSignature(eocd.comment.toString('ascii'));
    if (!signAlg || chain.length === 0 || !marker) {
        return result('unsigned', 'manifest carries no signature', chain, { hashAlg });
    }
    const regionEnd = eocd.start + 20; // up to, and excluding, the comment-length field

    // 1. Integrity (the cheap pre-mount gate): recompute the whole-file hash
    //    and confirm it matches the hash recorded in the comment. No certs yet.
    let digest: string | null;
    try {
        const hash = CRYPTO.createHash(hashAlg);
        io.feed(hash, regionEnd);
        digest = hash.digest('hex');
    } catch {
        digest = null;
    }
    if (digest !== marker.hash) return result('invalid', 'archive hash does not match the recorded hash', chain, { hashAlg });

    // 2. Authenticity: the recorded hash must be signed by the leaf certificate.
    //    Because the signature is over the hash, this needs no re-read of the file.
    const leaf = chain[0]!;
    let signatureOk = false;
    try {
        signatureOk = CRYPTO.verify(signAlg, Buffer.from(marker.hash, 'hex'), leaf.publicKey, Buffer.from(marker.sig, 'hex'));
    } catch {
        signatureOk = false;
    }
    if (!signatureOk) return result('invalid', 'signature does not verify against leaf certificate', chain, { hashAlg });

    // 3. Per-member integrity: every member must record a digest of its own
    //    content, and — when `deep` — that digest must match what the member
    //    actually decompresses to. (The whole-file hash already fixes every
    //    member; this checks each file on its own terms, as a member fetch will.)
    const digests = new Map<string, string>();
    for (const [name, entry] of present) {
        if (name === AUTHORITY || entry.isDirectory) continue;
        const recorded = entry.comment || '';
        if (!/^[0-9a-f]+$/i.test(recorded)) return result('invalid', `member carries no digest: ${name}`, chain, { hashAlg });
        digests.set(name, recorded.toLowerCase());
        if (!deep) continue;
        let memberDigest: string;
        try {
            memberDigest = CRYPTO.createHash(hashAlg).update(entry.contentSync()).digest('hex');
        } catch {
            return result('invalid', `member could not be read: ${name}`, chain, { hashAlg, digests });
        }
        if (memberDigest !== recorded.toLowerCase()) return result('invalid', `digest mismatch: ${name}`, chain, { hashAlg, digests });
    }

    // 4. Signature and digests are sound; what remains is trust — whether this
    //    certificate means anything to us. Which question that is depends on
    //    what kind of certificate it is.
    const sigstoreField = marker.fields.get(SIGSTORE.FIELD);
    if (sigstoreField) {
        return sigstoreTrust(sigstoreField, marker, chain, { hashAlg, digests, trustedRoot, identity, issuer });
    }

    // A demanded identity is a demand about *who signed this*, and only the
    // sigstore path can answer it. An archive signed against an ordinary CA
    // carries no such claim, so the policy cannot be satisfied — and reporting
    // it as trusted anyway would turn `--identity` into a no-op exactly where
    // it is being relied on. Untrusted rather than invalid: the signature is
    // genuine, it just is not the one that was asked for.
    if (identity || issuer) {
        return result('valid-untrusted',
            'a sigstore identity was required but this archive is not sigstore-signed',
            chain, { hashAlg, digests });
    }

    const roots = trustRoots(extraRoots);
    const ok = anchored(chain, roots, now);
    return result(ok ? 'valid' : 'valid-untrusted',
        ok ? 'trusted certificate chain' : 'certificate chain not anchored in the trust store',
        chain, { hashAlg, digests });
}

// Trust, for an archive signed through sigstore. This replaces the plain X.509
// anchoring rather than supplementing it, because the question is different: a
// Fulcio certificate is valid for about ten minutes, so asking whether it is in
// date *now* would fail every archive older than lunchtime. What the sigstore
// bundle carries — a transparency-log entry and an RFC 3161 timestamp — is the
// evidence needed to ask whether it was in date *when the signature was made*,
// and `@sigstore/verify` is what checks that end to end: certificate to the
// Fulcio root, SCT, log inclusion, timestamps, and the signature itself.
function sigstoreTrust(
    encoded: string,
    marker: SignatureMarker,
    chain: CRYPTO.X509Certificate[],
    { hashAlg, digests, trustedRoot, identity, issuer }: {
        hashAlg: string;
        digests: Map<string, string>;
        trustedRoot?: string | undefined;
        identity?: string | undefined;
        issuer?: string | undefined;
    },
): VerificationResult {
    const extra = { hashAlg, digests, sigstore: true };
    const undecided = (reason: string) => result('valid-untrusted', reason, chain, extra);

    // Not being able to check is not the same answer as checking and finding it
    // forged, so a missing library or trust root degrades rather than fails.
    if (!SIGSTORE.available()) {
        return undecided('archive is sigstore-signed but the sigstore libraries are not installed');
    }
    const root = SIGSTORE.trustedRootSync(trustedRoot);
    if (!root) {
        return undecided('archive is sigstore-signed but no sigstore trust root is available — run `bundle trust`');
    }

    // The bundle rides in the unhashed comment, so it is the one part of the
    // file an attacker can swap freely. Two checks close that off: the bundle
    // must be over this archive's hash (below, via the artifact argument), and
    // it must name the same certificate as the AUTHORITY.PEM that *is* inside
    // the signed region. Without the second, a valid bundle for someone else's
    // identity could be pinned to an archive whose extractable manifest claims
    // a different signer — the signature would check out and the inspectable
    // file would be a lie.
    let cert: CRYPTO.X509Certificate | null;
    try {
        cert = SIGSTORE.bundleCertificate(encoded);
    } catch (err) {
        return result('invalid', `sigstore bundle could not be read: ${message(err)}`, chain, extra);
    }
    if (!cert) return result('invalid', 'sigstore bundle carries no certificate', chain, extra);
    if (!chain[0] || cert.fingerprint256 !== chain[0].fingerprint256) {
        return result('invalid', 'AUTHORITY.PEM does not name the certificate the sigstore bundle was signed with', chain, extra);
    }

    try {
        const res = SIGSTORE.verifyBundle(encoded, Buffer.from(marker.hash, 'hex'), { trustedRoot: root, identity, issuer });
        const when = res.signedAt ? `, signed ${res.signedAt.toISOString()}` : '';
        return result('valid', `sigstore identity ${res.identity ?? '(none)'} via ${res.issuer ?? 'unknown issuer'}${when}`,
            chain, { ...extra, identity: res.identity, issuer: res.issuer, signedAt: res.signedAt });
    } catch (err) {
        // A policy failure means the signature is genuine and the signer is
        // simply not the one that was demanded — untrusted, not tampered.
        if (err instanceof Error && err.name === 'PolicyError') {
            return undecided(`sigstore identity does not match the required policy: ${err.message}`);
        }
        return result('invalid', `sigstore verification failed: ${message(err)}`, chain, extra);
    }
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
 * The inverse: render a marker for the EOCD comment. Field order is fixed by
 * insertion, and a field whose value is empty or absent is left out entirely.
 */
export function formatSignature({ hash, sig, fields }: {
    hash: string;
    sig: string;
    fields?: Record<string, string | undefined | null> | undefined;
}): string {
    const parts = [`SIGNED:${hash}:${sig}`];
    for (const [name, value] of Object.entries(fields ?? {})) {
        if (value === undefined || value === null || value === '') continue;
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`invalid signature field name: ${name}`);
        if (String(value).includes(':')) throw new Error(`signature field '${name}' may not contain ':'`);
        parts.push(`${name.toUpperCase()}=${value}`);
    }
    return parts.join(':');
}

/**
 * The signature marker carried by `source`, or null when it carries none —
 * including when it is not a ZIP at all. Reads only the tail of the file, so it
 * is cheap enough to use as a "does this claim to be one of ours?" test before
 * committing to a full verification.
 */
export function signatureOf(source: ArchiveSource): SignatureMarker | null {
    try {
        const io = Buffer.isBuffer(source) ? bufferSource(source) : pathSource(source);
        return parseSignature(locateEocd(io.tail(), io.size).comment.toString('ascii'));
    } catch {
        return null;
    }
}

// Where the bytes come from, abstracted over "a path" and "a Buffer": a
// statable size, a tail read for the EOCD, a chunked hash feed for the signed
// region, and an archive opener.
interface Source {
    size: number;
    tail(): Buffer;
    feed(sink: CRYPTO.Hash, end: number): void;
    open(): ZLIB.ZipFile | ZLIB.ZipBuffer;
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

// Find the end-of-central-directory record in `tail` (the last bytes of a file
// of total length `size`) and return { start, comment } with `start` absolute.
// The EOCD must be the last structure in the file, so its comment runs to EOF.
function locateEocd(tail: Buffer, size: number): { start: number; comment: Buffer } {
    const floor = Math.max(0, tail.length - (22 + 0xffff));
    const scan = (exact: boolean) => {
        for (let pos = tail.length - 22; pos >= floor; pos--) {
            if (tail.readUInt32LE(pos) !== SIG_EOCD) continue;
            const end = pos + 22 + tail.readUInt16LE(pos + 20);
            if (exact ? end !== tail.length : end > tail.length) continue;
            return pos;
        }
        return -1;
    };
    let pos = scan(true);
    if (pos < 0) pos = scan(false);
    if (pos < 0) throw new Error('no end of central directory record found');
    const clen = tail.readUInt16LE(pos + 20);
    return { start: size - tail.length + pos, comment: tail.subarray(pos + 22, pos + 22 + clen) };
}

function openArchive(path: string): ZLIB.ZipFile {
    try {
        return ZLIB.ZipFile.openSync(path);
    } catch (err) {
        // A path that is itself a mount point resolves to the mounted tree
        // rather than to bytes, and opening a directory as a ZIP fails deep
        // inside with a confusing message. (A container's *own* path is not one
        // of these: `--vfs-mount` leaves it readable, which is what lets a
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

function result(
    state: VerificationState,
    reason: string,
    chain?: CRYPTO.X509Certificate[],
    extra?: Partial<VerificationResult>,
): VerificationResult {
    return {
        state,
        reason,
        subject: chain && chain[0] ? chain[0].subject : undefined,
        signed: state !== 'unsigned',
        trusted: state === 'valid',
        ...extra,
    };
}

function trustRoots(extra: string[] | undefined): CRYPTO.X509Certificate[] {
    const pems = [...cas('system'), ...cas('extra'), ...(extra || [])];
    return pems.map((pem) => new CRYPTO.X509Certificate(pem));
}

function cas(type: 'system' | 'extra'): string[] {
    try {
        return TLS.getCACertificates(type) || [];
    } catch {
        return [];
    }
}

function within(cert: CRYPTO.X509Certificate, now: number): boolean {
    return Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
}

// Path validation: every link in the supplied chain must be issuer-signed and
// in-date, and the top of the chain must be, or be issued by, a trusted root.
function anchored(chain: CRYPTO.X509Certificate[], roots: CRYPTO.X509Certificate[], now: number): boolean {
    for (const cert of chain) if (!within(cert, now)) return false;
    for (let i = 0; i < chain.length - 1; i++) {
        if (!chain[i]!.checkIssued(chain[i + 1]!)) return false;
        if (!chain[i]!.verify(chain[i + 1]!.publicKey)) return false;
    }
    const top = chain[chain.length - 1];
    if (!top) return false;
    for (const root of roots) {
        if (top.fingerprint256 === root.fingerprint256) return true;
        if (top.checkIssued(root) && top.verify(root.publicKey) && within(root, now)) return true;
    }
    return false;
}

/** An error's message, for errors that arrive as `unknown`. */
export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
