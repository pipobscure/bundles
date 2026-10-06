import * as CRYPTO from 'node:crypto';

// Checking an atproto repository proof with nothing but `node:crypto`.
//
// An atproto repository is a Merkle Search Tree of records whose root is named
// by a *commit*, and the commit is signed with the key the account's DID
// document publishes as `#atproto`. `com.atproto.sync.getRecord` answers with
// exactly the slice of that structure needed to prove one record: a CAR file
// holding the signed commit, the tree nodes on the path from the root down to
// the record's key, and the record itself. Or, when the record does not exist,
// the same path ending where the key would have been — a proof of absence.
//
// Everything in here is synchronous and pure, because the verifying mount is:
// it decides whether to serve an archive before any of the program in it runs,
// and it cannot await. Fetching a proof is `atproto.ts`'s job; this file only
// ever answers "does this proof, against this key, say what it claims to?".
//
// The checks, in the order they run:
//
//   1. Every block's bytes hash to the CID it is filed under. Nothing below
//      trusts a block that has not been checked this way, so the CAR can come
//      from anyone — a PDS, a mirror, a cache on disk.
//   2. The commit names the expected DID, and its signature verifies against
//      the DID's key over the commit re-encoded without its `sig` field. The
//      re-encoding is canonical DAG-CBOR; a commit that was not canonical in
//      the first place fails here, which is the strict answer.
//   3. The tree is walked from the commit's `data` root to the key. Each step
//      follows a CID out of an already-verified block, so the walk is anchored
//      in the signature all the way down. A missing block is an incomplete
//      proof, not an absent record.
//   4. The record block found there is decoded and returned.
//
// Only the subset of DAG-CBOR that atproto uses is supported — definite
// lengths, text map keys, tag 42 for links — and only CIDv1 with sha-256,
// which is all a repository contains.

// --------------------------------------------------------------- encodings ---

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base32(bytes: Uint8Array): string {
    let out = '';
    let bits = 0;
    let value = 0;
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

function unbase32(text: string): Buffer {
    const out: number[] = [];
    let bits = 0;
    let value = 0;
    for (const char of text) {
        const index = BASE32.indexOf(char);
        if (index < 0) throw new Error(`not base32: '${char}'`);
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function unbase58(text: string): Buffer {
    let value = 0n;
    for (const char of text) {
        const index = BASE58.indexOf(char);
        if (index < 0) throw new Error(`not base58: '${char}'`);
        value = value * 58n + BigInt(index);
    }
    const hex = value === 0n ? '' : value.toString(16);
    const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    let zeros = 0;
    while (zeros < text.length && text[zeros] === '1') zeros++;
    return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** An unsigned LEB128 varint at `offset`: its value, and where it ends. */
function varint(bytes: Uint8Array, offset: number): [number, number] {
    let value = 0;
    let shift = 0;
    for (let pos = offset; pos < bytes.length; pos++) {
        const byte = bytes[pos]!;
        value += (byte & 0x7f) * 2 ** shift;
        if (!(byte & 0x80)) return [value, pos + 1];
        shift += 7;
        if (shift > 49) break;
    }
    throw new Error('malformed varint');
}

// -------------------------------------------------------------------- CIDs ---

const DAG_CBOR = 0x71;
const RAW = 0x55;
const SHA256 = 0x12;

/** A content identifier: CIDv1, sha-256, over DAG-CBOR or raw bytes. */
export class CID {
    readonly bytes: Buffer;
    readonly codec: number;
    readonly digest: Buffer;

    private constructor(bytes: Buffer, codec: number, digest: Buffer) {
        this.bytes = bytes;
        this.codec = codec;
        this.digest = digest;
    }

    /** Parse a binary CID from the start of `bytes`; returns it and its length. */
    static read(bytes: Uint8Array, offset = 0): [CID, number] {
        const [version, a] = varint(bytes, offset);
        if (version !== 1) throw new Error(`unsupported CID version ${version}`);
        const [codec, b] = varint(bytes, a);
        const [hash, c] = varint(bytes, b);
        const [length, d] = varint(bytes, c);
        if (hash !== SHA256 || length !== 32) throw new Error('unsupported CID hash: only sha-256 is used in a repository');
        if (d + length > bytes.length) throw new Error('truncated CID');
        const raw = Buffer.from(bytes.subarray(offset, d + length));
        return [new CID(raw, codec, Buffer.from(bytes.subarray(d, d + length))), d + length - offset];
    }

    static decode(bytes: Uint8Array): CID {
        const [cid, length] = CID.read(bytes);
        if (length !== bytes.length) throw new Error('trailing bytes after CID');
        return cid;
    }

    /** The `b…` base32 string form a PDS prints. */
    static parse(text: string): CID {
        if (!text.startsWith('b')) throw new Error(`unsupported CID string '${text}': expected base32 (b…)`);
        return CID.decode(unbase32(text.slice(1)));
    }

    /** The CID of `bytes` as a DAG-CBOR block. */
    static of(bytes: Uint8Array, codec = DAG_CBOR): CID {
        const digest = CRYPTO.createHash('sha256').update(bytes).digest();
        return CID.decode(Buffer.from([1, codec, SHA256, 32, ...digest]));
    }

    /** Whether `bytes` are the block this CID names. */
    matches(bytes: Uint8Array): boolean {
        if (this.codec !== DAG_CBOR && this.codec !== RAW) return false;
        return CRYPTO.createHash('sha256').update(bytes).digest().equals(this.digest);
    }

    equals(other: CID | null | undefined): boolean {
        return Boolean(other) && this.bytes.equals(other!.bytes);
    }

    toString(): string {
        return `b${base32(this.bytes)}`;
    }

    toJSON(): { $link: string } {
        return { $link: this.toString() };
    }
}

// ----------------------------------------------------------------- DAG-CBOR ---

/** What DAG-CBOR decodes to here. */
export type Value = null | boolean | number | string | Uint8Array | CID | Value[] | { [key: string]: Value };

/** Decode one DAG-CBOR value that must occupy all of `bytes`. */
export function decode(bytes: Uint8Array): Value {
    const [value, end] = decodeAt(bytes, 0, 0);
    if (end !== bytes.length) throw new Error('trailing bytes after DAG-CBOR value');
    return value;
}

/** Decode one DAG-CBOR value from the start of `bytes`; returns it and where it ends. */
export function decodeFirst(bytes: Uint8Array): [Value, number] {
    return decodeAt(bytes, 0, 0);
}

function decodeAt(bytes: Uint8Array, offset: number, depth: number): [Value, number] {
    if (depth > 64) throw new Error('DAG-CBOR nested too deeply');
    if (offset >= bytes.length) throw new Error('truncated DAG-CBOR');
    const initial = bytes[offset]!;
    const major = initial >> 5;
    const info = initial & 31;
    let pos = offset + 1;

    if (major === 7) {
        switch (info) {
            case 20: return [false, pos];
            case 21: return [true, pos];
            case 22: return [null, pos];
            case 25: case 26: case 27: {
                const size = info === 25 ? 2 : info === 26 ? 4 : 8;
                if (pos + size > bytes.length) throw new Error('truncated DAG-CBOR float');
                const view = Buffer.from(bytes.buffer, bytes.byteOffset + pos, size);
                const value = size === 2 ? half(view.readUInt16BE(0)) : size === 4 ? view.readFloatBE(0) : view.readDoubleBE(0);
                return [value, pos + size];
            }
            default: throw new Error(`unsupported DAG-CBOR simple value ${info}`);
        }
    }

    let length: number;
    if (info < 24) {
        length = info;
    } else if (info <= 27) {
        const size = 1 << (info - 24);
        if (pos + size > bytes.length) throw new Error('truncated DAG-CBOR');
        const view = Buffer.from(bytes.buffer, bytes.byteOffset + pos, size);
        if (size === 8) {
            const big = view.readBigUInt64BE(0);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DAG-CBOR integer out of range');
            length = Number(big);
        } else {
            length = size === 1 ? view.readUInt8(0) : size === 2 ? view.readUInt16BE(0) : view.readUInt32BE(0);
        }
        pos += size;
    } else {
        throw new Error('indefinite-length DAG-CBOR is not allowed');
    }

    switch (major) {
        case 0: return [length, pos];
        case 1: return [-1 - length, pos];
        case 2: case 3: {
            if (pos + length > bytes.length) throw new Error('truncated DAG-CBOR string');
            const slice = bytes.subarray(pos, pos + length);
            return [major === 2 ? Buffer.from(slice) : Buffer.from(slice).toString('utf-8'), pos + length];
        }
        case 4: {
            const items: Value[] = [];
            for (let i = 0; i < length; i++) {
                const [item, next] = decodeAt(bytes, pos, depth + 1);
                items.push(item);
                pos = next;
            }
            return [items, pos];
        }
        case 5: {
            const map: { [key: string]: Value } = Object.create(null) as { [key: string]: Value };
            for (let i = 0; i < length; i++) {
                const [key, afterKey] = decodeAt(bytes, pos, depth + 1);
                if (typeof key !== 'string') throw new Error('DAG-CBOR map keys must be strings');
                if (Object.hasOwn(map, key)) throw new Error(`duplicate DAG-CBOR map key '${key}'`);
                const [value, afterValue] = decodeAt(bytes, afterKey, depth + 1);
                map[key] = value;
                pos = afterValue;
            }
            return [map, pos];
        }
        case 6: {
            if (length !== 42) throw new Error(`unsupported DAG-CBOR tag ${length}`);
            const [content, next] = decodeAt(bytes, pos, depth + 1);
            if (!(content instanceof Uint8Array) || content[0] !== 0) throw new Error('malformed DAG-CBOR link');
            return [CID.decode(content.subarray(1)), next];
        }
        default: throw new Error(`unsupported DAG-CBOR major type ${major}`);
    }
}

function half(bits: number): number {
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    const sign = bits & 0x8000 ? -1 : 1;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Encode a value as canonical DAG-CBOR: shortest-form lengths, map keys sorted
 * by length and then bytewise, no floats. Used to rebuild the unsigned commit a
 * signature covers, and to build test fixtures.
 */
export function encode(value: Value | undefined): Buffer {
    const parts: Buffer[] = [];
    encodeInto(value, parts);
    return Buffer.concat(parts);
}

function head(major: number, length: number): Buffer {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) {
        const buf = Buffer.alloc(3);
        buf[0] = (major << 5) | 25;
        buf.writeUInt16BE(length, 1);
        return buf;
    }
    if (length < 0x100000000) {
        const buf = Buffer.alloc(5);
        buf[0] = (major << 5) | 26;
        buf.writeUInt32BE(length, 1);
        return buf;
    }
    const buf = Buffer.alloc(9);
    buf[0] = (major << 5) | 27;
    buf.writeBigUInt64BE(BigInt(length), 1);
    return buf;
}

function encodeInto(value: Value | undefined, parts: Buffer[]): void {
    if (value === null) { parts.push(Buffer.from([0xf6])); return; }
    if (value === true) { parts.push(Buffer.from([0xf5])); return; }
    if (value === false) { parts.push(Buffer.from([0xf4])); return; }
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw new Error('DAG-CBOR here carries integers only');
        parts.push(value >= 0 ? head(0, value) : head(1, -1 - value));
        return;
    }
    if (typeof value === 'string') {
        const bytes = Buffer.from(value, 'utf-8');
        parts.push(head(3, bytes.length), bytes);
        return;
    }
    if (value instanceof CID) {
        const content = Buffer.concat([Buffer.from([0]), value.bytes]);
        parts.push(Buffer.from([0xd8, 42]), head(2, content.length), content);
        return;
    }
    if (value instanceof Uint8Array) {
        parts.push(head(2, value.length), Buffer.from(value));
        return;
    }
    if (Array.isArray(value)) {
        parts.push(head(4, value.length));
        for (const item of value) encodeInto(item, parts);
        return;
    }
    if (value === undefined) throw new Error('DAG-CBOR cannot encode undefined');
    const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [Buffer.from(key, 'utf-8'), item] as const)
        .sort(([a], [b]) => a.length - b.length || Buffer.compare(a, b));
    parts.push(head(5, entries.length));
    for (const [key, item] of entries) {
        parts.push(head(3, key.length), key);
        encodeInto(item, parts);
    }
}

// --------------------------------------------------------------------- CAR ---

/** A CAR v1 file: its roots, and every block in it, each checked against its CID. */
export interface Car {
    roots: CID[];
    blocks: Map<string, Buffer>;
}

/**
 * Read a CAR v1 file. Every block is hashed and compared with the CID it is
 * filed under as it is read, so what comes back can be trusted to *be* the
 * blocks those CIDs name — whatever delivered the file.
 */
export function readCar(bytes: Uint8Array): Car {
    const [headerLength, start] = varint(bytes, 0);
    if (start + headerLength > bytes.length) throw new Error('truncated CAR header');
    const header = decode(bytes.subarray(start, start + headerLength)) as { version?: Value; roots?: Value };
    if (header.version !== 1) throw new Error(`unsupported CAR version ${String(header.version)}`);
    if (!Array.isArray(header.roots) || !header.roots.every((root) => root instanceof CID)) {
        throw new Error('CAR header carries no roots');
    }

    const blocks = new Map<string, Buffer>();
    let pos = start + headerLength;
    while (pos < bytes.length) {
        const [length, body] = varint(bytes, pos);
        const end = body + length;
        if (end > bytes.length) throw new Error('truncated CAR block');
        const [cid, cidLength] = CID.read(bytes, body);
        const data = Buffer.from(bytes.subarray(body + cidLength, end));
        if (!cid.matches(data)) throw new Error(`CAR block does not hash to its CID ${cid.toString()}`);
        blocks.set(cid.toString(), data);
        pos = end;
    }
    return { roots: header.roots as CID[], blocks };
}

/** Write a CAR v1 file — for tests, and for anything that wants to re-serve a proof. */
export function writeCar(roots: CID[], blocks: Iterable<[CID, Uint8Array]>): Buffer {
    const header = encode({ version: 1, roots });
    const parts: Buffer[] = [uvarint(header.length), header];
    for (const [cid, data] of blocks) {
        parts.push(uvarint(cid.bytes.length + data.length), cid.bytes, Buffer.from(data));
    }
    return Buffer.concat(parts);
}

function uvarint(value: number): Buffer {
    const out: number[] = [];
    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value > 0) byte |= 0x80;
        out.push(byte);
    } while (value > 0);
    return Buffer.from(out);
}

// --------------------------------------------------------------------- keys ---

/** The curves atproto signs with. */
export type Curve = 'secp256k1' | 'P-256';

/** A verifying key, with the curve it is on. */
export interface PublicKey {
    curve: Curve;
    key: CRYPTO.KeyObject;
}

// Multicodec prefixes for compressed public keys, as varints.
const SECP256K1_PUB = 0xe7;
const P256_PUB = 0x1200;

/**
 * The key a `publicKeyMultibase` names. `Multikey` values carry a multicodec
 * prefix saying which curve; the two older verification-method types name the
 * curve in the type instead and carry the bare compressed point.
 */
export function parseMultikey(multibase: string, type = 'Multikey'): PublicKey {
    if (!multibase.startsWith('z')) throw new Error('publicKeyMultibase must be base58btc (z…)');
    const raw = unbase58(multibase.slice(1));
    let curve: Curve;
    let point: Buffer;
    if (type === 'Multikey') {
        const [codec, offset] = varint(raw, 0);
        if (codec === SECP256K1_PUB) curve = 'secp256k1';
        else if (codec === P256_PUB) curve = 'P-256';
        else throw new Error(`unsupported key type (multicodec 0x${codec.toString(16)})`);
        point = raw.subarray(offset);
    } else if (type === 'EcdsaSecp256k1VerificationKey2019') {
        curve = 'secp256k1';
        point = raw;
    } else if (type === 'EcdsaSecp256r1VerificationKey2019') {
        curve = 'P-256';
        point = raw;
    } else {
        throw new Error(`unsupported verification method type '${type}'`);
    }
    return { curve, key: pointKey(curve, point) };
}

/** A key object from a compressed (or uncompressed) EC point. */
export function pointKey(curve: Curve, point: Uint8Array): CRYPTO.KeyObject {
    const name = curve === 'P-256' ? 'prime256v1' : 'secp256k1';
    const full = CRYPTO.ECDH.convertKey(Buffer.from(point), name, undefined, undefined, 'uncompressed') as Buffer;
    if (full.length !== 65 || full[0] !== 4) throw new Error('malformed EC public key');
    return CRYPTO.createPublicKey({
        format: 'jwk',
        key: {
            kty: 'EC',
            crv: curve,
            x: full.subarray(1, 33).toString('base64url'),
            y: full.subarray(33).toString('base64url'),
        },
    });
}

/** The compressed point of a public key, for building `publicKeyMultibase` values. */
export function compressedPoint(key: CRYPTO.KeyObject): Buffer {
    const jwk = key.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url');
    const y = Buffer.from(jwk.y!, 'base64url');
    return Buffer.concat([Buffer.from([(y[y.length - 1]! & 1) ? 3 : 2]), x]);
}

/** `publicKeyMultibase` for a key, as a `Multikey` — the inverse of `parseMultikey`. */
export function formatMultikey(curve: Curve, key: CRYPTO.KeyObject): string {
    const prefix = uvarint(curve === 'P-256' ? P256_PUB : SECP256K1_PUB);
    return `z${base58(Buffer.concat([prefix, compressedPoint(key)]))}`;
}

function base58(bytes: Uint8Array): string {
    let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
    let out = '';
    while (value > 0n) {
        out = BASE58[Number(value % 58n)] + out;
        value /= 58n;
    }
    for (const byte of bytes) {
        if (byte !== 0) break;
        out = `1${out}`;
    }
    return out;
}

// Group orders, for the low-S rule: atproto signatures must use the lower of
// the two valid `s` values, so a signature cannot be re-encoded into a second
// valid one.
const ORDER: Record<Curve, bigint> = {
    'secp256k1': 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    'P-256': 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
};

/** Check a 64-byte compact, low-S ECDSA signature over sha-256 of `data`. */
export function verifySignature(key: PublicKey, data: Uint8Array, signature: Uint8Array): boolean {
    if (signature.length !== 64) return false;
    const s = BigInt(`0x${Buffer.from(signature.subarray(32)).toString('hex')}`);
    if (s > ORDER[key.curve] / 2n) return false;
    try {
        return CRYPTO.verify('sha256', data, { key: key.key, dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
        return false;
    }
}

/** Sign the way a PDS signs a commit: compact, low-S. For tests and fixtures. */
export function sign(curve: Curve, privateKey: CRYPTO.KeyObject, data: Uint8Array): Buffer {
    const signature = CRYPTO.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const order = ORDER[curve];
    const s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
    if (s <= order / 2n) return signature;
    const low = (order - s).toString(16).padStart(64, '0');
    return Buffer.concat([signature.subarray(0, 32), Buffer.from(low, 'hex')]);
}

// ------------------------------------------------------------- DID documents ---

/** What a DID document says that matters here. */
export interface DidDocument {
    id: string;
    alsoKnownAs?: string[] | undefined;
    verificationMethod?: { id: string; type: string; controller?: string; publicKeyMultibase?: string }[] | undefined;
    service?: { id: string; type: string; serviceEndpoint: string | Record<string, unknown> }[] | undefined;
}

// A verification method or service id may be absolute (`did:…#atproto`) or
// relative to the document (`#atproto`); both mean the same entry.
function named(id: string, did: string, fragment: string): boolean {
    return id === `#${fragment}` || id === `${did}#${fragment}`;
}

/** The repository signing key a DID document publishes, as `#atproto`. */
export function signingKey(doc: DidDocument): PublicKey {
    const method = (doc.verificationMethod ?? []).find((entry) => named(entry.id, doc.id, 'atproto'));
    if (!method?.publicKeyMultibase) throw new Error(`${doc.id} publishes no #atproto signing key`);
    return parseMultikey(method.publicKeyMultibase, method.type);
}

/** The PDS a DID document names, as `#atproto_pds`. */
export function pdsEndpoint(doc: DidDocument): string {
    const service = (doc.service ?? []).find((entry) => named(entry.id, doc.id, 'atproto_pds'));
    const endpoint = service?.serviceEndpoint;
    if (typeof endpoint !== 'string') throw new Error(`${doc.id} names no #atproto_pds service`);
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${doc.id}: PDS endpoint is not http(s)`);
    return url.origin;
}

/** The handle a DID document claims, if any — for display; it proves nothing. */
export function claimedHandle(doc: DidDocument): string | undefined {
    const aka = (doc.alsoKnownAs ?? []).find((entry) => entry.startsWith('at://'));
    return aka?.slice('at://'.length);
}

// ------------------------------------------------------------------ proofs ---

/** What a verified record proof establishes. */
export interface RecordProof {
    did: string;
    /** The repository revision the commit is at. */
    rev: string;
    /** The commit the proof is anchored in. */
    commit: CID;
    /** The record, or null when the proof shows there is none at that key. */
    record: { cid: CID; value: Value } | null;
}

/**
 * Check a `com.atproto.sync.getRecord` CAR against the repository key of `did`,
 * and return what it proves about `collection/rkey`. Throws if the proof does
 * not hold together; returns `record: null` for a valid proof of absence.
 */
export function verifyRecordProof(car: Uint8Array | Car, { did, key, collection, rkey }: {
    did: string;
    key: PublicKey;
    collection: string;
    rkey: string;
}): RecordProof {
    const { roots, blocks } = car instanceof Uint8Array ? readCar(car) : car;
    const root = roots[0];
    if (!root || roots.length !== 1) throw new Error('a record proof has exactly one root, the commit');
    const commitBytes = blocks.get(root.toString());
    if (!commitBytes) throw new Error('record proof does not carry its commit');

    const commit = decode(commitBytes) as Record<string, Value>;
    if (commit['did'] !== did) throw new Error(`proof is a commit of ${String(commit['did'])}, not ${did}`);
    if (commit['version'] !== 3 && commit['version'] !== 2) throw new Error(`unsupported commit version ${String(commit['version'])}`);
    const data = commit['data'];
    const rev = commit['rev'];
    const sig = commit['sig'];
    if (!(data instanceof CID)) throw new Error('commit carries no data root');
    if (typeof rev !== 'string') throw new Error('commit carries no revision');
    if (!(sig instanceof Uint8Array)) throw new Error('commit is not signed');

    const unsigned: Record<string, Value> = { ...commit };
    delete unsigned['sig'];
    if (!verifySignature(key, encode(unsigned), sig)) {
        throw new Error(`commit signature does not verify against ${did}'s #atproto key`);
    }

    const found = lookup(blocks, data, Buffer.from(`${collection}/${rkey}`, 'utf-8'));
    if (!found) return { did, rev, commit: root, record: null };
    const recordBytes = blocks.get(found.toString());
    if (!recordBytes) throw new Error('record proof does not carry the record itself');
    return { did, rev, commit: root, record: { cid: found, value: decode(recordBytes) } };
}

// Walk the Merkle Search Tree from `root` to `key`. A node is
// `{ l, e: [{ p, k, v, t }] }`: `l` is the subtree of keys before the first
// entry, each entry's key is the previous entry's first `p` bytes followed by
// `k`, `v` is the record it maps to, and `t` is the subtree of keys between it
// and the next entry.
function lookup(blocks: Map<string, Buffer>, root: CID, key: Buffer): CID | null {
    let node: CID | null = root;
    for (let depth = 0; node; depth++) {
        if (depth > 128) throw new Error('repository tree is implausibly deep');
        const bytes = blocks.get(node.toString());
        if (!bytes) throw new Error('record proof is incomplete: a tree node on the path is missing');
        const decoded = decode(bytes) as { l?: Value; e?: Value };
        const entries = decoded.e;
        if (!Array.isArray(entries)) throw new Error('malformed repository tree node');

        let next: CID | null = link(decoded.l);
        let previous = Buffer.alloc(0);
        for (const entry of entries) {
            const { p, k, v, t } = entry as { p?: Value; k?: Value; v?: Value; t?: Value };
            if (typeof p !== 'number' || !(k instanceof Uint8Array) || !(v instanceof CID)) {
                throw new Error('malformed repository tree entry');
            }
            if (p > previous.length) throw new Error('malformed repository tree entry prefix');
            const full = Buffer.concat([previous.subarray(0, p), k]);
            const order = Buffer.compare(key, full);
            if (order === 0) return v;
            if (order < 0) break;
            next = link(t);
            previous = full;
        }
        node = next;
    }
    return null;
}

function link(value: Value | undefined): CID | null {
    if (value === null || value === undefined) return null;
    if (!(value instanceof CID)) throw new Error('malformed repository tree link');
    return value;
}
