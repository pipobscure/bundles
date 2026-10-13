import * as CRYPTO from 'node:crypto';
import * as DNS from 'node:dns';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { isDid, parseAttester, type Attester } from './attestation.ts';
import { deleteAll, getRecord, listOwn, putAll, type NetworkOptions, type Session } from './atproto.ts';
import { isName, parseListingUri } from './listing.ts';
import { isScope } from './scopes.ts';
import { patientFetch } from './ratelimit.ts';
import type { Minimum } from './review.ts';
import { encode, type Value } from './repo.ts';

// Suites: listed bundles, installed together.
//
// A publisher writes a suite to their repository, under a name, naming the
// listings that go together — and, for each, where it goes and what it must
// carry:
//
//   at://<did>/com.pipobscure.bundle.suite/devtools
//   { "subject": "sha256:<sha256 of this NSID>",
//     "members": [
//       { "listing": "at://…/com.pipobscure.bundle.listing/bled",
//         "require": { "identity": "https://github.com/…", "issuer": "https://token.actions.githubusercontent.com" } },
//       { "listing": "at://…/com.pipobscure.bundle.listing/bled-gpio",
//         "for": "at://…/com.pipobscure.bundle.listing/bled",
//         "require": { "attesters": ["published@did:plc:…"] } } ], … }
//
// and anyone installs them all with `bundle install @<handle>/devtools`.
//
// The suite vouches for nothing, as a listing does not. Its `require` is a
// floor: a member that does not carry it is refused, at install and at every
// update — but one that does is not thereby accepted. What it does make
// possible is asking once: whoever installs is shown, up front, every signer
// and attester the suite expects, and what they accept counts for every
// member, rather than each being a question of its own (see suite-install.ts).
//
// A suite is written from a spec, a JSON file the publisher keeps — the record
// as it will be published, plus its name — which `bundle suite add` and
// `bundle suite remove` edit, and `bundle suite publish` writes out.
// schemas/suite.schema.json describes it for editors.
//
// Or the spec itself is published, by DNS: a domain's TXT record
//
//   nsuite:<url>
//
// names where it is served, as `nzip:<url>` names an archive, and
// `bundle install <domain>` installs the suite it serves. Like an `nzip:`
// record, that says only what the suite is; every member is reviewed as ever.

/** The record type, and the collection suites live in. */
export const SUITE = 'com.pipobscure.bundle.suite';

/** The `subject` of every suite: the sha256 of the NSID, for a backlink index to enumerate them by. */
export const SUITE_SUBJECT = `sha256:${CRYPTO.createHash('sha256').update(SUITE).digest('hex')}`;

/** How many listings a suite may name. */
export const MAX_MEMBERS = 64;

/** One listing in a suite. */
export interface SuiteMember {
    /** The `at://` address of the listing. */
    listing: string;
    /**
     * Install it as a plugin: for the app installed from the listing at this
     * `at://` address, or into this scope (a package name). Without it, an
     * app installs onto the PATH, and a plugin for the app its listing names.
     */
    for?: string | undefined;
    /** What it must carry to be installed at all. */
    require?: SuiteRequire | undefined;
}

/** A suite's minimum for one member. Meeting it vouches for nothing. */
export interface SuiteRequire {
    identity?: string | undefined;
    issuer?: string | undefined;
    /** `[kind@]<did>`. */
    attesters?: string[] | undefined;
    quorum?: number | undefined;
}

/** The record as it is written. */
export interface SuiteRecord {
    $type: typeof SUITE;
    subject: string;
    members: SuiteMember[];
    title?: string | undefined;
    description?: string | undefined;
    createdAt: string;
}

/** What a suite says, wherever it was published. */
export type SuiteContent = Pick<SuiteRecord, 'members' | 'title' | 'description'>;

/** A suite as found: fetched from its publisher's PDS and verified, or served where a domain's `nsuite:` record says. */
export interface FoundSuite {
    name: string;
    /** How it is found again: its `at://` address, or the domain. */
    uri: string;
    /** The publisher, for a suite in an atproto repository. */
    did?: string | undefined;
    /** Where it was served from, for a suite published by DNS. */
    url?: string | undefined;
    record: SuiteContent;
}

/** The `at://` address of `did`'s suite called `name`. */
export function suiteUri(did: string, name: string): string {
    return `at://${did}/${SUITE}/${name}`;
}

/** The DID and name in a suite's `at://` address, or null when it is not one. */
export function parseSuiteUri(uri: string): { did: string; name: string } | null {
    const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
    if (!m || m[2] !== SUITE || !isDid(m[1]!) || !isName(m[3]!)) return null;
    return { did: m[1]!, name: m[3]! };
}

// The lexicon's limits, which a PDS validating against it would apply too.
const LIMITS = { title: [640, 64], description: [3000, 300] } as const;

/** What a record says, or why it is not a suite this tool will use. */
export function readSuite(value: Value, name: string): { ok: true; record: SuiteRecord } | { ok: false; reason: string } {
    const record = value as Partial<SuiteRecord> | null;
    if (!record || typeof record !== 'object' || record.$type !== SUITE) return { ok: false, reason: `the record is not a ${SUITE}` };
    if (!isName(name)) return { ok: false, reason: `'${name}' is not a usable name (lowercase letters, digits and '-', at most 64)` };
    if (record.subject !== SUITE_SUBJECT) return { ok: false, reason: `its subject is not ${SUITE_SUBJECT}` };
    const members = membersProblem(record.members);
    if (members) return { ok: false, reason: members };
    for (const field of ['title', 'description'] as const) {
        const text = record[field];
        if (text === undefined) continue;
        if (typeof text !== 'string') return { ok: false, reason: `its ${field} is not text` };
        const [bytes, graphemes] = LIMITS[field];
        if (Buffer.byteLength(text) > bytes || [...new Intl.Segmenter().segment(text)].length > graphemes) return { ok: false, reason: `its ${field} is longer than ${graphemes} characters` };
    }
    if (typeof record.createdAt !== 'string') return { ok: false, reason: 'it has no createdAt' };
    return { ok: true, record: record as SuiteRecord };
}

/** What is wrong with a suite's members, or undefined when nothing is. */
export function membersProblem(members: unknown): string | undefined {
    if (!Array.isArray(members) || !members.length) return 'a suite names at least one member';
    if (members.length > MAX_MEMBERS) return `a suite names at most ${MAX_MEMBERS} members`;
    const seen = new Set<string>();
    for (const member of members as unknown[]) {
        const { listing, for: scope, require } = (member ?? {}) as Record<string, unknown>;
        if (typeof listing !== 'string' || !parseListingUri(listing)) return `member '${String(listing)}' is not the at:// address of a listing`;
        if (seen.has(listing)) return `member ${listing} is named twice`;
        seen.add(listing);
        if (scope !== undefined && (typeof scope !== 'string' || !(isScope(scope) || parseListingUri(scope)))) {
            return `member ${listing}: '${String(scope)}' is neither an app's listing nor a scope (a package name)`;
        }
        if (scope === listing) return `member ${listing} is for itself`;
        if (require !== undefined) {
            const why = requireProblem(require);
            if (why) return `member ${listing}: ${why}`;
        }
    }
    return undefined;
}

/** What is wrong with a member's `require`, or undefined when nothing is. */
export function requireProblem(require: unknown): string | undefined {
    if (!require || typeof require !== 'object' || Array.isArray(require)) return 'its require is not an object';
    const { identity, issuer, attesters, quorum } = require as Record<string, unknown>;
    if (identity !== undefined && (typeof identity !== 'string' || !identity || identity.length > 2048)) return 'its required identity is not usable';
    if (issuer !== undefined && (typeof issuer !== 'string' || !/^https:\/\/[^/]/.test(issuer))) return `its required issuer '${String(issuer)}' is not an https URL`;
    if (attesters !== undefined) {
        if (!Array.isArray(attesters) || attesters.length > 32) return 'its required attesters are not a list of at most 32';
        for (const spec of attesters as unknown[]) {
            let did: string | undefined;
            try {
                did = typeof spec === 'string' ? parseAttester(spec).subject : undefined;
            } catch {
                did = undefined;
            }
            if (!did || !isDid(did)) return `its required attester '${String(spec)}' is not [kind@]<did>`;
        }
    }
    if (quorum !== undefined) {
        const count = Array.isArray(attesters) ? attesters.length : 0;
        if (!Number.isInteger(quorum) || (quorum as number) < 1 || (quorum as number) > count) return `its quorum must be between 1 and the number of attesters (${count})`;
    }
    return undefined;
}

/** A member as it is written: what this tool reads of it, and nothing else. */
export function cleanMember({ listing, for: scope, require }: SuiteMember): SuiteMember {
    const r = require && {
        ...(require.identity !== undefined ? { identity: require.identity } : {}),
        ...(require.issuer !== undefined ? { issuer: require.issuer } : {}),
        ...(require.attesters?.length ? { attesters: [...require.attesters] } : {}),
        ...(require.quorum !== undefined ? { quorum: require.quorum } : {}),
    };
    return { listing, ...(scope !== undefined ? { for: scope } : {}), ...(r && Object.keys(r).length ? { require: r } : {}) };
}

/** A member's `require` as the review takes it: a floor, from `source`. */
export function minimumOf(require: SuiteRequire | undefined, source: string): Minimum | undefined {
    if (!require || (!require.identity && !require.issuer && !require.attesters?.length)) return undefined;
    const attesters: Attester[] | undefined = require.attesters?.map((spec) => {
        const { subject, kind } = parseAttester(spec);
        return { did: subject, kind };
    });
    return { identity: require.identity, issuer: require.issuer, attesters, quorum: require.quorum, source };
}

/**
 * What a suite is, as a hash: the sha256 of the DAG-CBOR encoding of
 * `{ members }`, each member as it is published — the listings, where each
 * goes, and what each must carry. Its title and description are left out:
 * they say nothing about what is installed. The same suite has the same hash
 * wherever it is published, and any change to it makes another.
 *
 * It is what an attestation of a suite names, in the same collection, at the
 * same kind of key, as an attestation of an archive — so `bundle suite
 * attest` is `bundle attest` for a suite, and such an attestation counts for
 * each member installed from that suite.
 */
export function suiteHash(content: Pick<SuiteContent, 'members'>): { hashAlg: 'sha256'; hex: string } {
    const bytes = encode({ members: content.members.map(cleanMember) } as unknown as Value);
    return { hashAlg: 'sha256', hex: CRYPTO.createHash('sha256').update(bytes).digest('hex') };
}

// --------------------------------------------------------------- resolving ---

/** `did`'s suite called `name`, fetched with its proof and verified — or null when there is none. */
export async function fetchSuite(did: string, name: string, options: NetworkOptions = {}): Promise<FoundSuite | null> {
    const found = await getRecord(did, SUITE, name, options);
    if (!found) return null;
    const read = readSuite(found.value, name);
    if (!read.ok) throw new Error(`${suiteUri(did, name)}: ${read.reason}`);
    return { did, name, uri: suiteUri(did, name), record: read.record };
}

/** The suite at an `at://` address, as it is now — what an installed suite is remembered by. */
export async function followSuite(uri: string, options: NetworkOptions = {}): Promise<FoundSuite> {
    const parsed = parseSuiteUri(uri);
    if (!parsed) throw new Error(`'${uri}' is not the address of a suite`);
    const found = await fetchSuite(parsed.did, parsed.name, options);
    if (!found) throw new Error(`${uri} has been taken down`);
    return found;
}

/**
 * The suite a domain publishes: its `nsuite:<url>` TXT record names where the
 * spec is served — an absolute `https:` URL, or a reference resolved against
 * `https://<domain>/` — and the spec is fetched and checked. A domain that
 * publishes an `nzip:` record too is refused: it would not be clear which
 * `bundle install <domain>` means.
 */
export async function resolveSuiteDomain(
    domain: string,
    { resolveTxt = DNS.promises.resolveTxt, answers }: {
        resolveTxt?: ((domain: string) => Promise<string[][]>) | undefined;
        /** The domain's TXT records, when they have been looked up already. */
        answers?: string[][] | undefined;
    } = {},
): Promise<FoundSuite> {
    const host = domain.replace(/\.$/, '').toLowerCase();
    const texts = [...new Set((answers ?? await resolveTxt(host)).map((chunks) => chunks.join('').trim()))];
    const entries = texts.filter((text) => text.startsWith('nsuite:'));
    if (!entries.length) throw new Error(`${host} publishes no 'nsuite:<url>' TXT record`);
    if (entries.length > 1) throw new Error(`${host} publishes ${entries.length} different 'nsuite:' records — refusing to guess between them`);
    if (texts.some((text) => text.startsWith('nzip:'))) throw new Error(`${host} publishes both an 'nzip:' and an 'nsuite:' record — refusing to guess which is meant`);
    const reference = entries[0]!.slice('nsuite:'.length).trim();
    let url: URL;
    try {
        url = new URL(reference, `https://${host}/`);
    } catch {
        throw new Error(`${host}: '${reference}' is not a URL`);
    }
    if (url.protocol !== 'https:') throw new Error(`${host}: '${reference}' is not https — refusing to fetch a suite over ${url.protocol.replace(/:$/, '')}`);

    return { ...await fetchSuiteUrl(url.href), uri: host };
}

/**
 * The suite served at an `https:` URL, as a spec — what a domain's `nsuite:`
 * record names, or a URL given to `bundle install` directly. `bytes`, when
 * the URL has been fetched already.
 */
export async function fetchSuiteUrl(url: string, bytes?: Buffer | undefined): Promise<FoundSuite> {
    if (!/^https:\/\//i.test(url)) throw new Error(`'${url}' is not https — refusing to fetch a suite over anything else`);
    let body = bytes;
    if (!body) {
        const response = await patientFetch()(url, { redirect: 'follow' });
        if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
        body = Buffer.from(await response.arrayBuffer());
    }
    let spec: unknown;
    try {
        spec = JSON.parse(body.toString('utf-8'));
    } catch {
        throw new Error(`${url} is not JSON`);
    }
    const problems = checkSpec(spec);
    if (problems.length) throw new Error(`${url} is not a suite: ${problems.join('; ')}`);
    const { name, members, title, description } = spec as SuiteSpec;
    return { name, uri: url, url, record: { members: members.map(cleanMember), title, description } };
}

/**
 * Whether fetched bytes are a suite rather than an archive: JSON, which
 * starts with `{`, where an archive starts with a zip header or a launcher's
 * `#!`.
 */
export function looksLikeSuite(bytes: Buffer): boolean {
    for (const byte of bytes.subarray(0, 64)) {
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0xef || byte === 0xbb || byte === 0xbf) continue;
        return byte === 0x7b;
    }
    return false;
}

// -------------------------------------------------------------- publishing ---

/**
 * Write a suite from a spec to the session's account. Publishing it again
 * replaces it, keeping when it was first published. One read of the account's
 * suites, one write, and nothing read back.
 */
export async function publishSuite(session: Session, spec: SuiteSpec, options: NetworkOptions = {}): Promise<{ uri: string; replaced: boolean; record: SuiteRecord }> {
    const problems = checkSpec(spec);
    if (problems.length) throw new Error(`refusing to publish ${spec.name ?? 'the suite'}: ${problems.join('; ')}`);
    const existing = await listOwn(session, SUITE, options);
    const before = existing.get(spec.name);
    const previous = before ? readSuite(before, spec.name) : null;
    const record: SuiteRecord = {
        $type: SUITE,
        subject: SUITE_SUBJECT,
        members: spec.members.map(cleanMember),
        ...(spec.title ? { title: spec.title } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        createdAt: previous?.ok ? previous.record.createdAt : (options.now ?? (() => new Date()))().toISOString(),
    };
    const checked = readSuite(record as unknown as Value, spec.name);
    if (!checked.ok) throw new Error(`refusing to publish ${spec.name}: ${checked.reason}`);
    await putAll(session, SUITE, [{ rkey: spec.name, record: record as unknown as Record<string, unknown> }], { ...options, existing });
    return { uri: suiteUri(session.did, spec.name), replaced: Boolean(before), record };
}

/** Take a suite down. False when there was none. Installs of it keep what they have. */
export async function unpublishSuite(session: Session, name: string, options: NetworkOptions = {}): Promise<boolean> {
    if (!isName(name)) throw new Error(`'${name}' is not a suite name`);
    const existing = await listOwn(session, SUITE, options);
    if (!existing.has(name)) return false;
    await deleteAll(session, SUITE, [name], { ...options, existing });
    return true;
}

// -------------------------------------------------------------------- spec ---

/** A suite as its publisher keeps it: the record to publish, and its name. */
export interface SuiteSpec {
    $schema?: string | undefined;
    /** The record key it is published under, and what it installs as. */
    name: string;
    title?: string | undefined;
    description?: string | undefined;
    members: SpecMember[];
}

/** A member as its spec keeps it: as published, and as it was typed. */
export interface SpecMember extends SuiteMember {
    /** What it was added as, as typed (`@pipobscure.com/bled`): for whoever reads the file. Not published. */
    label?: string | undefined;
    /** The same for `for`. Not published. */
    forLabel?: string | undefined;
}

/** Where the JSON Schema for suite specs is served: a release's, or the latest. */
export function suiteSchemaUrl(version?: string | undefined): string {
    const releases = 'https://github.com/pipobscure/bundles/releases';
    return version ? `${releases}/download/v${version}/suite.schema.json` : `${releases}/latest/download/suite.schema.json`;
}

/** What is wrong with a spec: nothing, or why it could not be published. */
export function checkSpec(spec: unknown): string[] {
    const problems: string[] = [];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['it is not a JSON object'];
    const { $schema: _, name, title, description, members, ...rest } = spec as Record<string, unknown>;
    // Unknown settings are an error, as in a policy file, so a typo is not quietly ignored.
    for (const key of Object.keys(rest)) problems.push(`'${key}' is not a suite setting`);
    if (typeof name !== 'string' || !isName(name)) problems.push(`its name '${String(name)}' is not usable (lowercase letters, digits and '-', at most 64)`);
    if (title !== undefined && typeof title !== 'string') problems.push('its title is not text');
    if (description !== undefined && typeof description !== 'string') problems.push('its description is not text');
    const wrong = membersProblem(members);
    if (wrong) problems.push(wrong);
    if (Array.isArray(members)) {
        for (const member of members as Record<string, unknown>[]) {
            const { listing: __, for: ___, require: ____, label, forLabel, ...extra } = member ?? {};
            for (const key of Object.keys(extra)) problems.push(`member ${String(member?.['listing'])}: '${key}' is not a member setting`);
            if (label !== undefined && typeof label !== 'string') problems.push(`member ${String(member?.['listing'])}: its label is not text`);
            if (forLabel !== undefined && typeof forLabel !== 'string') problems.push(`member ${String(member?.['listing'])}: its forLabel is not text`);
        }
    }
    return problems;
}

/** A spec file, read and checked; or, when `create` and there is none, a new one named after the file. */
export function readSpec(path: string, { create = false }: { create?: boolean } = {}): SuiteSpec {
    let text: string;
    try {
        text = FS.readFileSync(path, 'utf-8');
    } catch (err) {
        if (create && (err as { code?: string }).code === 'ENOENT') {
            const name = PATH.basename(path).replace(/\.suite\.json$|\.json$/i, '').toLowerCase();
            if (!isName(name)) throw new Error(`${path} does not exist, and '${name}' cannot be a suite's name — create it with a "name"`);
            return { name, members: [] };
        }
        throw err;
    }
    let spec: unknown;
    try {
        spec = JSON.parse(text);
    } catch (err) {
        throw new Error(`${path} is not JSON: ${(err as Error).message}`);
    }
    // An empty suite is a spec being written, not a broken one.
    const problems = checkSpec(spec).filter((problem) => !(problem === 'a suite names at least one member' && Array.isArray((spec as SuiteSpec).members)));
    if (problems.length) throw new Error(`${path}: ${problems.join('; ')}`);
    return spec as SuiteSpec;
}

/** Write a spec, `$schema` first, so an editor can help with it. */
export function writeSpec(path: string, spec: SuiteSpec, version?: string | undefined): void {
    const { $schema: _, ...rest } = spec;
    const temporary = `${path}.incoming-${process.pid}`;
    FS.writeFileSync(temporary, `${JSON.stringify({ $schema: suiteSchemaUrl(version), ...rest }, null, 2)}\n`);
    FS.renameSync(temporary, path);
}
