import * as ZLIB from 'node:zlib';
import * as PATH from 'node:path';
import * as FS from 'node:fs';
import * as CRYPTO from 'node:crypto';
import { Transform } from 'node:stream';
import { buildManifest, formatSignature, AUTHORITY } from './manifest.js';

// Building an archive, in two steps that are deliberately separable.
//
// `bundle()` collects files off disk into an unsigned archive. `rebundle()`
// takes an existing archive and re-emits it — with a different prefix, a
// different certificate, or both. Signing is only ever `rebundle()`'s job.
//
// That split is what makes one build serve every shape. The offsets inside a
// ZIP central directory are absolute, so an archive that will sit behind a
// 155 MB node binary is not byte-identical to the same archive behind a 79-byte
// shebang: the prefix has to be chosen before the offsets are fixed, and
// therefore before the hash exists. Re-emitting from the members rather than
// copying bytes is what lets one `app.bundle` become a `#!` launcher, a
// self-contained executable and a plain mountable archive, each correctly
// offset and each signed over its own finished bytes:
//
//   bundle   → app.bundle                        (unsigned, the source of truth)
//   rebundle → app.run   (prefix: shell-base)    signed
//   rebundle → app.sea   (prefix: node-base)     signed
//   rebundle → app.bundle.signed (no prefix)     signed
//
// A signer is `{ chain, signAlg, sign(digest) }`: the chain goes into
// `AUTHORITY.PEM` *before* hashing, and `sign()` is called *after*, with the
// finished hash. `keySigner()` below is the offline-CA implementation;
// `sigstore.js` provides the other one. Nothing here knows which it has.

// Members, as `{ name, data, mode }`. Two sources: a directory plus a file
// list, or an existing archive.
//
// `AUTHORITY.PEM` is never carried across from a source archive — it describes
// the signing of the archive it came from, and a re-emitted archive gets a
// fresh one.
export async function *fromDirectory(base, files) {
    for (const name of files) {
        yield { name, data: FS.readFileSync(PATH.resolve(base, name)), mode: 0o444 };
    }
}

export async function *fromArchive(zip) {
    for (const [name, entry] of zip.entriesSync()) {
        if (name === AUTHORITY || entry.isDirectory) continue;
        yield { name, data: entry.contentSync(), mode: entry.mode || 0o444 };
    }
}

// Yields a ZipEntry per member — each stamped, in its entry comment, with the
// hex digest of its own content — then a final `AUTHORITY.PEM` manifest entry
// declaring the algorithms and (when signing) carrying the certificate chain.
// Members are small (an application's own files; the heavy runtime is the
// prepended prefix, not an archive member), so each is held whole to hash it
// before the entry, whose comment must be fixed at creation time, is built.
async function *entries(members, { hashAlg, signAlg, chain }) {
    for await (const { name, data, mode } of members) {
        const digest = CRYPTO.createHash(hashAlg).update(data).digest('hex');
        yield await ZLIB.ZipEntry.create(name, data, { mode: mode ?? 0o444, comment: digest });
    }
    yield await ZLIB.ZipEntry.create(AUTHORITY, buildManifest({ hashAlg, signAlg, chain }), { mode: 0o444 });
}

// Returns a Readable of the ZIP archive over `members`. Its members carry
// per-file digests and its AUTHORITY.PEM manifest declares the algorithms and
// chain, but the archive itself is left with an empty EOCD comment: the
// whole-file hash and its signature are a property of the finished file and are
// applied by `emit()`. `baseOffset` seeds the archive's internal offsets for
// when it is appended after a prefix.
export function createArchive({ members, base, files, hashAlg = 'sha256', signAlg, chain, baseOffset = 0 }) {
    const source = members ?? fromDirectory(base, files);
    return ZLIB.createZipArchive(entries(source, { hashAlg, signAlg, chain }), { baseOffset });
}

// A signer backed by a private key and a certificate chain already on disk —
// the offline-CA path, and the shape `sigstore.js` implements too.
export function keySigner({ key, chain, signAlg = 'sha256' }) {
    return {
        kind: 'key',
        chain: String(chain),
        signAlg,
        async sign(digest) {
            return { signature: Buffer.from(CRYPTO.sign(signAlg, digest, key)) };
        },
    };
}

// Writes `prefix` (when given) then the archive to `out`, without closing
// `out`. With no prefix the result is a plain archive — a `.bundle` meant to be
// run through `--vfs-mount`; with one it is a self-running container (a shebang
// launcher or a SEA binary) that carries the same archive in its tail. When a
// `signer` is given, the whole file is signed. The hash runs over the prefix
// and then over the archive up to (but not including) the EOCD comment; that
// hash is what the signer signs. The EOCD comment records both, so a verifier
// can validate the hash on its own (a cheap pre-mount integrity gate) and only
// then check the signature over that hash against the certificate:
//
//   SIGNED:<hash-of-region-hex>:<signature-hex>[:<NAME>=<value>]*
//
// Returns { hash, signed } when the file has been fully written.
async function emit({ members, prefix, hashAlg = 'sha256', signer, out }) {
    const hasher = signer ? CRYPTO.createHash(hashAlg) : null;

    // 1. Stream the prefix straight to `out`, feeding the whole-file hash.
    if (prefix) await prepend(prefix, out, hasher);

    // 2. Build the archive (small) with an empty EOCD comment, in memory. The
    //    chain has to be embedded here, before anything is hashed — which is
    //    why a signer hands over its certificate up front and signs later.
    const archive = await collect(createArchive({
        members, hashAlg,
        signAlg: signer?.signAlg,
        chain: signer?.chain,
        baseOffset: prefix ? FS.statSync(prefix).size : 0,
    }));

    if (!signer) {
        await write(out, archive);
        return { hash: null, signed: false };
    }

    // 3. The signed region is the prefix plus the archive minus its trailing
    //    2-byte (empty) comment-length field. Hash it, sign the hash, and
    //    re-emit the archive with the marker as the EOCD comment. Anything the
    //    signer produced *after* signing — a transparency-log entry, a
    //    timestamp — comes back as fields and rides in the same comment, since
    //    it could not have been inside the hash it postdates.
    const region = archive.subarray(0, archive.length - 2);
    hasher.update(region);
    const digest = hasher.digest();
    const { signature, fields } = await signer.sign(digest);

    const marker = formatSignature({
        hash: digest.toString('hex'),
        sig: Buffer.from(signature).toString('hex'),
        fields,
    });
    const comment = Buffer.from(marker, 'ascii');
    if (comment.length > 0xffff) {
        throw new Error(`signature marker is ${comment.length} bytes; a ZIP comment holds at most 65535`);
    }
    const length = Buffer.alloc(2);
    length.writeUInt16LE(comment.length, 0);
    await write(out, Buffer.concat([region, length, comment]));
    return { hash: digest.toString('hex'), signed: true };
}

// Build an archive from files on disk. `key`/`chain` are accepted as a
// shorthand for `signer: keySigner({ key, chain, signAlg })`, so the
// create-and-sign-in-one-step path stays available.
export async function bundle({ base, files, prefix, hashAlg = 'sha256', signAlg = 'sha256', key, chain, signer, out }) {
    const active = signer ?? (key && chain ? keySigner({ key, chain, signAlg }) : undefined);
    return emit({ members: fromDirectory(base, files), prefix, hashAlg, signer: active, out });
}

// Re-emit an existing archive: same members, new prefix, new signature. This is
// what `bundle sign` runs. `source` is a path to an archive (signed or not,
// prefixed or not) — its members are read out, its old AUTHORITY.PEM is
// dropped, and everything is laid down again at the offsets the new prefix
// implies before the result is hashed and signed as a whole.
export async function rebundle({ source, prefix, hashAlg = 'sha256', signAlg = 'sha256', key, chain, signer, out }) {
    const active = signer ?? (key && chain ? keySigner({ key, chain, signAlg }) : undefined);
    const zip = ZLIB.ZipFile.openSync(PATH.resolve(source));
    try {
        // The member list is drained into memory before writing starts: the
        // source archive may be the file being overwritten, and in any case the
        // entries have to outlive the ZipFile handle closed below.
        const members = [];
        for await (const member of fromArchive(zip)) members.push(member);
        if (!members.length) throw new Error(`'${source}' contains no members to sign`);
        return await emit({ members, prefix, hashAlg, signer: active, out });
    } finally {
        zip.closeSync();
    }
}

// The member names an archive holds, in order, excluding AUTHORITY.PEM — for
// reporting what is about to be re-signed without reading every member's bytes.
export function members(source) {
    const zip = ZLIB.ZipFile.openSync(PATH.resolve(source));
    try {
        return [...zip.entriesSync()]
            .filter(([name, entry]) => name !== AUTHORITY && !entry.isDirectory)
            .map(([name]) => name);
    } finally {
        zip.closeSync();
    }
}

function prepend(file, out, sink) {
    return new Promise((resolve, reject) => {
        const tap = new Transform({
            transform(chunk, _enc, cb) { if (sink) sink.update(chunk); cb(null, chunk); },
        });
        FS.createReadStream(file).on('error', reject)
            .pipe(tap).on('error', reject).on('end', resolve)
            .pipe(out, { end: false });
    });
}

async function collect(readable) {
    const chunks = [];
    for await (const chunk of readable) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function write(out, buffer) {
    return new Promise((resolve, reject) => out.write(buffer, (err) => err ? reject(err) : resolve()));
}
