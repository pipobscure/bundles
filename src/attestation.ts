import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { verifyRecordProof, signingKey, claimedHandle, type DidDocument, type Value } from './repo.ts';

// Attestations: other people vouching for a bundle, as atproto records.
//
// A bundle is identified by its whole-file hash — the hash a signature covers.
// An attestation is a record in the attester's own repository whose key is that
// hash, saying "I vouch for these bytes", optionally with what kind of claim it
// is: published, audited, reproduced. Or the opposite — `verdict: "bad"`, with
// a kind like `malware` — which is a warning to anyone installing it, and a
// refusal under a policy that blocks on that attester. A policy names the DIDs
// whose attestations it requires, and how many of them; only good verdicts
// count towards that.
//
// This file is the offline half: the policy, the cache of proofs, and the check
// against them. It never touches the network, because the verifying mount
// cannot wait for one — fetching proofs into the cache is `atproto.ts`'s job,
// done ahead of time by `install`, `update`, `verify`, `run` and `trust`. Every
// proof is re-verified when it is read, so the cache holds evidence rather than
// conclusions; what it cannot vouch for itself is how recently that evidence
// was confirmed, which is why `maxAge` exists and the cache sits in a directory
// only its owner can write.
//
// See proposals/atproto-attestations.md for the reasoning.

/** The record type, and the collection attestations live in. */
export const COLLECTION = 'com.pipobscure.bundle.attestation';

/** How old a cached proof may be before it no longer counts (seven days). */
export const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** One required attester: a DID, and optionally the kind of claim it must make. */
export interface Attester {
    did: string;
    kind?: string | undefined;
}

/** What a verification demands of attestations. */
export interface AttestationPolicy {
    attesters: Attester[];
    /** How many of `attesters` must have attested (default: all of them). */
    quorum?: number | undefined;
    /** Milliseconds a cached proof stays good for (default: seven days). */
    maxAge?: number | undefined;
    /** Attesters whose bad verdict refuses the archive outright. */
    block?: Attester[] | undefined;
    /** The cache directory (default: `cacheDir()`). */
    cache?: string | undefined;
}

/** What an attestation says of the bytes: vouched for, or warned against. */
export type Verdict = 'good' | 'bad';

/** What was found for one required attester. */
export interface Attestation {
    did: string;
    /** The kind the policy required, if it required one. */
    kind?: string | undefined;
    /** The handle the DID document claims — for display only. */
    handle?: string | undefined;
    /** Whether this attester's requirement is met. */
    ok: boolean;
    reason: string;
    /** The kind the record declares. */
    attested?: string | undefined;
    /** Good unless the record says otherwise. */
    verdict?: Verdict | undefined;
    /** When the attester says they made it. */
    createdAt?: string | undefined;
    /** When this machine last confirmed the record was there. */
    checkedAt?: Date | undefined;
    /** The record's address. */
    uri: string;
}

/** The outcome of checking a policy against the cache. */
export interface AttestationOutcome {
    met: boolean;
    /** How many attesters had to be satisfied. */
    required: number;
    attestations: Attestation[];
    /** Bad verdicts from blocking attesters; any of these refuses the archive. */
    blocked: Attestation[];
    reason: string;
}

/** The record as it is written. */
export interface AttestationRecord {
    $type: typeof COLLECTION;
    /** `<alg>:<hex>` — the whole-file hash. */
    hash: string;
    kind?: string | undefined;
    /** Absent means good. */
    verdict?: Verdict | undefined;
    note?: string | undefined;
    createdAt: string;
}

// ------------------------------------------------------------------- policy ---

// The shapes a policy is written in, as pattern strings: the checks below use
// them, and so does the published JSON Schema for policy files, which a test
// holds to exactly these.

/** A DID this module can resolve: `did:plc:` or a hostname `did:web:`. */
export const DID_PATTERN = '^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9.%-]+)$';
/** An attestation kind: `audited`, `malware`, … */
export const KIND_PATTERN = '^[A-Za-z0-9._-]+$';
/** `[kind@]did`. */
export const ATTESTER_PATTERN = `^(?:${KIND_PATTERN.slice(1, -1)}@)?${DID_PATTERN.slice(1)}`;
/** `90s`, `30m`, `12h`, `7d`, or a bare number of seconds. */
export const DURATION_PATTERN = '^\\s*(\\d+(?:\\.\\d+)?)\\s*(s|m|h|d)?\\s*$';

/**
 * Parse `[kind@]<did or handle>`. A DID and a handle can both appear here; only
 * a DID can be verified against, so a caller that has the network resolves a
 * handle with `atproto.resolveAttester()` before the policy is used.
 */
export function parseAttester(spec: string): { subject: string; kind?: string | undefined } {
    const text = spec.trim();
    const at = text.indexOf('@');
    const kind = at > 0 ? text.slice(0, at) : undefined;
    const subject = at >= 0 ? text.slice(at + 1) : text;
    if (!subject) throw new Error(`'${spec}' names no attester`);
    if (kind !== undefined && !new RegExp(KIND_PATTERN).test(kind)) throw new Error(`'${kind}' is not a valid attestation kind`);
    return { subject, kind };
}

/** The inverse of `parseAttester`, for a resolved attester. */
export function formatAttester({ did, kind }: Attester): string {
    return kind ? `${kind}@${did}` : did;
}

/** Whether `text` is a DID this module can resolve: `did:plc:` or `did:web:`. */
export function isDid(text: string): boolean {
    return new RegExp(DID_PATTERN).test(text);
}

/** Parse attesters that must already be DIDs — what comes from the environment or a baked policy. */
export function attestersFrom(specs: string[] | undefined): Attester[] {
    return (specs ?? []).map((spec) => {
        const { subject, kind } = parseAttester(spec);
        if (!isDid(subject)) throw new Error(`attester '${subject}' must be a DID (did:plc:… or did:web:…) here`);
        return { did: subject, kind };
    });
}

/**
 * A duration: `90s`, `30m`, `12h`, `7d`, or a bare number of seconds. Returns
 * milliseconds.
 */
export function parseDuration(text: string): number {
    const m = new RegExp(DURATION_PATTERN).exec(text);
    if (!m) throw new Error(`'${text}' is not a duration (try 30m, 12h or 7d)`);
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? 's') as 's' | 'm' | 'h' | 'd'];
    return Math.round(Number(m[1]) * unit * 1000);
}

/**
 * The policy the environment describes, for the preload, which takes no
 * arguments: `BUNDLE_ATTESTERS` (space- or comma-separated `[kind@]did`),
 * `BUNDLE_QUORUM`, `BUNDLE_ATTESTATION_MAX_AGE`, and `BUNDLE_BLOCK` (DIDs whose
 * bad verdict refuses an archive).
 */
export function policyFromEnvironment(env: NodeJS.ProcessEnv = process.env): Omit<AttestationPolicy, 'cache'> {
    const list = (name: string) => attestersFrom((env[name] ?? '').split(/[\s,]+/).filter(Boolean));
    const quorum = env['BUNDLE_QUORUM'] ? Number(env['BUNDLE_QUORUM']) : undefined;
    const maxAge = env['BUNDLE_ATTESTATION_MAX_AGE'] ? parseDuration(env['BUNDLE_ATTESTATION_MAX_AGE']) : undefined;
    return { attesters: list('BUNDLE_ATTESTERS'), quorum, maxAge, block: list('BUNDLE_BLOCK') };
}

// -------------------------------------------------------------------- cache ---

/**
 * Where this tool keeps state: the install record, and the attestation cache
 * beside it. Per-user, and outside anything a bundle can write to.
 */
export function stateDir(): string {
    const home = OS.homedir();
    return process.platform === 'win32'
        ? PATH.join(process.env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local'), 'bundle', 'Data')
        : process.platform === 'darwin' ? PATH.join(home, 'Library', 'Application Support', 'bundle')
        : PATH.join(process.env['XDG_STATE_HOME'] || PATH.join(home, '.local', 'state'), 'bundle');
}

/** The attestation cache: `BUNDLE_ATTESTATIONS`, else `attestations/` in `stateDir()`. */
export function cacheDir(): string {
    const configured = process.env['BUNDLE_ATTESTATIONS'];
    return configured ? PATH.resolve(configured) : PATH.join(stateDir(), 'attestations');
}

/** A cached proof: the CAR, and when it was last confirmed. */
export interface CachedProof {
    checkedAt: Date;
    car: Buffer;
}

// One directory per DID. The DID is percent-encoded so that `did:web:` hosts
// with ports, and Windows' dislike of `:`, are both non-issues.
function didDir(cache: string, did: string): string {
    return PATH.join(cache, encodeURIComponent(did));
}

/** The DID document cached for `did`, or null. */
export function readDocument(cache: string, did: string): DidDocument | null {
    try {
        const doc = JSON.parse(FS.readFileSync(PATH.join(didDir(cache, did), 'did.json'), 'utf-8')) as DidDocument;
        return doc.id === did ? doc : null;
    } catch {
        return null;
    }
}

export function writeDocument(cache: string, doc: DidDocument): void {
    writeAtomic(PATH.join(didDir(cache, doc.id), 'did.json'), `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * The repository head — the latest commit's CID — at which the cache last
 * held everything `did` had attested, or null. While the repository is still
 * there, nothing it attested has changed, and nothing needs fetching.
 */
export function readHead(cache: string, did: string): string | null {
    try {
        const { commit } = JSON.parse(FS.readFileSync(PATH.join(didDir(cache, did), 'head.json'), 'utf-8')) as { commit?: unknown };
        return typeof commit === 'string' ? commit : null;
    } catch {
        return null;
    }
}

export function writeHead(cache: string, did: string, commit: string): void {
    writeAtomic(PATH.join(didDir(cache, did), 'head.json'), `${JSON.stringify({ commit })}\n`);
}

/** The cached proof for `did`'s record at `rkey`, or null. */
export function readProof(cache: string, did: string, rkey: string): CachedProof | null {
    try {
        const stored = JSON.parse(FS.readFileSync(proofPath(cache, did, rkey), 'utf-8')) as { checkedAt: string; car: string };
        return { checkedAt: new Date(stored.checkedAt), car: Buffer.from(stored.car, 'base64') };
    } catch {
        return null;
    }
}

export function writeProof(cache: string, did: string, rkey: string, proof: CachedProof): void {
    writeAtomic(proofPath(cache, did, rkey),
        `${JSON.stringify({ checkedAt: proof.checkedAt.toISOString(), car: proof.car.toString('base64') })}\n`);
}

export function removeProof(cache: string, did: string, rkey: string): void {
    FS.rmSync(proofPath(cache, did, rkey), { force: true });
}

/** The record keys `did` has cached proofs for. */
export function cachedKeys(cache: string, did: string): string[] {
    try {
        return FS.readdirSync(PATH.join(didDir(cache, did), 'proofs'))
            .filter((name) => name.endsWith('.json'))
            .map((name) => name.slice(0, -'.json'.length))
            .sort();
    } catch {
        return [];
    }
}

/** Every DID the cache holds a proof from for record key `rkey` — whoever has said anything about that hash. */
export function cachedFor(rkey: string, cache: string = cacheDir()): string[] {
    return cachedDids(cache).filter((did) => FS.existsSync(proofPath(cache, did, rkey)));
}

/** Every DID the cache holds anything for. */
export function cachedDids(cache: string = cacheDir()): string[] {
    try {
        return FS.readdirSync(cache, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => decodeURIComponent(entry.name))
            .filter(isDid)
            .sort();
    } catch {
        return [];
    }
}

function proofPath(cache: string, did: string, rkey: string): string {
    if (!/^[A-Za-z0-9._~:-]{1,512}$/.test(rkey) || rkey === '.' || rkey === '..') throw new Error(`invalid record key '${rkey}'`);
    return PATH.join(didDir(cache, did), 'proofs', `${encodeURIComponent(rkey)}.json`);
}

function writeAtomic(path: string, content: string): void {
    FS.mkdirSync(PATH.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.incoming-${process.pid}`;
    FS.writeFileSync(temporary, content, { mode: 0o600 });
    FS.renameSync(temporary, path);
}

// ------------------------------------------------------------------- checks ---

/** The `at://` address of `did`'s attestation of `hex`. */
export function recordUri(did: string, hex: string): string {
    return `at://${did}/${COLLECTION}/${hex}`;
}

/**
 * What a verified proof's record says about `hashAlg:hex`, or why it does not
 * count. Shared by the cache check and by whatever fetched the proof.
 */
export function readRecord(value: Value, hashAlg: string, hex: string): { ok: true; record: AttestationRecord } | { ok: false; reason: string } {
    const record = value as Partial<AttestationRecord> | null;
    if (!record || typeof record !== 'object' || record.$type !== COLLECTION) {
        return { ok: false, reason: `the record at that key is not a ${COLLECTION}` };
    }
    if (record.hash !== `${hashAlg}:${hex}`) {
        return { ok: false, reason: `the record attests ${String(record.hash)}, not ${hashAlg}:${hex}` };
    }
    if (record.verdict !== undefined && record.verdict !== 'good' && record.verdict !== 'bad') {
        return { ok: false, reason: `the record's verdict '${String(record.verdict)}' is neither good nor bad` };
    }
    return { ok: true, record: record as AttestationRecord };
}

/**
 * Check a policy against the cache, for an archive whose whole-file hash is
 * `hashAlg:hex`. Synchronous, and offline: what is not in the cache is not
 * there.
 */
export function evaluate(policy: AttestationPolicy, hashAlg: string, hex: string, now = Date.now()): AttestationOutcome {
    const cache = policy.cache ?? cacheDir();
    const maxAge = policy.maxAge ?? DEFAULT_MAX_AGE;
    const attestations = policy.attesters.map((attester) => check(cache, attester, hashAlg, hex, maxAge, now));
    const required = Math.min(policy.quorum ?? policy.attesters.length, policy.attesters.length);
    const good = attestations.filter((each) => each.ok);

    // A blocker's bad verdict is looked for whatever its kind; a blocker that
    // has said nothing, or whose proof is stale, blocks nothing.
    const blocked = (policy.block ?? [])
        .map(({ did }) => check(cache, { did }, hashAlg, hex, maxAge, now, 'bad'))
        .filter((each) => each.ok);
    const met = good.length >= required && blocked.length === 0;

    const reason = blocked.length
        ? `marked bad by ${blocked.map(describe).join(', ')}`
        : met
            ? `attested by ${good.map(describe).join(', ')}`
            : `${good.length} of ${required} required attestation${required === 1 ? '' : 's'}: ` +
              attestations.filter((each) => !each.ok).map((each) => `${describe(each)} — ${each.reason}`).join('; ');
    return { met, required, attestations, blocked, reason };
}

/**
 * Every attestation of `hashAlg:hex` the cache holds from `did`, good or bad,
 * verified — or null when there is none, or it is not fresh. What install and
 * update show a person, rather than what a policy demands.
 */
export function cached(did: string, hashAlg: string, hex: string, { cache = cacheDir(), maxAge = DEFAULT_MAX_AGE, now = Date.now() }: {
    cache?: string | undefined;
    maxAge?: number | undefined;
    now?: number | undefined;
} = {}): Attestation | null {
    const found = check(cache, { did }, hashAlg, hex, maxAge, now, 'any');
    return found.ok ? found : null;
}

function describe(attestation: Attestation): string {
    const who = attestation.handle ? `${attestation.handle} (${attestation.did})` : attestation.did;
    const kind = attestation.attested ?? attestation.kind;
    return kind ? `${who} as ${kind}` : who;
}

// `want` is which verdict counts as a match: 'good' for a requirement, 'bad'
// for a blocker, 'any' for showing what is there.
function check(cache: string, { did, kind }: Attester, hashAlg: string, hex: string, maxAge: number, now: number,
    want: Verdict | 'any' = 'good'): Attestation {
    const uri = recordUri(did, hex);
    const fail = (reason: string, extra: Partial<Attestation> = {}): Attestation => ({ did, kind, uri, ok: false, reason, ...extra });

    const doc = readDocument(cache, did);
    if (!doc) return fail("nothing cached for this attester — run 'bundle trust', or verify online");
    const handle = claimedHandle(doc);

    const proof = readProof(cache, did, hex);
    if (!proof) return fail('no attestation of this file', { handle });
    if (Number.isNaN(proof.checkedAt.getTime()) || now - proof.checkedAt.getTime() > maxAge) {
        return fail(`last confirmed ${proof.checkedAt.toISOString()}, longer ago than the policy allows — run 'bundle trust'`,
            { handle, checkedAt: proof.checkedAt });
    }

    let value: Value;
    try {
        const verified = verifyRecordProof(proof.car, { did, key: signingKey(doc), collection: COLLECTION, rkey: hex });
        if (!verified.record) return fail('the proof shows no attestation of this file', { handle, checkedAt: proof.checkedAt });
        value = verified.record.value;
    } catch (err) {
        return fail(`the cached proof does not verify: ${err instanceof Error ? err.message : String(err)}`, { handle });
    }

    const read = readRecord(value, hashAlg, hex);
    if (!read.ok) return fail(read.reason, { handle, checkedAt: proof.checkedAt });
    const { record } = read;
    const verdict: Verdict = record.verdict ?? 'good';
    const extra = { handle, checkedAt: proof.checkedAt, attested: record.kind, createdAt: record.createdAt, verdict };
    if (want !== 'any' && verdict !== want) {
        return fail(want === 'good' ? `marked this file bad${record.kind ? ` (${record.kind})` : ''}` : 'vouches for this file', extra);
    }
    if (kind && record.kind !== kind) {
        return fail(`attested ${record.kind ? `as '${record.kind}'` : 'with no kind'}, and '${kind}' is required`, extra);
    }
    return { did, kind, uri, ok: true, reason: verdict === 'bad' ? 'marked bad' : 'attested', ...extra };
}
