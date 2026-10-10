import * as CRYPTO from 'node:crypto';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { stateDir, isDid } from './attestation.ts';
import {
    backlinks, deleteAll, fetchDidDocument, getRecord, listOwn, putAll, resolveHandle, xrpcJson,
    type NetworkOptions, type Session,
} from './atproto.ts';
import { claimedHandle, pdsEndpoint, type DidDocument, type Value } from './repo.ts';

// Listings: finding bundles, over atproto.
//
// A publisher lists a bundle with a record in their own repository, at a key
// that is the name it installs as, saying where it is fetched from:
//
//   at://<did>/com.pipobscure.bundle.listing/bled
//   { "subject": "sha256:<sha256 of this NSID>", "url": "https://…/bled.nzip", … }
//
// or, in place of the URL, a domain whose `nzip:` TXT record names one — so a
// publisher who already manages their URL in DNS keeps doing so — and anyone
// installs it as `bundle install @<handle>/bled`. The record says where and
// nothing else — no hash, no version — so a release is still just whatever the
// URL serves next, and what it serves is verified like any other download. A
// listing vouches for nothing.
//
// Every listing of an app carries the same `subject`. That is what makes them
// findable without a service of our own: a backlink index (Constellation)
// indexes every field that parses as a URI, so asking it what links to that one
// value enumerates every app listed on the network. Searching them happens
// locally, in an SQLite index in the state directory that `syncIndex()` keeps
// current.
//
// A plugin's listing has, as its subject, the `at://` address of the listing of
// the app it is for. So it never appears among apps, and asking the backlink
// index what links to an app's listing finds exactly its plugins — which the
// index asks only for the apps installed here.
//
// See proposals/atproto-listings.md for the reasoning.

/** The record type, and the collection listings live in. */
export const LISTING = 'com.pipobscure.bundle.listing';

/** The `subject` of every app's listing: the sha256 of the NSID. A plugin's is its app's listing's address. */
export const SUBJECT = `sha256:${CRYPTO.createHash('sha256').update(LISTING).digest('hex')}`;

/** What a listing's name — its record key, and the name it installs as — may be. */
export const NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';

/** A domain a listing can name: lowercase, at least two labels, no trailing dot. */
export const DOMAIN_PATTERN = '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$';

/** The record as it is written: with a `url`, or a `domain`, never both. */
export interface ListingRecord {
    $type: typeof LISTING;
    /** `SUBJECT` for an app; for a plugin, the `at://` address of its app's listing. */
    subject: string;
    /** Where the bundle is fetched from. */
    url?: string | undefined;
    /** A domain whose `nzip:` TXT record says where the bundle is fetched from. */
    domain?: string | undefined;
    title?: string | undefined;
    description?: string | undefined;
    createdAt: string;
}

/** A listing, as the index and the commands show it. */
export interface Listing {
    did: string;
    /** The publisher's handle, when it checks out both ways. */
    handle?: string | undefined;
    name: string;
    title?: string | undefined;
    description?: string | undefined;
    /** Where it is fetched from — or, instead, */
    url?: string | undefined;
    /** the domain whose `nzip:` record says where. */
    domain?: string | undefined;
    createdAt: string;
    /** What `bundle install` takes: `@<handle or did>/<name>`. */
    install: string;
    uri: string;
    /** For a plugin: the address of its app's listing. */
    for?: string | undefined;
}

/** Whether `name` can be a listing's name. */
export function isName(name: string): boolean {
    return new RegExp(NAME_PATTERN).test(name);
}

/** The `at://` address of `did`'s listing called `name`. */
export function listingUri(did: string, name: string): string {
    return `at://${did}/${LISTING}/${name}`;
}

/** The DID and name in a listing's `at://` address, or null when it is not one. */
export function parseListingUri(uri: string): { did: string; name: string } | null {
    const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
    if (!m || m[2] !== LISTING || !isDid(m[1]!) || !isName(m[3]!)) return null;
    return { did: m[1]!, name: m[3]! };
}

/** For a plugin's listing, the address of the app's listing it is for. */
export function appOf(record: ListingRecord): string | undefined {
    return record.subject === SUBJECT ? undefined : record.subject;
}

// The lexicon's limits, which a PDS validating against it would apply too.
const LIMITS = { url: 2048, title: [640, 64], description: [3000, 300] } as const;

/** What a record says, or why it is not a listing this tool will use. */
export function readListing(value: Value, name: string): { ok: true; record: ListingRecord } | { ok: false; reason: string } {
    const record = value as Partial<ListingRecord> | null;
    if (!record || typeof record !== 'object' || record.$type !== LISTING) return { ok: false, reason: `the record is not a ${LISTING}` };
    if (!isName(name)) return { ok: false, reason: `'${name}' is not a usable name (lowercase letters, digits and '-', at most 64)` };
    if (record.subject !== SUBJECT && (typeof record.subject !== 'string' || !parseListingUri(record.subject))) {
        return { ok: false, reason: `its subject is neither ${SUBJECT} nor the address of an app's listing` };
    }
    if ((record.url === undefined) === (record.domain === undefined)) return { ok: false, reason: 'it must name a url or a domain, and not both' };
    if (record.url !== undefined) {
        if (typeof record.url !== 'string' || record.url.length > LIMITS.url) return { ok: false, reason: 'it names no usable URL' };
        const url = httpsUrl(record.url);
        if (!url.ok) return url;
    } else if (typeof record.domain !== 'string' || !isListedDomain(record.domain)) {
        return { ok: false, reason: `'${String(record.domain)}' is not a domain name` };
    }
    for (const field of ['title', 'description'] as const) {
        const text = record[field];
        if (text === undefined) continue;
        if (typeof text !== 'string') return { ok: false, reason: `its ${field} is not text` };
        const [bytes, graphemes] = LIMITS[field];
        if (Buffer.byteLength(text) > bytes || countGraphemes(text) > graphemes) return { ok: false, reason: `its ${field} is longer than ${graphemes} characters` };
    }
    if (typeof record.createdAt !== 'string') return { ok: false, reason: 'it has no createdAt' };
    return { ok: true, record: record as ListingRecord };
}

/** Whether `text` is a domain a listing can name. */
export function isListedDomain(text: string): boolean {
    return new RegExp(DOMAIN_PATTERN).test(text);
}

function httpsUrl(text: string): { ok: true } | { ok: false; reason: string } {
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return { ok: false, reason: `'${text}' is not a URL` };
    }
    // As for an `nzip:` record: plain HTTP would let anyone on the path choose
    // the bytes, and leave the signature as the only thing between them and
    // the first install's trust decision.
    if (url.protocol !== 'https:') return { ok: false, reason: `'${text}' is not https` };
    return { ok: true };
}

function countGraphemes(text: string): number {
    let n = 0;
    for (const _ of new Intl.Segmenter().segment(text)) n++;
    return n;
}

// --------------------------------------------------------------- resolving ---

/**
 * Split `@<handle or did>/<name>` — what `bundle install` takes for a listing —
 * or null for anything that does not start with `@`.
 */
export function parseListingTarget(target: string): { who: string; name: string } | null {
    if (!target.startsWith('@')) return null;
    const slash = target.lastIndexOf('/');
    const who = target.slice(1, slash);
    const name = target.slice(slash + 1);
    if (slash < 0 || !who || !name) throw new Error(`'${target}' is not of the form @<handle or did>/<name>`);
    if (!isName(name)) throw new Error(`'${name}' is not a listing name (lowercase letters, digits and '-', at most 64)`);
    return { who, name };
}

/**
 * Find the listing `@<handle or did>/<name>` names: the handle resolved and
 * checked both ways, and the record fetched from the publisher's own PDS with
 * its proof, verified against their key. Whatever an index said, this is the
 * record an install uses.
 */
export async function resolveListing(target: string, options: NetworkOptions = {}): Promise<{ did: string; name: string; uri: string; record: ListingRecord }> {
    const parsed = parseListingTarget(target);
    if (!parsed) throw new Error(`'${target}' is not a listing — those start with '@'`);
    const { who, name } = parsed;
    let did: string;
    if (who.startsWith('did:')) {
        if (!isDid(who)) throw new Error(`'${who}' is not a did:plc or did:web`);
        did = who;
    } else {
        did = (await resolveHandle(who, options)).did;
    }
    const record = await fetchListing(did, name, options);
    if (!record) throw new Error(`${target}: ${did} has no listing called '${name}'`);
    return { did, name, uri: listingUri(did, name), record };
}

/**
 * The listing at an `at://` address, as it is now — what an install made from
 * one is remembered by, and what `update` asks again.
 */
export async function followListing(uri: string, options: NetworkOptions = {}): Promise<{ did: string; name: string; uri: string; record: ListingRecord }> {
    const parsed = parseListingUri(uri);
    if (!parsed) throw new Error(`'${uri}' is not the address of a listing`);
    const { did, name } = parsed;
    const record = await fetchListing(did, name, options);
    if (!record) throw new Error(`${uri} is no longer listed`);
    return { did, name, uri, record };
}

async function fetchListing(did: string, name: string, options: NetworkOptions): Promise<ListingRecord | null> {
    const found = await getRecord(did, LISTING, name, options);
    if (!found) return null;
    const read = readListing(found.value, name);
    if (!read.ok) throw new Error(`${listingUri(did, name)}: ${read.reason}`);
    return read.record;
}

// -------------------------------------------------------------- publishing ---

/** One listing to publish: a `url`, or a `domain` whose `nzip:` TXT record names one. */
export interface Publishing {
    name: string;
    url?: string | undefined;
    domain?: string | undefined;
    /** The address of an app's listing: this is a plugin for that app. */
    for?: string | undefined;
    title?: string | undefined;
    description?: string | undefined;
}

/**
 * List a bundle under `name` from the session's account. Listing it again
 * replaces the record, keeping when it was first listed.
 */
export async function publish(session: Session, listing: Publishing, options: NetworkOptions = {}): Promise<{ uri: string; replaced: boolean; record: ListingRecord }> {
    const [written] = await publishAll(session, [listing], options);
    return written!;
}

/**
 * List several bundles at once: the account's listings read once — to know
 * which are there, and keep when each was first listed — and all of them
 * written in one batch (as many as `applyWrites` takes to a request). The PDS
 * saying they are written is taken as their being written; nothing is read
 * back, since every request counts against the account's rate limits.
 */
export async function publishAll(session: Session, listings: Publishing[], options: NetworkOptions = {}): Promise<{ uri: string; replaced: boolean; record: ListingRecord }[]> {
    const names = new Set<string>();
    for (const { name } of listings) {
        if (!isName(name)) throw new Error(`'${name}' is not a listing name (lowercase letters, digits and '-', at most 64)`);
        if (names.has(name)) throw new Error(`'${name}' is listed twice`);
        names.add(name);
    }
    const existing = await listOwn(session, LISTING, options);
    const now = (options.now ?? (() => new Date()))().toISOString();
    const written = listings.map(({ name, url, domain, for: app, title, description }) => {
        const before = existing.get(name);
        const previous = before ? readListing(before, name) : null;
        const record: ListingRecord = {
            $type: LISTING,
            subject: app ?? SUBJECT,
            ...(url !== undefined ? { url } : {}),
            ...(domain !== undefined ? { domain } : {}),
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            createdAt: previous?.ok ? previous.record.createdAt : now,
        };
        const checked = readListing(record as unknown as Value, name);
        if (!checked.ok) throw new Error(`refusing to publish ${name}: ${checked.reason}`);
        return { uri: listingUri(session.did, name), replaced: Boolean(before), record };
    });
    await putAll(session, LISTING, written.map(({ record }, i) => ({ rkey: listings[i]!.name, record: record as unknown as Record<string, unknown> })),
        { ...options, existing });
    return written;
}

/** Take a listing down. False when there was none to take down. */
export async function unpublish(session: Session, name: string, options: NetworkOptions = {}): Promise<boolean> {
    return (await unpublishAll(session, [name], options)).removed.length === 1;
}

/**
 * Take several listings down: the account's listings read once, and those
 * that are there deleted in one batch. Says which were, and which were not.
 */
export async function unpublishAll(session: Session, names: string[], options: NetworkOptions = {}): Promise<{ removed: string[]; missing: string[] }> {
    for (const name of names) if (!isName(name)) throw new Error(`'${name}' is not a listing name`);
    const existing = await listOwn(session, LISTING, options);
    const removed = [...new Set(names)].filter((name) => existing.has(name));
    await deleteAll(session, LISTING, removed, { ...options, existing });
    return { removed, missing: [...new Set(names)].filter((name) => !existing.has(name)) };
}

// ---------------------------------------------------------------- the index ---

/** The version of the index's schema; an index of any other version is rebuilt. */
const SCHEMA_VERSION = 3;

/** How long a publisher's handle is believed before it is checked again (a day). */
export const HANDLE_AGE = 24 * 60 * 60 * 1000;

/** How old the index may be before `listings` and `search` sync it first (an hour). */
export const INDEX_AGE = 60 * 60 * 1000;

/** Where the index lives: `listings.sqlite` in the state directory. */
export function indexPath(): string {
    return PATH.join(stateDir(), 'listings.sqlite');
}

const SCHEMA = `
CREATE TABLE sync (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  index_url TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE TABLE subjects (
  uri TEXT PRIMARY KEY
);
CREATE TABLE publishers (
  did               TEXT PRIMARY KEY,
  handle            TEXT,
  handle_checked_at TEXT,
  pds               TEXT,
  rev               TEXT,
  synced_at         TEXT,
  error             TEXT
);
CREATE TABLE listings (
  did         TEXT NOT NULL REFERENCES publishers(did) ON DELETE CASCADE,
  rkey        TEXT NOT NULL,
  cid         TEXT NOT NULL,
  subject     TEXT NOT NULL,
  url         TEXT,
  domain      TEXT,
  title       TEXT,
  description TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (did, rkey)
);
CREATE VIRTUAL TABLE listings_fts USING fts5(
  rkey, title, description, handle,
  content = '', contentless_delete = 1,
  prefix = '2 3'
);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

// The index is a cache: one of another version, or built from another backlink
// index, is thrown away and built again rather than migrated.
function openForWriting(path: string, index: string): DatabaseSync {
    FS.mkdirSync(PATH.dirname(path), { recursive: true, mode: 0o700 });
    if (FS.existsSync(path)) {
        const db = new DatabaseSync(path);
        const built = usable(db) ? (db.prepare('SELECT index_url FROM sync').get() as { index_url: string } | undefined)?.index_url ?? index : null;
        if (built === index) return db;
        db.close();
        FS.rmSync(path, { force: true });
    }
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    return db;
}

function openForReading(path: string): DatabaseSync | null {
    if (!FS.existsSync(path)) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    if (usable(db)) return db;
    db.close();
    return null;
}

function usable(db: DatabaseSync): boolean {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version === SCHEMA_VERSION;
}

/**
 * When the index was last synced, from which backlink index, and for which
 * subjects — `SUBJECT`, and the listings of the apps whose plugins it holds —
 * or null when there is none.
 */
export function lastSync(path: string = indexPath()): { at: Date; index: string; subjects: string[] } | null {
    const db = openForReading(path);
    if (!db) return null;
    try {
        const row = db.prepare('SELECT index_url, synced_at FROM sync').get() as { index_url: string; synced_at: string } | undefined;
        const subjects = (db.prepare('SELECT uri FROM subjects ORDER BY uri').all() as { uri: string }[]).map(({ uri }) => uri);
        return row ? { at: new Date(row.synced_at), index: row.index_url, subjects } : null;
    } finally {
        db.close();
    }
}

interface ListingRow {
    did: string;
    rkey: string;
    subject: string;
    url: string | null;
    domain: string | null;
    title: string | null;
    description: string | null;
    created_at: string;
    handle: string | null;
}

const COLUMNS = 'l.did, l.rkey, l.subject, l.url, l.domain, l.title, l.description, l.created_at, p.handle';

function toListing(row: ListingRow): Listing {
    return {
        did: row.did,
        handle: row.handle ?? undefined,
        name: row.rkey,
        title: row.title ?? undefined,
        description: row.description ?? undefined,
        url: row.url ?? undefined,
        domain: row.domain ?? undefined,
        createdAt: row.created_at,
        install: `@${row.handle ?? row.did}/${row.rkey}`,
        uri: listingUri(row.did, row.rkey),
        for: row.subject === SUBJECT ? undefined : row.subject,
    };
}

/**
 * Every app listed in the index, by name — or, with `for`, the address of an
 * app's listing, every plugin listed for that app. Empty when there is no
 * index yet.
 */
export function listings(path: string = indexPath(), { for: app }: { for?: string | undefined } = {}): Listing[] {
    const db = openForReading(path);
    if (!db) return [];
    try {
        return (db.prepare(`SELECT ${COLUMNS} FROM listings l JOIN publishers p ON p.did = l.did WHERE l.subject = ? ORDER BY l.rkey, coalesce(p.handle, l.did)`)
            .all(app ?? SUBJECT) as unknown as ListingRow[]).map(toListing);
    } finally {
        db.close();
    }
}

/**
 * The listings matching every word of `text` — each word a prefix, anywhere in
 * the name, title, description or publisher's handle — best first. The name
 * counts most, then the title, the handle, and the description least.
 */
export function search(text: string, path: string = indexPath(), { for: app }: { for?: string | undefined } = {}): Listing[] {
    const query = matchQuery(text);
    if (!query) return [];
    const db = openForReading(path);
    if (!db) return [];
    try {
        return (db.prepare(`SELECT ${COLUMNS} FROM listings_fts f JOIN listings l ON l.rowid = f.rowid JOIN publishers p ON p.did = l.did
            WHERE listings_fts MATCH ? AND l.subject = ? ORDER BY bm25(listings_fts, 10.0, 5.0, 1.0, 3.0), l.rkey`)
            .all(query, app ?? SUBJECT) as unknown as ListingRow[]).map(toListing);
    } finally {
        db.close();
    }
}

/**
 * What a person typed, as an FTS5 query: each word a quoted prefix term, so
 * nothing they type is read as query syntax, and all of them required. Words
 * with no letter or digit in them match nothing, and are dropped.
 */
export function matchQuery(text: string): string | null {
    const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
    return words.length ? words.map((word) => `"${word.replace(/"/g, '""')}"*`).join(' ') : null;
}

// ----------------------------------------------------------------- syncing ---

/** What a sync did. */
export interface SyncReport {
    /** Publishers with at least one listing, according to the backlink index. */
    publishers: number;
    /** Listings in the index afterwards. */
    listings: number;
    /** Publishers whose listings were fetched afresh — new, or whose repository moved. */
    refreshed: number;
    /** Publishers dropped, because the backlink index no longer names them. */
    removed: number;
    /** Publishers that could not be reached; what the index had for them is kept. */
    failed: { did: string; error: string }[];
}

/**
 * Bring the index up to date with the network, asking as little as possible.
 *
 * 1. The backlink index names every publisher with an app listed — one request
 *    per hundred listings, and the only full pass — and every publisher of a
 *    plugin for one of `apps`, the listings of the apps installed here. It is
 *    also how a publisher who has taken everything down is noticed: they are
 *    no longer named.
 * 2. Each publisher's PDS is asked for the revision of their repository. When
 *    it is the one already recorded, nothing there has changed, and nothing
 *    more is asked. The concept hash never changes, so this — not the backlink
 *    index — is what notices an edited listing.
 * 3. A publisher whose revision moved, or who is new, has their listings
 *    listed afresh: all of them, usually in one request.
 *
 * Handles are checked both ways when a publisher is first seen and then once a
 * day, since a handle can change without the repository changing. A publisher
 * that cannot be reached keeps what the index had, and is retried next time.
 *
 * The backlink index is asked first, before the file is touched, so a sync
 * that cannot start leaves the index exactly as it was.
 */
export async function syncIndex({ index, path = indexPath(), apps = [], concurrency = 8, handleAge = HANDLE_AGE, ...network }: NetworkOptions & {
    index: string;
    path?: string | undefined;
    /** The listings of the apps installed here, whose plugins to follow. */
    apps?: string[] | undefined;
    concurrency?: number | undefined;
    handleAge?: number | undefined;
}): Promise<SyncReport> {
    const now = (network.now ?? (() => new Date()))();
    const subjects = [SUBJECT, ...new Set(apps.filter((uri) => parseListingUri(uri)))];
    const dids = new Set<string>();
    for (const subject of subjects) {
        for await (const link of backlinks(subject, `${LISTING}:subject`, { ...network, index })) {
            if (link.collection === LISTING && isDid(link.did) && isName(link.rkey)) dids.add(link.did);
        }
    }

    const db = openForWriting(path, index);
    try {
        let removed = 0;
        for (const { did } of db.prepare('SELECT did FROM publishers').all() as { did: string }[]) {
            if (dids.has(did)) continue;
            transaction(db, () => {
                unindex(db, did);
                write(db, 'DELETE FROM listings WHERE did = ?').run(did);
                write(db, 'DELETE FROM publishers WHERE did = ?').run(did);
            });
            removed++;
        }

        let refreshed = 0;
        const failed: { did: string; error: string }[] = [];
        const queue = [...dids].sort();
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
            for (let did = queue.shift(); did !== undefined; did = queue.shift()) {
                try {
                    if (await refreshPublisher(db, did, now, handleAge, network)) refreshed++;
                } catch (err) {
                    const error = err instanceof Error ? err.message : String(err);
                    failed.push({ did, error });
                    write(db, 'INSERT INTO publishers (did, error) VALUES (?, ?) ON CONFLICT (did) DO UPDATE SET error = excluded.error').run(did, error);
                }
            }
        }));

        transaction(db, () => {
            write(db, 'INSERT OR REPLACE INTO sync (id, index_url, synced_at) VALUES (1, ?, ?)').run(index, now.toISOString());
            write(db, 'DELETE FROM subjects').run();
            for (const subject of subjects) write(db, 'INSERT INTO subjects (uri) VALUES (?)').run(subject);
        });
        const count = (db.prepare('SELECT count(*) AS n FROM listings').get() as { n: number }).n;
        return { publishers: dids.size, listings: count, refreshed, removed, failed: failed.sort((a, b) => a.did.localeCompare(b.did)) };
    } finally {
        db.close();
    }
}

interface PublisherRow {
    did: string;
    handle: string | null;
    handle_checked_at: string | null;
    pds: string | null;
    rev: string | null;
}

// One publisher: is their repository where it was, and if not, what do they
// list now. True when their listings were fetched.
async function refreshPublisher(db: DatabaseSync, did: string, now: Date, handleAge: number, network: NetworkOptions): Promise<boolean> {
    const row = db.prepare('SELECT did, handle, handle_checked_at, pds, rev FROM publishers WHERE did = ?').get(did) as PublisherRow | undefined;
    const handleDue = !row?.handle_checked_at || now.getTime() - Date.parse(row.handle_checked_at) > handleAge;

    // The DID document says where the repository is and what the handle is.
    // It is fetched when either needs finding out, and otherwise the PDS on
    // record is asked directly.
    let pds = row?.pds ?? null;
    let handle = row?.handle ?? null;
    let handleCheckedAt = row?.handle_checked_at ?? null;
    let fresh = false;
    const lookUp = async () => {
        const doc = await fetchDidDocument(did, network);
        pds = pdsEndpoint(doc);
        fresh = true;
        return doc;
    };
    if (!pds || handleDue) {
        const doc = await lookUp();
        if (handleDue) {
            handle = await checkHandle(doc, network);
            handleCheckedAt = now.toISOString();
        }
    }

    let rev: string;
    try {
        rev = await latestRev(pds!, did, network);
    } catch (err) {
        // An account that moved to another PDS is found again through its
        // DID document; a PDS that is simply down is reported.
        if (fresh) throw err;
        const before = pds;
        await lookUp();
        if (pds === before) throw err;
        rev = await latestRev(pds!, did, network);
    }

    const moved = !row || row.rev !== rev;
    const listed = moved ? await listListings(pds!, did, network) : null;

    transaction(db, () => {
        write(db, `INSERT INTO publishers (did, handle, handle_checked_at, pds, rev, synced_at, error) VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT (did) DO UPDATE SET handle = excluded.handle, handle_checked_at = excluded.handle_checked_at,
            pds = excluded.pds, rev = excluded.rev, synced_at = excluded.synced_at, error = NULL`)
            .run(did, handle, handleCheckedAt, pds, rev, now.toISOString());
        if (listed || handle !== (row?.handle ?? null)) unindex(db, did);
        if (listed) {
            write(db, 'DELETE FROM listings WHERE did = ?').run(did);
            const insert = write(db, 'INSERT INTO listings (did, rkey, cid, subject, url, domain, title, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const { name, cid, record } of listed) {
                insert.run(did, name, cid, record.subject, record.url ?? null, record.domain ?? null, record.title ?? null, record.description ?? null, record.createdAt);
            }
        }
        if (listed || handle !== (row?.handle ?? null)) reindex(db, did, handle);
    });
    return moved;
}

// The handle the DID document claims, if it claims one and it points back.
async function checkHandle(doc: DidDocument, network: NetworkOptions): Promise<string | null> {
    const handle = claimedHandle(doc)?.toLowerCase();
    if (!handle) return null;
    try {
        return (await resolveHandle(handle, network)).did === doc.id ? handle : null;
    } catch {
        return null;
    }
}

async function latestRev(pds: string, did: string, network: NetworkOptions): Promise<string> {
    const commit = await xrpcJson(pds, 'com.atproto.sync.getLatestCommit', { did }, network) as { rev?: unknown };
    if (typeof commit.rev !== 'string' || !commit.rev) throw new Error(`${pds} gave no revision for ${did}`);
    return commit.rev;
}

// Everything `did` lists, as the PDS lists it. These reads are not verified:
// nothing is installed from the index, and an install fetches the record again
// with its proof. What does not read as a listing is left out.
async function listListings(pds: string, did: string, network: NetworkOptions): Promise<{ name: string; cid: string; record: ListingRecord }[]> {
    const found: { name: string; cid: string; record: ListingRecord }[] = [];
    const prefix = `at://${did}/${LISTING}/`;
    let cursor: string | undefined;
    do {
        const page = await xrpcJson(pds, 'com.atproto.repo.listRecords',
            { repo: did, collection: LISTING, limit: '100', ...(cursor ? { cursor } : {}) }, network) as {
            records?: { uri?: string; cid?: string; value?: Value }[]; cursor?: string;
        };
        for (const { uri, cid, value } of page.records ?? []) {
            if (!uri?.startsWith(prefix) || !cid) continue;
            const name = uri.slice(prefix.length);
            const read = readListing(value ?? null, name);
            if (read.ok) found.push({ name, cid, record: read.record });
        }
        cursor = page.records?.length ? page.cursor : undefined;
    } while (cursor);
    return found;
}

// The full-text rows share their listing's rowid, and carry the handle too, so
// they are rewritten whenever either changes.
function unindex(db: DatabaseSync, did: string): void {
    write(db, 'DELETE FROM listings_fts WHERE rowid IN (SELECT rowid FROM listings WHERE did = ?)').run(did);
}

function reindex(db: DatabaseSync, did: string, handle: string | null): void {
    write(db, `INSERT INTO listings_fts (rowid, rkey, title, description, handle)
        SELECT rowid, rkey, title, description, ? FROM listings WHERE did = ?`).run(handle, did);
}

// A statement that changes the index. Whatever it changes, `run()` reports
// SQLite's last-inserted row id — the connection's, not the statement's — and
// node:sqlite refuses to turn one past 2^53 into a number, throwing after the
// statement has done its work. Deleting from the contentless-delete full-text
// table writes a tombstone page whose row id, (segment + 2^16) << 37, is
// always past it, and it stays the last-inserted one until the next insert.
// So every write reports in BigInts, which nothing here reads anyway.
function write(db: DatabaseSync, sql: string): StatementSync {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
}

function transaction(db: DatabaseSync, body: () => void): void {
    db.exec('BEGIN');
    try {
        body();
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
