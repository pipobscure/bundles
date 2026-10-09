import * as DNS from 'node:dns';
import {
    COLLECTION, cacheDir, readDocument, writeDocument, readProof, writeProof, removeProof, cachedKeys,
    parseAttester, isDid, readRecord, recordUri,
    type Attester, type AttestationRecord, type Verdict,
} from './attestation.ts';
import { patientFetch, type Patience } from './ratelimit.ts';
import { verifyRecordProof, signingKey, pdsEndpoint, claimedHandle, treeStep, decode, writeCar, CID, readCar, type DidDocument, type Value } from './repo.ts';

// The online half of attestations: resolving who someone is, fetching the
// proofs of what they have attested into the cache, and writing attestations.
//
// Nothing here decides whether a bundle runs. Everything fetched is verified
// before it is cached — so a PDS that answers with garbage leaves the cache as
// it was — and verified again when it is read, by `attestation.ts`, which is
// the only thing the verifying mount consults.
//
// Two lookups need trusting, and they are the same two atproto itself trusts:
// the DID document, from the PLC directory or the `did:web` host over HTTPS,
// and — for a handle given on a command line — DNS or HTTPS for the handle,
// checked both ways against the document. Everything after the DID document is
// self-verifying.

/** The PLC directory (`BUNDLE_PLC_DIRECTORY` overrides it). */
export const DEFAULT_PLC_DIRECTORY = 'https://plc.directory';

/** What every network call here accepts: where the cache is, and how to fetch. */
/** How the network is reached; a server that says to slow down is waited for, as `Patience` says. */
export interface NetworkOptions extends Patience {
    cache?: string | undefined;
    fetch?: typeof globalThis.fetch | undefined;
    /** How TXT records are looked up, for handle resolution (default: `node:dns`). */
    resolveTxt?: ((name: string) => Promise<string[][]>) | undefined;
    /** The PLC directory to resolve `did:plc:` against. */
    plc?: string | undefined;
    now?: (() => Date) | undefined;
    /**
     * DID documents fetched so far, by DID, for work that asks about the same
     * people many times over — `trust`, `validate` — to ask the network once.
     */
    documents?: Map<string, Promise<DidDocument>> | undefined;
}

// ------------------------------------------------------------- identities ---

/** Fetch and check a DID document, and cache it. */
export async function resolveDid(did: string, options: NetworkOptions = {}): Promise<DidDocument> {
    const doc = await fetchDidDocument(did, options);
    writeDocument(options.cache ?? cacheDir(), doc);
    return doc;
}

/**
 * Fetch and check a DID document, without caching it. The attestation cache
 * holds the documents of attesters, and `bundle trust` refreshes everyone it
 * holds — so a lookup made for any other reason stays out of it.
 */
export async function fetchDidDocument(did: string, options: NetworkOptions = {}): Promise<DidDocument> {
    const known = options.documents?.get(did);
    if (known) return await known;
    const fetching = fetchDocument(did, options);
    if (options.documents) {
        options.documents.set(did, fetching);
        fetching.catch(() => options.documents?.delete(did));
    }
    return await fetching;
}

async function fetchDocument(did: string, options: NetworkOptions): Promise<DidDocument> {
    const fetch = net(options);
    let url: string;
    if (did.startsWith('did:plc:')) {
        const plc = options.plc ?? process.env['BUNDLE_PLC_DIRECTORY'] ?? DEFAULT_PLC_DIRECTORY;
        url = `${plc.replace(/\/+$/, '')}/${encodeURIComponent(did)}`;
    } else if (did.startsWith('did:web:')) {
        // atproto's did:web is a bare hostname — no path — with a port, if any,
        // percent-encoded.
        const host = decodeURIComponent(did.slice('did:web:'.length));
        if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) throw new Error(`${did}: not a hostname did:web`);
        url = `https://${host}/.well-known/did.json`;
    } else {
        throw new Error(`${did}: only did:plc and did:web are supported`);
    }

    const response = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${did}: resolving ${url} failed (${response.status})`);
    const doc = await response.json() as DidDocument;
    if (doc?.id !== did) throw new Error(`${did}: ${url} returned the document of ${String(doc?.id)}`);
    // Both of these throw on a document that cannot be used.
    signingKey(doc);
    pdsEndpoint(doc);
    return doc;
}

/**
 * Resolve a handle to its DID — DNS (`_atproto.<handle>` TXT `did=…`) first,
 * then `https://<handle>/.well-known/atproto-did` — and check that the DID
 * document claims the handle back. A handle that only points one way is
 * someone pointing at an account that does not agree.
 */
export async function resolveHandle(handle: string, options: NetworkOptions = {}): Promise<{ did: string; doc: DidDocument }> {
    const name = handle.replace(/^@/, '').toLowerCase();
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
        throw new Error(`'${handle}' is neither a DID nor a handle`);
    }

    let did: string | undefined;
    try {
        const records = await (options.resolveTxt ?? DNS.promises.resolveTxt)(`_atproto.${name}`);
        const found = [...new Set(records.map((chunks) => chunks.join('')).filter((text) => text.startsWith('did=')))];
        if (found.length === 1) did = found[0]!.slice('did='.length);
    } catch {
        // No TXT record: try the well-known file.
    }
    if (!did) {
        const fetch = net(options);
        try {
            const response = await fetch(`https://${name}/.well-known/atproto-did`, { redirect: 'error' });
            if (response.ok) did = (await response.text()).trim();
        } catch {
            // Neither worked; said below.
        }
    }
    if (!did || !isDid(did)) throw new Error(`could not resolve the handle ${name} to a DID`);

    const doc = await fetchDidDocument(did, options);
    if (claimedHandle(doc)?.toLowerCase() !== name) {
        throw new Error(`${name} points at ${did}, but that DID does not claim ${name} back`);
    }
    return { did, doc };
}

/** Turn a `[kind@]<did or handle>` into an attester with a DID. */
export async function resolveAttester(spec: string, options: NetworkOptions = {}): Promise<Attester> {
    const { subject, kind } = parseAttester(spec);
    if (subject.startsWith('did:')) {
        if (!isDid(subject)) throw new Error(`'${subject}' is not a did:plc or did:web`);
        return { did: subject, kind };
    }
    return { did: (await resolveHandle(subject, options)).did, kind };
}

// ----------------------------------------------------------------- proofs ---

/**
 * Fetch `did`'s attestation of `hex` into the cache, or remove it from the cache
 * when the proof shows it is gone. Returns which it was.
 */
export async function fetchAttestation(did: string, hashAlg: string, hex: string, options: NetworkOptions = {}): Promise<'present' | 'absent'> {
    const cache = options.cache ?? cacheDir();
    const doc = await resolveDid(did, options);
    return await fetchProof(doc, hashAlg, hex, cache, options);
}

async function fetchProof(doc: DidDocument, hashAlg: string | null, rkey: string, cache: string, options: NetworkOptions): Promise<'present' | 'absent'> {
    const did = doc.id;
    const car = await xrpcBytes(pdsEndpoint(doc), 'com.atproto.sync.getRecord', { did, collection: COLLECTION, rkey }, options);
    return storeProof(doc, hashAlg, rkey, car, cache, options);
}

// Check a proof of `rkey` and cache it — or, when it proves there is none, or
// that what is there is no attestation of the hash, remove what was cached.
function storeProof(doc: DidDocument, hashAlg: string | null, rkey: string, car: Buffer | null, cache: string, options: NetworkOptions): 'present' | 'absent' {
    const did = doc.id;
    if (car === null) {
        removeProof(cache, did, rkey);
        return 'absent';
    }
    const proof = verifyRecordProof(car, { did, key: signingKey(doc), collection: COLLECTION, rkey });
    // A record that is there but does not attest this hash counts as absent — and
    // is not cached, since caching it would only produce the same refusal later.
    const usable = proof.record && (hashAlg === null
        ? (proof.record.value as { $type?: unknown })?.$type === COLLECTION
        : readRecord(proof.record.value, hashAlg, rkey).ok);
    if (!usable) {
        removeProof(cache, did, rkey);
        return 'absent';
    }
    writeProof(cache, did, rkey, { checkedAt: (options.now ?? (() => new Date()))(), car });
    return 'present';
}

/** Below this many keys, a request each is no more than a walk of the tree takes. */
const WALK_FROM = 4;

/**
 * Fetch `did`'s attestations of many hashes into the cache — or out of it, for
 * those the proofs show are gone — in a handful of requests however many
 * there are: see `fetchProofs()`. What `validate` does for each attester.
 */
export async function fetchAttestations(did: string, wanted: { hashAlg: string | null; hex: string }[], options: NetworkOptions = {}): Promise<Map<string, 'present' | 'absent'>> {
    const cache = options.cache ?? cacheDir();
    const doc = await resolveDid(did, options);
    const result = new Map<string, 'present' | 'absent'>();
    const unique = [...new Map(wanted.map((each) => [each.hex, each])).values()];
    const proofs = await fetchProofs(doc, unique.map(({ hex }) => hex), options);
    for (const { hashAlg, hex } of unique) result.set(hex, storeProof(doc, hashAlg, hex, proofs.get(hex) ?? null, cache, options));
    return result;
}

/**
 * Proofs of many attestation records in `doc`'s repository — or of their
 * absence — in a handful of requests however many there are. A record's
 * proof is the signed commit, the tree nodes on the path from its root to the
 * record's key, and the record: `com.atproto.sync.getRecord` sends one record's
 * at a time. Here the commit is fetched once, and the tree is walked toward
 * every key at the same time, a level to a request (`com.atproto.sync.
 * getBlocks`), then the records — about as many requests as the tree is deep.
 * Each proof is put together from those blocks, and checked by the caller
 * exactly as one fetched on its own would be. Fewer keys than make that worth
 * it, or a repository that moves on in the middle — its old nodes gone — are
 * fetched a record at a time instead.
 */
export async function fetchProofs(doc: DidDocument, rkeys: string[], options: NetworkOptions = {}): Promise<Map<string, Buffer | null>> {
    const did = doc.id;
    const pds = pdsEndpoint(doc);
    const proofs = new Map<string, Buffer | null>();
    const oneByOne = async () => {
        for (const rkey of rkeys) proofs.set(rkey, await xrpcBytes(pds, 'com.atproto.sync.getRecord', { did, collection: COLLECTION, rkey }, options));
        return proofs;
    };
    if (rkeys.length < WALK_FROM) return await oneByOne();

    const blocks = new Map<string, Buffer>();
    const fetchBlocks = async (cids: CID[]) => {
        const missing = [...new Map(cids.filter((cid) => !blocks.has(cid.toString())).map((cid) => [cid.toString(), cid])).values()];
        for (let at = 0; at < missing.length; at += 100) {
            const params = new URLSearchParams({ did });
            for (const cid of missing.slice(at, at + 100)) params.append('cids', cid.toString());
            const response = await net(options)(`${pds}/xrpc/com.atproto.sync.getBlocks?${params}`, { redirect: 'follow' });
            if (!response.ok) throw new Error(`com.atproto.sync.getBlocks at ${pds}: ${(await errorOf(response)).text}`);
            // Every block is hashed against its CID as it is read: whatever
            // sent them, they are the blocks those CIDs name.
            for (const [cid, data] of readCar(Buffer.from(await response.arrayBuffer())).blocks) blocks.set(cid, data);
        }
        for (const cid of missing) if (!blocks.has(cid.toString())) throw new Error(`${pds} did not send ${cid.toString()}`);
    };

    try {
        const latest = await xrpcJson(pds, 'com.atproto.sync.getLatestCommit', { did }, options) as { cid?: string };
        const commit = CID.parse(String(latest.cid));
        await fetchBlocks([commit]);
        const data = (decode(blocks.get(commit.toString())!) as Record<string, Value>)['data'];
        if (!(data instanceof CID)) throw new Error('commit carries no data root');

        // Walk toward every key at once, a level at a time.
        const paths = new Map(rkeys.map((rkey) => [rkey, [] as CID[]]));
        const found = new Map<string, CID | null>();
        let walking = new Map(rkeys.map((rkey) => [rkey, data]));
        for (let depth = 0; walking.size; depth++) {
            if (depth > 128) throw new Error('repository tree is implausibly deep');
            await fetchBlocks([...walking.values()]);
            const next = new Map<string, CID>();
            for (const [rkey, node] of walking) {
                paths.get(rkey)!.push(node);
                const step = treeStep(blocks.get(node.toString())!, Buffer.from(`${COLLECTION}/${rkey}`, 'utf-8'));
                if ('record' in step) found.set(rkey, step.record);
                else if (step.next) next.set(rkey, step.next);
                else found.set(rkey, null);
            }
            walking = next;
        }
        await fetchBlocks([...found.values()].filter((cid): cid is CID => cid !== null));

        for (const rkey of rkeys) {
            const record = found.get(rkey);
            const parts = [commit, ...paths.get(rkey)!, ...(record ? [record] : [])];
            proofs.set(rkey, writeCar([commit], parts.map((cid) => [cid, blocks.get(cid.toString())!] as [CID, Uint8Array])));
        }
        return proofs;
    } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUNDLE_RATE_LIMITED') throw err;
        proofs.clear();
        return await oneByOne();
    }
}

/**
 * Bring the cache up to date with everything `did` has attested: new
 * attestations are fetched, withdrawn ones removed, and the rest re-confirmed.
 *
 * The listing comes from the attester's PDS and is not itself signed, which is
 * sound for what it is used for. A listing can only make this cache *drop* a
 * proof — and the PDS can withdraw an attestation anyway — or *keep* one whose
 * record it still claims, which it could equally sign a fresh commit for.
 */
export async function refreshAttester(did: string, options: NetworkOptions = {}): Promise<{ present: number; fetched: number; removed: number }> {
    const cache = options.cache ?? cacheDir();
    const previous = readDocument(cache, did);
    const doc = await resolveDid(did, options);
    const rotated = !previous || JSON.stringify(previous.verificationMethod) !== JSON.stringify(doc.verificationMethod);
    const key = signingKey(doc);

    const listed = new Map<string, string>();
    let cursor: string | undefined;
    do {
        const page = await xrpcJson(pdsEndpoint(doc), 'com.atproto.repo.listRecords',
            { repo: did, collection: COLLECTION, limit: '100', ...(cursor ? { cursor } : {}) }, options) as {
            records?: { uri: string; cid: string }[]; cursor?: string;
        };
        for (const { uri, cid } of page.records ?? []) {
            const rkey = uri.slice(uri.lastIndexOf('/') + 1);
            if (rkey) listed.set(rkey, cid);
        }
        cursor = page.records?.length ? page.cursor : undefined;
    } while (cursor);

    let fetched = 0;
    let removed = 0;
    const now = (options.now ?? (() => new Date()))();
    for (const rkey of cachedKeys(cache, did)) {
        if (!listed.has(rkey)) {
            removeProof(cache, did, rkey);
            removed++;
        }
    }
    // Those already cached, and still the record listed, are re-confirmed as
    // they are; the rest are fetched together (see `fetchProofs()`).
    const needed: string[] = [];
    for (const [rkey, cid] of listed) {
        const cached = rotated ? null : readProof(cache, did, rkey);
        if (cached && sameRecord(cached.car, did, key, rkey, cid)) writeProof(cache, did, rkey, { checkedAt: now, car: cached.car });
        else needed.push(rkey);
    }
    const proofs = await fetchProofs(doc, needed, options);
    for (const rkey of needed) {
        if (storeProof(doc, null, rkey, proofs.get(rkey) ?? null, cache, options) === 'present') fetched++;
    }
    return { present: cachedKeys(cache, did).length, fetched, removed };
}

// Whether a cached proof still verifies, and is of the record the listing names.
function sameRecord(car: Buffer, did: string, key: ReturnType<typeof signingKey>, rkey: string, cid: string): boolean {
    try {
        const proof = verifyRecordProof(readCar(car), { did, key, collection: COLLECTION, rkey });
        return Boolean(proof.record?.cid.equals(CID.parse(cid)));
    } catch {
        return false;
    }
}

/**
 * Fetch, for each attester, its attestation of one hash. Failures are reported
 * rather than thrown: the cache keeps what it had, and the policy check decides
 * whether that is still good enough.
 */
export async function refreshFor(attesters: Attester[], hashAlg: string, hex: string, options: NetworkOptions = {}): Promise<string[]> {
    const problems: string[] = [];
    const dids = [...new Set(attesters.map((attester) => attester.did))];
    await Promise.all(dids.map(async (did) => {
        try {
            await fetchAttestation(did, hashAlg, hex, options);
        } catch (err) {
            problems.push(`${did}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    return problems.sort();
}

// -------------------------------------------------------------- discovery ---

/** How requests to a public index identify this tool — and nothing about who runs it. */
const USER_AGENT = '@pipobscure/bundle (https://github.com/pipobscure/bundles)';

/**
 * Who has attested `hashAlg:hex`, according to a backlink index — Constellation's
 * `blue.microcosm.links.getBacklinks`, which indexes every record field that
 * parses as a URI, `sha256:<hex>` included.
 *
 * The answer is a list of DIDs to ask, nothing more: an index can leave people
 * out or make them up, and every attestation it names is fetched from the
 * attester's own PDS and verified before it counts for anything. `limit` caps
 * how many are returned, so a hash that has attracted a crowd cannot turn one
 * install into thousands of requests.
 */
export async function discover(hashAlg: string, hex: string, { index, limit = 50, ...options }: NetworkOptions & {
    index: string;
    limit?: number | undefined;
}): Promise<string[]> {
    const found: string[] = [];
    for await (const { did, collection, rkey } of backlinks(`${hashAlg}:${hex}`, `${COLLECTION}:hash`, { ...options, index })) {
        // Only the record at the canonical key is an attestation of this
        // hash; anything else merely mentions it.
        if (collection !== COLLECTION || rkey !== hex || !isDid(did) || found.includes(did)) continue;
        found.push(did);
        if (found.length >= limit) break;
    }
    return found;
}

/** One record a backlink index says links to a subject. */
export interface Backlink {
    did: string;
    collection: string;
    rkey: string;
}

/**
 * Every record whose `source` field (`<collection>:<path>`) links to
 * `subject`, according to a backlink index, a page of 100 at a time. A
 * generator, so a caller that has seen enough can stop asking.
 */
export async function* backlinks(subject: string, source: string, { index, ...options }: NetworkOptions & { index: string }): AsyncGenerator<Backlink> {
    const fetch = net(options);
    let cursor: string | null | undefined;
    do {
        const params = new URLSearchParams({ subject, source, limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const response = await fetch(`${index.replace(/\/+$/, '')}/xrpc/blue.microcosm.links.getBacklinks?${params}`,
            { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
        if (!response.ok) throw new Error(`${index}: ${response.status} ${response.statusText}`);
        const page = await response.json() as { records?: { did?: string; collection?: string; rkey?: string }[]; cursor?: string | null };
        for (const { did, collection, rkey } of page.records ?? []) {
            if (did && collection && rkey) yield { did, collection, rkey };
        }
        cursor = page.records?.length ? page.cursor : null;
    } while (cursor);
}

// ---------------------------------------------------------------- writing ---

/** A logged-in session on someone's PDS. */
/**
 * A logged-in session on someone's PDS: who, where, and how to make an
 * authenticated request there. OAuth (oauth.ts) and app passwords (`login`
 * below) both produce one, and writing records does not care which.
 */
export interface Session {
    did: string;
    pds: string;
    /** How it was signed in, for saying so. */
    how: string;
    request(url: string, init: RequestInit): Promise<Response>;
    /** Done with it: revoke what can be revoked. */
    end?: (() => Promise<void>) | undefined;
}

/**
 * Log in with an app password — for CI, where nobody can sign in through a
 * browser. Everywhere else, OAuth (`oauthLogin` in oauth.ts) is the way:
 * atproto is moving away from passwords, and a PDS need not accept them.
 * `identifier` is a handle or a DID; the PDS is found from the DID document
 * rather than assumed, so this works for any account on any host.
 */
export async function login(identifier: string, password: string, options: NetworkOptions = {}): Promise<Session> {
    const did = identifier.startsWith('did:')
        ? identifier
        : (await resolveHandle(identifier, options)).did;
    const doc = await resolveDid(did, options);
    const pds = pdsEndpoint(doc);
    const session = await xrpcPost(pds, 'com.atproto.server.createSession', { identifier: did, password }, undefined, options) as {
        did?: string; accessJwt?: string;
    };
    if (session.did !== did || !session.accessJwt) throw new Error(`${pds} logged in as ${String(session.did)}, not ${did}`);
    const token = session.accessJwt;
    const fetch = net(options);
    return {
        did, pds, how: 'an app password',
        request: (url, init) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } }),
    };
}

/** What an attestation says: of which file, and — when not simply vouching for it — what about it. */
export interface Attesting {
    hashAlg: string;
    hex: string;
    kind?: string | undefined;
    /** 'bad' to warn against the file; good is the default and is not written. */
    verdict?: Verdict | undefined;
    note?: string | undefined;
}

/**
 * Publish an attestation of `hashAlg:hex`. The PDS saying it is written is
 * taken as it being written: nothing is read back, since every request counts
 * against the account's rate limits, and `bundle trust` or an install fetches
 * it — verified — whenever it is needed.
 */
export async function attest(session: Session, attesting: Attesting, options: NetworkOptions = {}): Promise<{ uri: string }> {
    const [written] = await attestAll(session, [attesting], options);
    return written!;
}

/** Publish several attestations, in as few requests as the PDS allows (see `putAll()`). */
export async function attestAll(session: Session, attestations: Attesting[], options: NetworkOptions = {}): Promise<{ uri: string }[]> {
    const now = (options.now ?? (() => new Date()))().toISOString();
    const records = attestations.map(({ hashAlg, hex, kind, verdict, note }) => ({
        rkey: hex,
        record: {
            $type: COLLECTION,
            hash: `${hashAlg}:${hex}`,
            ...(kind ? { kind } : {}),
            ...(verdict === 'bad' ? { verdict } : {}),
            ...(note ? { note } : {}),
            createdAt: now,
        } satisfies AttestationRecord as Record<string, unknown>,
    }));
    await putAll(session, COLLECTION, records, options);
    return records.map(({ rkey }) => ({ uri: recordUri(session.did, rkey) }));
}

/** Withdraw attestations, in as few requests as it takes, and drop them from the cache. */
export async function revokeAll(session: Session, hexes: string[], options: NetworkOptions = {}): Promise<void> {
    await deleteAll(session, COLLECTION, hexes, options);
    for (const hex of hexes) removeProof(options.cache ?? cacheDir(), session.did, hex);
}

// ---------------------------------------------------------------- batches ---

/** One write in an `applyWrites` batch. */
export type Write =
    | { action: 'create' | 'update'; collection: string; rkey: string; record: Record<string, unknown> }
    | { action: 'delete'; collection: string; rkey: string };

/** The most writes one `applyWrites` takes. */
export const MAX_BATCH = 200;

/**
 * Apply `writes` to the session's own repository: one request for up to
 * `MAX_BATCH` of them, each request one commit — all of it written, or none.
 * A create of a record that is there, or an update or delete of one that is
 * not, refuses the whole request.
 */
export async function applyWrites(session: Session, writes: Write[], options: NetworkOptions = {}): Promise<void> {
    for (let at = 0; at < writes.length; at += MAX_BATCH) {
        await xrpcPost(session.pds, 'com.atproto.repo.applyWrites', {
            repo: session.did,
            writes: writes.slice(at, at + MAX_BATCH).map((write) => write.action === 'delete'
                ? { $type: 'com.atproto.repo.applyWrites#delete', collection: write.collection, rkey: write.rkey }
                : { $type: `com.atproto.repo.applyWrites#${write.action}`, collection: write.collection, rkey: write.rkey, value: write.record }),
        }, session, options);
    }
}

/**
 * The records in one collection of the session's own repository, by key: as
 * the PDS lists them, a hundred to a request. Unverified — it is the
 * account's own repository, asked only which records are there.
 */
export async function listOwn(session: Session, collection: string, options: NetworkOptions = {}): Promise<Map<string, Value>> {
    const found = new Map<string, Value>();
    let cursor: string | undefined;
    do {
        const page = await xrpcJson(session.pds, 'com.atproto.repo.listRecords',
            { repo: session.did, collection, limit: '100', ...(cursor ? { cursor } : {}) }, options) as {
            records?: { uri: string; value: Value }[]; cursor?: string;
        };
        for (const { uri, value } of page.records ?? []) found.set(uri.slice(uri.lastIndexOf('/') + 1), value);
        cursor = page.records?.length ? page.cursor : undefined;
    } while (cursor);
    return found;
}

/**
 * Write records at keys of their own, replacing what is there, in as few
 * requests as there can be. One record is one putRecord. Several are created
 * in one batch — the usual case, nothing there yet — and only if the PDS
 * refuses that, because some are there already, is the collection listed and
 * the batch sent again, updating those. `existing`, when the caller has listed
 * the collection already, skips straight to the right batch. Being told to
 * slow down is not a refusal: it is waited out, or fails, as it is.
 */
export async function putAll(session: Session, collection: string, records: { rkey: string; record: Record<string, unknown> }[],
    options: NetworkOptions & { existing?: ReadonlySet<string> | ReadonlyMap<string, unknown> | undefined } = {}): Promise<void> {
    if (!records.length) return;
    if (records.length === 1 && !options.existing) {
        await putRecord(session, collection, records[0]!.rkey, records[0]!.record, options);
        return;
    }
    const writes = (existing: { has(rkey: string): boolean } | undefined): Write[] => records.map(({ rkey, record }) =>
        ({ action: existing?.has(rkey) ? 'update' : 'create', collection, rkey, record }));
    if (options.existing) return await applyWrites(session, writes(options.existing), options);
    await refusedOnce(() => applyWrites(session, writes(undefined), options),
        async () => applyWrites(session, writes(await listOwn(session, collection, options)), options));
}

/** Delete records — those that are there — in as few requests as there can be, as `putAll()` writes them. */
export async function deleteAll(session: Session, collection: string, rkeys: string[],
    options: NetworkOptions & { existing?: ReadonlySet<string> | ReadonlyMap<string, unknown> | undefined } = {}): Promise<void> {
    if (!rkeys.length) return;
    if (rkeys.length === 1 && !options.existing) {
        await deleteRecord(session, collection, rkeys[0]!, options);
        return;
    }
    const writes = (keys: string[]): Write[] => keys.map((rkey) => ({ action: 'delete', collection, rkey }));
    const there = (existing: { has(rkey: string): boolean }) => rkeys.filter((rkey) => existing.has(rkey));
    if (options.existing) return await applyWrites(session, writes(there(options.existing)), options);
    await refusedOnce(() => applyWrites(session, writes(rkeys), options),
        async () => applyWrites(session, writes(there(await listOwn(session, collection, options))), options));
}

// Try `first`; if the PDS refuses it — anything but being rate limited — try
// `then`, once, and let that fail as it fails.
async function refusedOnce(first: () => Promise<void>, then: () => Promise<void>): Promise<void> {
    try {
        await first();
    } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUNDLE_RATE_LIMITED') throw err;
        await then();
    }
}

/** Withdraw an attestation, and drop it from the cache. */
/**
 * Any record, verified: resolve `did`, fetch the record's proof from its PDS,
 * and check it against the DID's key. Null when the proof shows there is none.
 */
export async function getRecord(did: string, collection: string, rkey: string, options: NetworkOptions = {}): Promise<{ cid: string; value: Value } | null> {
    const doc = await fetchDidDocument(did, options);
    const car = await xrpcBytes(pdsEndpoint(doc), 'com.atproto.sync.getRecord', { did, collection, rkey }, options);
    if (car === null) return null;
    const proof = verifyRecordProof(car, { did, key: signingKey(doc), collection, rkey });
    return proof.record ? { cid: proof.record.cid.toString(), value: proof.record.value } : null;
}

/** Write a record into the session's own repository, at a key of the caller's choosing. */
export async function putRecord(session: Session, collection: string, rkey: string, record: Record<string, unknown>, options: NetworkOptions = {}): Promise<{ uri: string; cid: string }> {
    const written = await xrpcPost(session.pds, 'com.atproto.repo.putRecord',
        { repo: session.did, collection, rkey, record }, session, options) as { uri?: string; cid?: string };
    return { uri: written.uri ?? `at://${session.did}/${collection}/${rkey}`, cid: written.cid ?? '' };
}

/** Delete a record from the session's own repository. */
export async function deleteRecord(session: Session, collection: string, rkey: string, options: NetworkOptions = {}): Promise<void> {
    await xrpcPost(session.pds, 'com.atproto.repo.deleteRecord', { repo: session.did, collection, rkey }, session, options);
}

export async function revoke(session: Session, hex: string, options: NetworkOptions = {}): Promise<void> {
    await revokeAll(session, [hex], options);
}

// ------------------------------------------------------------------- XRPC ---

/** The fetch every request here is made with: the one given, or the global one, waiting when told to. */
export function net(options: NetworkOptions): typeof globalThis.fetch {
    return patientFetch(options.fetch ?? globalThis.fetch, options);
}

function xrpcUrl(pds: string, method: string, params: Record<string, string>): string {
    return `${pds}/xrpc/${method}?${new URLSearchParams(params).toString()}`;
}

// A getRecord answer is a CAR; anything else is an error. Older PDSes answer a
// missing record with `RecordNotFound` rather than a proof of absence, so that
// is treated as absence too.
async function xrpcBytes(pds: string, method: string, params: Record<string, string>, options: NetworkOptions): Promise<Buffer | null> {
    const response = await net(options)(xrpcUrl(pds, method, params), { redirect: 'follow' });
    if (!response.ok) {
        const error = await errorOf(response);
        if (error.name === 'RecordNotFound') return null;
        throw new Error(`${method} at ${pds}: ${error.text}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/** A query answered in JSON, from `pds` (or any XRPC host). */
export async function xrpcJson(pds: string, method: string, params: Record<string, string>, options: NetworkOptions): Promise<unknown> {
    const response = await net(options)(xrpcUrl(pds, method, params), { redirect: 'follow' });
    if (!response.ok) throw new Error(`${method} at ${pds}: ${(await errorOf(response)).text}`);
    return await response.json();
}

async function xrpcPost(pds: string, method: string, body: unknown, session: Session | undefined, options: NetworkOptions): Promise<unknown> {
    const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const url = `${pds}/xrpc/${method}`;
    const response = session ? await session.request(url, init) : await net(options)(url, init);
    if (!response.ok) throw new Error(`${method} at ${pds}: ${(await errorOf(response)).text}`);
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : {};
}

async function errorOf(response: Response): Promise<{ name?: string | undefined; text: string }> {
    try {
        const body = await response.json() as { error?: string; message?: string };
        return { name: body.error, text: `${response.status} ${body.error ?? ''}${body.message ? `: ${body.message}` : ''}`.trim() };
    } catch {
        return { text: `${response.status} ${response.statusText}` };
    }
}
