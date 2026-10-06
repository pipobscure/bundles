import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as DNS from 'node:dns';
import { packageRoot } from './files.ts';
import { getRecord, putRecord, type NetworkOptions, type Session } from './atproto.ts';

// Publishing this package's lexicons, so the rest of the network can resolve
// what a `com.pipobscure.bundle.attestation` record is.
//
// atproto resolves a lexicon from its NSID in two hops:
//
//   1. **DNS.** The NSID without its last segment, reversed, is a domain — the
//      authority. `com.pipobscure.bundle.attestation` → `bundle.pipobscure.com`.
//      A TXT record at `_lexicon.<authority>` says `did=<DID>`: the account
//      whose repository holds the schemas. It is not hierarchical, so every
//      lexicon under one authority lives in that one repository.
//   2. **The record.** In that repository, `com.atproto.lexicon.schema/<NSID>`
//      holds the lexicon document itself.
//
// The DNS record is the domain owner's to make, and nothing here can make it;
// what this can do is write the schema records, check that DNS points at the
// account writing them, and check afterwards that what is published is what
// this package carries.
//
// The documents are the JSON files under `lexicons/` in this package — the same
// files a reader of the repository sees — and are the single source of truth.

/** The collection lexicon schemas are published in. */
export const SCHEMA_COLLECTION = 'com.atproto.lexicon.schema';

/** A lexicon document, as this package carries it. */
export interface LexiconDocument {
    lexicon: 1;
    id: string;
    defs: Record<string, unknown>;
    [key: string]: unknown;
}

/** Where this package's lexicons are (`lexicons/`, beside package.json). */
export function lexiconDir(): string {
    return PATH.join(packageRoot(), 'lexicons');
}

/** Every lexicon document this package carries, by NSID. */
export function lexicons(dir: string = lexiconDir()): LexiconDocument[] {
    const found: LexiconDocument[] = [];
    const walk = (at: string) => {
        for (const entry of FS.readdirSync(at, { withFileTypes: true })) {
            const path = PATH.join(at, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith('.json')) {
                const doc = JSON.parse(FS.readFileSync(path, 'utf-8')) as LexiconDocument;
                // The file's place in the tree must say what its id says, so the
                // repository layout can be trusted as an index.
                const expected = PATH.join(dir, ...doc.id.split('.')) + '.json';
                if (PATH.resolve(path) !== PATH.resolve(expected)) throw new Error(`${path} holds ${doc.id}, which belongs at ${expected}`);
                if (doc.lexicon !== 1 || !doc.defs) throw new Error(`${path} is not a lexicon document`);
                found.push(doc);
            }
        }
    };
    walk(dir);
    return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** The domain an NSID's authority is: everything but the name, reversed. */
export function authorityOf(nsid: string): string {
    const parts = nsid.split('.');
    if (parts.length < 3) throw new Error(`'${nsid}' is not an NSID`);
    return parts.slice(0, -1).reverse().join('.');
}

/** The DID `_lexicon.<authority>` names for an NSID, or null when there is no such record. */
export async function authorityDid(nsid: string, options: NetworkOptions = {}): Promise<string | null> {
    const name = `_lexicon.${authorityOf(nsid)}`;
    try {
        const records = await (options.resolveTxt ?? DNS.promises.resolveTxt)(name);
        const dids = [...new Set(records.map((chunks) => chunks.join('')).filter((text) => text.startsWith('did=')))];
        if (dids.length > 1) throw new Error(`${name} names ${dids.length} different DIDs`);
        return dids[0]?.slice('did='.length) ?? null;
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return null;
        throw err;
    }
}

/** What is known about one lexicon's publication. */
export interface LexiconStatus {
    nsid: string;
    /** The TXT record that should exist. */
    dns: string;
    /** The DID it names, if it exists. */
    authority: string | null;
    /** Whether the published schema is this package's document, if one is published. */
    state: 'current' | 'different' | 'unpublished' | 'no-authority';
    uri?: string | undefined;
}

/**
 * Where each lexicon stands: does DNS name an authority, does that authority
 * publish the schema, and is it the document this package carries? The
 * published record is fetched with its proof and verified.
 */
export async function checkLexicons(options: NetworkOptions = {}, docs: LexiconDocument[] = lexicons()): Promise<LexiconStatus[]> {
    const statuses: LexiconStatus[] = [];
    for (const doc of docs) {
        const dns = `_lexicon.${authorityOf(doc.id)}`;
        const authority = await authorityDid(doc.id, options);
        if (!authority) {
            statuses.push({ nsid: doc.id, dns, authority, state: 'no-authority' });
            continue;
        }
        const uri = `at://${authority}/${SCHEMA_COLLECTION}/${doc.id}`;
        const published = await getRecord(authority, SCHEMA_COLLECTION, doc.id, options);
        statuses.push({
            nsid: doc.id, dns, authority, uri,
            state: !published ? 'unpublished' : same(published.value, schemaRecord(doc)) ? 'current' : 'different',
        });
    }
    return statuses;
}

/** The record a lexicon document is published as. */
export function schemaRecord(doc: LexiconDocument): Record<string, unknown> {
    return { $type: SCHEMA_COLLECTION, ...doc };
}

/**
 * Publish every lexicon this package carries from `session`'s account, and
 * read each back to confirm what landed is what was sent. DNS is checked
 * first: a schema published from an account the authority does not name is
 * one nobody can resolve, so that is refused unless `force` says otherwise.
 */
export async function publishLexicons(session: Session, { force = false, ...options }: NetworkOptions & { force?: boolean | undefined } = {},
    docs: LexiconDocument[] = lexicons()): Promise<{ nsid: string; uri: string; dns: string; authority: string | null }[]> {
    const written: { nsid: string; uri: string; dns: string; authority: string | null }[] = [];
    for (const doc of docs) {
        const dns = `_lexicon.${authorityOf(doc.id)}`;
        const authority = await authorityDid(doc.id, options);
        if (authority !== session.did && !force) {
            throw new Error(authority
                ? `${dns} names ${authority}, not ${session.did} — publish from that account, or change the record`
                : `${dns} has no 'did=' TXT record yet; add 'did=${session.did}' there first (or pass --force to publish anyway)`);
        }
        const { uri } = await putRecord(session, SCHEMA_COLLECTION, doc.id, schemaRecord(doc), options);
        const back = await getRecord(session.did, SCHEMA_COLLECTION, doc.id, options);
        if (!back || !same(back.value, schemaRecord(doc))) throw new Error(`${uri} was written, but does not read back as the document that was sent`);
        written.push({ nsid: doc.id, uri, dns, authority });
    }
    return written;
}

// Structural equality of a decoded record and a JSON document: the same keys
// with the same values, whatever order either was written in.
function same(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const keys = Object.keys(a as object).sort();
        const other = Object.keys(b as object).sort();
        return keys.length === other.length && keys.every((key, i) => key === other[i]
            && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
    }
    return a === b;
}
