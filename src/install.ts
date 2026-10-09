import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import * as DNS from 'node:dns';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patientFetch } from './ratelimit.ts';
import { STATES, message, type VerificationState } from './manifest.ts';
import { formatAttester, parseAttester, stateDir, type Attester } from './attestation.ts';
import * as ZLIB from 'node:zlib';
import { loadPolicy, type Policy, type Signer } from './policy.ts';
import { isScope, scopeDir, pluginFile, linkFile, pluginsDir, labelFile } from './scopes.ts';
import {
    gather, gatherSync, judge, accept, noneAccepted, refusal,
    type Accepted, type Demands, type Review, type ReviewItem, type Gathered,
} from './review.ts';
import type { NetworkOptions } from './atproto.ts';

const require = createRequire(import.meta.url);

// Getting a signed archive onto your PATH, and keeping it current.
//
// This is `curl | sh` with the two things that make that pattern dangerous
// removed: nothing is executed to install it, and nothing lands on disk that
// did not verify first. The whole operation is download, check the signature,
// rename into place, remember where it came from.
//
//   bundle install https://example.com/tool.nzip
//   bundle install example.com
//   bundle update tool.nzip
//   bundle update
//
// **Nothing is installed that nobody vouches for, and whom to believe is the
// user's decision.** Everything that vouches for an archive is gathered — its
// signature, and every attestation of its hash, including ones a backlink index
// finds — and shown (see review.ts). Evidence from someone accepted for this
// install before, trusted by the machine's policy, demanded by a flag, or a
// certificate anchored in the trust store, proceeds. Anything else is a question
// for the person installing, and an answer of yes is remembered.
//
// Updates work the same way, against what was accepted so far. A new version
// signed by a different identity, or attested by different people, is not a
// failure: it is a question. The things that *refuse* an archive are the ones
// someone deliberately made mandatory — `--identity`, `--issuer`, `--attester`
// on the command line, the policy file's requirements, a blocking attester's
// bad verdict — and an archive whose bytes or signature do not verify. That is
// what lets a publisher move their releases somewhere else without breaking
// every install of what they publish.
//
// Attestations are fetched fresh for each install and update — this is the
// online step — so for a `.nzip`, which the shell launcher runs without
// verifying, the attestation cache's freshness window never comes into it.
//
// Updates are conditional requests. The record keeps the ETag the server gave,
// an update sends it back as `If-None-Match`, and a 304 means there is nothing
// to do — so `bundle update` over a dozen installs is a dozen cheap requests.

/**
 * Where this package's own release lives, and who signs it — what `bundle
 * install` with no URL fetches.
 *
 * It is a constant rather than something read out of `package.json`, because it
 * is a *trust* statement: the identity below is accepted for this package's own
 * install without asking, and a value that could be edited by whatever is being
 * installed would not be worth having. It is trusted rather than required, so a
 * release signed some other way is a question rather than a refusal.
 * `BUNDLE_SELF_SOURCE` overrides the URL for a mirror; the trust goes with it.
 */
export const SELF = {
    url: 'https://github.com/pipobscure/bundles/releases/latest/download/bundle.nzip',
    identity: 'https://github.com/pipobscure/bundles/.github/workflows/publish.yml@refs/heads/main',
    issuer: 'https://token.actions.githubusercontent.com',
} as const;

/** The self-install target, with the environment's override applied. */
export function self(): { url: string; identity: string; issuer: string } {
    return { ...SELF, url: process.env['BUNDLE_SELF_SOURCE'] || SELF.url };
}

/** What an installed archive is, and where it came from. */
export interface InstallRecord {
    /**
     * The key in the record: the file name an app was installed as, or for a
     * plugin `<scope>:<package name>` (`bled:@alice/bled-gpio`).
     */
    name: string;
    /** For a plugin: the scope it was installed into — the package name of the app it is for. */
    scope?: string | undefined;
    /** The package name inside the archive, when it has one. */
    package?: string | undefined;
    /**
     * For a plugin: what `bundle install --for` was given, as typed. It is
     * what `list()` tells an app it is called, and only identifies; two
     * plugins can share one.
     */
    label?: string | undefined;
    /** Where in `dir` the file is, when that is not `name` — a plugin's `@alice/bled-gpio.nzip`. */
    file?: string | undefined;
    /**
     * For a plugin linked for development: the folder it is loaded from, as
     * it is. Nothing is fetched, reviewed or verified, and anything that
     * verifies plugins refuses it.
     */
    link?: string | undefined;
    /**
     * How it was installed, which is what an update asks again: a URL; a
     * domain, whose `nzip:` TXT record names the URL; or the `at://` address of
     * a listing, which does. Absent in older records — see `sourceOf()`.
     */
    source?: string | undefined;
    /** Where it was last fetched from — what the source named then. */
    url: string;
    /** Older records: the domain whose `nzip:` record named the URL. Read as the source. */
    alias?: string | undefined;
    /** The server's ETag, for the conditional request an update makes. */
    etag?: string | undefined;
    /** `Last-Modified`, used when there is no ETag. */
    lastModified?: string | undefined;
    /** The sigstore identity that signed the installed version. */
    identity?: string | undefined;
    /** The OIDC issuer that vouched for that identity. */
    issuer?: string | undefined;
    /** The certificate subject, for an archive signed against an ordinary CA. */
    subject?: string | undefined;
    /** The whole-file hash, `<alg>:<hex>` — what attestations of it name. */
    hash?: string | undefined;
    /** Who had attested the installed version (good verdicts), as `[kind@]did`. */
    attestedBy?: string[] | undefined;
    /**
     * Every attestation of the installed version seen so far, good and bad —
     * what `validate()` compares against to say what is new.
     */
    seen?: Seen[] | undefined;
    /** When `validate()` last checked it, ISO 8601. */
    validatedAt?: string | undefined;
    /**
     * Who has been accepted for this install, across its versions: their
     * evidence on a later version proceeds without asking.
     */
    accepted?: Accepted | undefined;
    /** Older records: attesters an install required. Read as accepted. */
    attesters?: string[] | undefined;
    /** sha256 of the file as installed. */
    sha256: string;
    /** When it was installed or last updated, ISO 8601. */
    at: string;
    /** Where it was installed to, so an update can find it again. */
    dir: string;
}

/** One attestation, as an install remembers having seen it. */
export interface Seen {
    did: string;
    handle?: string | undefined;
    kind?: string | undefined;
    verdict: 'good' | 'bad';
}

export interface InstallOptions {
    /** Where to install (default: `installDir()`). */
    dir?: string | undefined;
    /** Extra trusted roots, as PEM text or paths to PEM files. */
    roots?: string[] | undefined;
    /** Require this sigstore signing identity. */
    identity?: string | undefined;
    /** Require this sigstore OIDC issuer. */
    issuer?: string | undefined;
    /** Require attestations from these attesters (DIDs, already resolved). */
    attesters?: Attester[] | undefined;
    /** How many of `attesters` must have attested (default: all of them). */
    quorum?: number | undefined;
    /** Refuse an archive any of these has marked bad. */
    block?: Attester[] | undefined;
    /** Signers accepted without asking, on top of the policy. */
    trust?: Signer[] | undefined;
    /** The policy to apply (default: the machine's, for the installed name). */
    policy?: Policy | undefined;
    /** Ask the backlink index who has attested it (default: what the policy says). */
    discover?: boolean | undefined;
    /** How attestations are fetched — for tests. */
    network?: NetworkOptions | undefined;
    /** Shown everything that was found, before anything is decided. */
    onReview?: ((review: Review, about: { name: string; url: string }) => void) | undefined;
    /**
     * Asked when nothing known vouches for the archive: return the items to
     * accept, or none to decline. Without it, such an install stops with
     * `ERR_BUNDLE_UNCONFIRMED` instead.
     */
    decide?: ((review: Review, about: { name: string; url: string }) => Promise<ReviewItem[]>) | undefined;
    /** Install under this name instead of the one the server suggests. */
    name?: string | undefined;
    /**
     * Install as a plugin for this scope — the package name of the app it is
     * for — into that scope's directory, rather than onto the PATH.
     */
    scope?: string | undefined;
    /**
     * Register `.nzip` and extend PATHEXT on Windows (default: true, or false
     * when `BUNDLE_NO_WINDOWS_SETUP` is set). Turn it off when something else
     * owns the association — an installer, or a test suite, which has no
     * business rewriting the machine it runs on.
     */
    associate?: boolean | undefined;
    log?: ((line: string) => void) | undefined;
    /** How a domain's TXT records are looked up (default: `node:dns`). For tests. */
    resolveTxt?: ((domain: string) => Promise<string[][]>) | undefined;
}

export interface UpdateResult {
    record: InstallRecord;
    /**
     * What happened: nothing new; a new archive in place; a new archive the
     * person declined, or that needed a decision nobody was there to make; one
     * that was refused outright; or a fetch that failed.
     */
    state: 'unchanged' | 'updated' | 'declined' | 'unconfirmed' | 'refused' | 'failed';
    /** The sha256 that was replaced, when something was. */
    previous?: string | undefined;
    /** Why, for anything but `unchanged` and `updated`. */
    reason?: string | undefined;
    review?: Review | undefined;
}

/**
 * Where installed archives go: a directory this tool owns, which the user is
 * expected to have on their PATH. `BUNDLE_INSTALL_DIR` overrides it.
 *
 * Deliberately not "the first writable directory on PATH": guessing at
 * `/usr/local/bin` or at whatever a shell happens to list first is how install
 * scripts end up writing somewhere nobody expected.
 */
export function installDir(): string {
    const configured = process.env['BUNDLE_INSTALL_DIR'];
    if (configured) return PATH.resolve(configured);
    const home = OS.homedir();
    if (process.platform === 'win32') {
        const base = process.env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local');
        return PATH.join(base, 'bundle', 'bin');
    }
    return PATH.join(home, '.local', 'bin');
}

/** Where the record of what is installed lives. */
export function recordPath(): string {
    return PATH.join(stateDir(), 'installed.json');
}

/** Everything installed, by name. */
export function records(): Record<string, InstallRecord> {
    try {
        const parsed = JSON.parse(FS.readFileSync(recordPath(), 'utf-8')) as { installs?: Record<string, InstallRecord> };
        return parsed.installs ?? {};
    } catch {
        return {};
    }
}

/**
 * Fetch `target`, verify what comes back, and put it on the PATH under the name
 * the server suggests — `Content-Disposition`, or the last segment of the URL.
 *
 * `target` is a URL; a bare domain whose `nzip:` TXT record names one — see
 * `resolveAlias()`; or a listing, `@<handle or did>/<name>` — see listing.ts.
 * The alias's or the listing's name is used then, rather than the server's.
 * Which of these it was is remembered, and an update asks it again, so a
 * publisher who moves their releases moves every install with them.
 *
 * Nothing is written outside a temporary file until the signature checks out,
 * and the temporary file is removed if it does not.
 */
export async function install(target: string, options: InstallOptions = {}): Promise<InstallRecord> {
    const log = options.log ?? (() => {});
    const { scope } = options;
    if (scope !== undefined) {
        if (!isScope(scope)) throw new Error(`'${scope}' is not a scope: plugins are installed for an app by its package name`);
        if (options.name || options.dir) throw new Error('a plugin goes where its scope says, under its own package name: --name and --dir do not apply');
    }
    const dir = scope !== undefined ? scopeDir(scope) : options.dir ? PATH.resolve(options.dir) : installDir();
    if (isFolder(target)) {
        if (scope === undefined) throw new Error(`${target} is a folder: a folder is only ever linked as a plugin, for development — with --for <app>`);
        return link(target, scope, log);
    }

    const { source, url, name: named, app } = await locate(target, options, log);
    if (app !== undefined) forApp(target, app, scope);
    log(`* fetching ${url}`);
    const response = await patientFetch()(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());

    // A plugin is found by the package name inside it, so that is what it is
    // installed as. The name is read before the review only to say what is
    // being reviewed; nothing in the archive runs, and the review decides.
    const pkg = packageName(bytes);
    if (scope !== undefined && !pkg) throw new Error(`${url} is not a plugin: it carries no package.json with a name`);
    const name = scope !== undefined ? `${scope}:${pkg}` : options.name ?? named ?? fileName(response, url);
    const file = scope !== undefined ? pluginFile(pkg!) : undefined;
    const label = scope !== undefined ? target : undefined;
    const before = records()[name];
    const record = await place(bytes, { name, dir, file, scope, pkg, label, source, url, response, options, log });
    // Installed over the same plugin linked for development: the link goes.
    if (before && pathOf(before) !== pathOf(record)) remove(before);

    log(`* installed ${pathOf(record)}`);
    if (scope === undefined && !onPath(dir)) {
        log(`! ${dir} is not on your PATH — add it, or set BUNDLE_INSTALL_DIR to somewhere that is`);
    }
    return record;
}

// A local folder: `./`, `../`, an absolute path, `~`, or a `file:` URL. Only
// these: a bare word is a domain or a mistake, never quietly a folder.
function isFolder(target: string): boolean {
    return /^(?:\.{1,2}(?:[\\/]|$)|[\\/~]|[A-Za-z]:[\\/]|file:)/i.test(target);
}

// A plugin under development, linked rather than installed: the scope notes
// the folder, and the loader loads from it as it is, so a change is there on
// the next run. Nothing is reviewed — it is the developer's own — and nothing
// that verifies plugins will load it: run the app with plain node to use it.
function link(target: string, scope: string, log: (line: string) => void): InstallRecord {
    const folder = PATH.resolve(target.startsWith('file:') ? fileURLToPath(target) : target.replace(/^~(?=$|[\\/])/, OS.homedir()));
    let pkg: string | undefined;
    try {
        const name = (JSON.parse(FS.readFileSync(PATH.join(folder, 'package.json'), 'utf-8')) as { name?: unknown }).name;
        pkg = typeof name === 'string' && isScope(name) ? name : undefined;
    } catch (err) {
        throw new Error(`${folder} is not a plugin: ${(err as { code?: string }).code === 'ENOENT' ? 'it has no package.json' : message(err)}`);
    }
    if (!pkg) throw new Error(`${folder} is not a plugin: its package.json gives no package name`);

    const name = `${scope}:${pkg}`;
    const before = records()[name];
    const dir = scopeDir(scope);
    const file = linkFile(pkg);
    const noted = PATH.join(dir, file);
    FS.mkdirSync(PATH.dirname(noted), { recursive: true });
    const temporary = `${noted}.incoming-${process.pid}`;
    FS.writeFileSync(temporary, `${folder}\n`);
    FS.renameSync(temporary, noted);
    FS.writeFileSync(temporary, `${target}\n`);
    FS.renameSync(temporary, labelFile(noted));
    const record: InstallRecord = {
        name, scope, package: pkg, label: target, file, link: folder,
        source: folder, url: pathToFileURL(folder).href, sha256: '', at: new Date().toISOString(), dir,
    };
    // Linked over the same plugin installed: the archive goes until it is installed again.
    if (before && pathOf(before) !== noted) remove(before);
    log(`* linked ${noted} to ${folder}: loaded as it is, never verified`);
    return remember(record);
}

/**
 * What a plugin was installed as: what `bundle install --for` was given, as
 * typed, so whoever reads `list()` can tell which install it was. Older
 * records, from before it was kept, are known by their source. Apps import
 * by package name; this only identifies, and two plugins may share one.
 */
export function labelOf(record: InstallRecord): string | undefined {
    return record.scope === undefined ? undefined : record.label ?? sourceOf(record);
}

// A listing that says it is a plugin for an app is installed as one, and for
// that app: not onto the PATH, and not into the scope of some other app. Which
// app a scope belongs to is only known for apps installed from their listing;
// for any other, the person saying --for is the one who knows.
function forApp(target: string, app: string, scope: string | undefined): void {
    const host = Object.values(records()).find((record) => record.scope === undefined && sourceOf(record) === app);
    if (scope === undefined) {
        throw new Error(`${target} is a plugin for ${host ? `${host.name} (${app})` : app}: install it with --for${host ? ` ${host.name}` : ' <that app>'}`);
    }
    if (host?.package !== undefined && host.package !== scope) {
        throw new Error(`${target} is a plugin for ${host.name} (${app}), whose plugins go in '${host.package}', not '${scope}'`);
    }
}

/** Where an install's file is. */
export function pathOf(record: InstallRecord): string {
    return PATH.join(record.dir, record.file ?? record.name);
}

/**
 * The policy an install answers to: an app's, with its `apps` section; a
 * plugin's, with its scope's section and never the app's — the app's rules
 * are about the app's author.
 */
export function policyOf(record: Pick<InstallRecord, 'name' | 'scope'>): Policy {
    return record.scope !== undefined ? loadPolicy(undefined, { scope: record.scope }) : loadPolicy(record.name);
}

/** The package name an archive's package.json gives, if it has one. */
export function packageName(bytes: Buffer): string | undefined {
    try {
        const zip = new ZLIB.ZipBuffer(bytes);
        if (!zip.has('package.json')) return undefined;
        const name = (JSON.parse(zip.get('package.json').contentSync().toString('utf-8')) as { name?: unknown }).name;
        return typeof name === 'string' && isScope(name) ? name : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Re-check what an installed archive came from, and replace it if the publisher
 * has published something new. With no name, every install.
 *
 * A new version goes through the same review as an install, against what has
 * been accepted for this one so far. One install that is refused, declined or
 * waiting on a decision does not stop the rest; each has its own result, and
 * the installed copy stays as it was.
 */
export async function update(name: string | undefined, options: InstallOptions = {}): Promise<UpdateResult[]> {
    const log = options.log ?? (() => {});
    const all = records();
    const names = name ? [name] : Object.keys(all).sort();
    if (name && !all[name]) throw new Error(`nothing installed as '${name}' — 'bundle install <url>' first`);
    if (!names.length) log('* nothing installed');

    const results: UpdateResult[] = [];
    for (const each of names) {
        const previous = all[each]!;
        try {
            results.push(await updateOne(previous, options, log));
        } catch (err) {
            const code = (err as { code?: string }).code;
            const state = code === 'ERR_BUNDLE_UNCONFIRMED' ? 'unconfirmed'
                : code === 'ERR_BUNDLE_DECLINED' ? 'declined'
                : code === 'ERR_BUNDLE_UNTRUSTED' ? 'refused'
                : 'failed';
            log(`  ${state}: ${message(err)}`);
            results.push({ record: previous, state, reason: message(err), review: (err as { review?: Review }).review });
        }
    }
    return results;
}

// One install's update: ask the source where it is now, make a conditional
// fetch, and — if something new came back — give it the same review an install
// gets, against what this install has accepted.
async function updateOne(previous: InstallRecord, options: InstallOptions, log: (line: string) => void): Promise<UpdateResult> {
    if (previous.link !== undefined) {
        log(`* ${previous.name}: linked to ${previous.link}, which is always as it is`);
        return { record: previous, state: 'unchanged' };
    }
    const source = sourceOf(previous);
    let url = previous.url;
    if (source !== previous.url) {
        // A source that cannot be asked, or a listing taken down, is not the
        // end of the install: the URL it last named is checked instead. The
        // bytes are verified either way, so falling back trusts nothing new.
        try {
            const located = await locate(source, options, () => {});
            if (located.url !== previous.url) log(`* ${previous.name}: ${source} now names ${located.url}`);
            url = located.url;
        } catch (err) {
            log(`* ${previous.name}: ! ${message(err)} — checking the URL it last named`);
        }
    }
    log(`* ${previous.name}: checking ${url}`);

    // The validators belong to the URL they came from.
    const headers: Record<string, string> = {};
    if (url === previous.url && previous.etag) headers['if-none-match'] = previous.etag;
    else if (url === previous.url && previous.lastModified) headers['if-modified-since'] = previous.lastModified;

    const response = await patientFetch()(url, { headers, redirect: 'follow' });
    if (response.status === 304) {
        log(`  unchanged`);
        return { record: previous, state: 'unchanged' };
    }
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    // A server with no caching headers answers 200 to everything; compare
    // the bytes rather than reinstalling an identical archive.
    if (digest(bytes) === previous.sha256) {
        log(`  unchanged`);
        return { record: remember({ ...previous, source, url, ...validators(response), at: previous.at }), state: 'unchanged' };
    }

    // A plugin is found by its package name: one that now calls itself
    // something else is a different plugin, not a new version of this one.
    if (previous.scope !== undefined && packageName(bytes) !== previous.package) {
        throw new Error(`${url} now carries ${packageName(bytes) ?? 'no package name'}, not ${previous.package} — install it as a plugin of its own`);
    }
    const record = await place(bytes, {
        name: previous.name,
        dir: previous.dir,
        file: previous.file,
        scope: previous.scope,
        pkg: previous.scope !== undefined ? previous.package : packageName(bytes),
        label: labelOf(previous),
        source,
        url,
        response,
        log,
        options,
        previous,
    });
    log(`  updated`);
    return { record, state: 'updated', previous: previous.sha256 };
}

/**
 * What a domain publishes as its installable app: a TXT record of the form
 *
 *     nzip:<url>
 *
 * where `<url>` is an absolute `https:` URL, or a reference resolved against
 * `https://<domain>/`. The command it installs as is the domain's first label.
 * So `npm.npmjs.org` carrying `nzip:/app/npm.nzip` means
 * `bundle install npm.npmjs.org` fetches `https://npm.npmjs.org/app/npm.nzip`
 * and installs it as `npm`.
 *
 * The record only says *where* to fetch from, and DNS is not authenticated, so
 * it is worth exactly that: the archive is verified like any other, and the
 * identity that signed it is pinned like any other. What an alias does not do
 * is tell you who should have signed it — `--identity` is still how you say so.
 *
 * Only `https:` is accepted: a record that points at plain HTTP would let
 * anyone on the path choose the bytes, and the signature check would then be
 * the only thing between them and the first install's trust decision.
 */
export async function resolveAlias(
    domain: string,
    resolveTxt: (domain: string) => Promise<string[][]> = DNS.promises.resolveTxt,
): Promise<{ domain: string; name: string; url: string }> {
    const host = domain.replace(/\.$/, '').toLowerCase();
    let answers: string[][];
    try {
        answers = await resolveTxt(host);
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') throw new Error(`${host} has no TXT records, so no 'nzip:' alias`);
        throw new Error(`${host}: TXT lookup failed (${message(err)})`);
    }

    // A TXT record longer than 255 bytes arrives as several strings, which are
    // one value; and the same record published twice is still one answer.
    const entries = [...new Set(answers.map((chunks) => chunks.join('').trim()).filter((text) => text.startsWith('nzip:')))];
    if (!entries.length) throw new Error(`${host} publishes no 'nzip:<url>' TXT record`);
    if (entries.length > 1) throw new Error(`${host} publishes ${entries.length} different 'nzip:' records — refusing to guess between them`);

    const entry = entries[0]!;
    const reference = entry.slice('nzip:'.length).trim();
    if (!reference) throw new Error(`${host}: '${entry}' is not of the form 'nzip:<url>'`);

    let url: URL;
    try {
        url = new URL(reference, `https://${host}/`);
    } catch {
        throw new Error(`${host}: '${reference}' is not a URL`);
    }
    if (url.protocol !== 'https:') throw new Error(`${host}: '${reference}' is not https — refusing to fetch an alias over ${url.protocol.replace(/:$/, '')}`);

    // The first label is the name: `npm.npmjs.org` installs `npm`. A hostname
    // label is letters, digits and hyphens, so it is a file name by construction.
    return { domain: host, name: commandName(host.split('.')[0]!), url: url.href };
}

/** How an install was made — what an update asks again. Older records said less. */
export function sourceOf(record: InstallRecord): string {
    return record.source ?? record.alias ?? record.url;
}

/**
 * Where a source says to fetch from now: a URL is itself; a domain is what its
 * `nzip:` record names; a listing — `@<handle or did>/<name>` as typed, or the
 * `at://` address it is remembered by — is what the record, fetched from the
 * publisher's PDS and verified, names: a URL, or a domain whose `nzip:` record
 * names one. `source` is what is remembered: a
 * listing by its address, with the DID in it rather than a handle, since
 * handles change hands. `name` is what it installs as, when the source says.
 */
async function locate(target: string, options: InstallOptions, log: (line: string) => void): Promise<{ source: string; url: string; name?: string | undefined; app?: string | undefined }> {
    if (target.startsWith('@') || target.startsWith('at://')) {
        const LISTING = await import('./listing.ts');
        const found = target.startsWith('@')
            ? await LISTING.resolveListing(target, options.network)
            : await LISTING.followListing(target, options.network);
        // A listing that names a domain leaves the URL to the domain's TXT
        // record — two hops, both asked again on every update.
        const url = found.record.domain ? (await resolveAlias(found.record.domain, options.resolveTxt)).url : found.record.url!;
        log(`* ${target} is ${found.uri}, ${found.record.domain ? `whose domain ${found.record.domain} names ` : 'at '}${url}`);
        return { source: found.uri, url, name: commandName(found.name), app: LISTING.appOf(found.record) };
    }
    if (hasScheme(target)) return { source: target, url: target };
    if (!isDomain(target)) throw new Error(`'${target}' is neither a URL, a domain name, a listing (@<handle>/<name>), nor a folder (./<path>)`);
    const resolved = await resolveAlias(target, options.resolveTxt);
    log(`* ${resolved.domain} names ${resolved.name} at ${resolved.url}`);
    return { source: resolved.domain, url: resolved.url, name: resolved.name };
}

function hasScheme(target: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

// A hostname with at least two labels: `npmjs.org`, `app.example.com`, with or
// without the trailing dot of a fully qualified name.
function isDomain(target: string): boolean {
    return target.length <= 254
        && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(target);
}

/** What is on disk, measured against what the record says should be. */
export interface InstalledCheck {
    record: InstallRecord;
    /** Where the file is, or would be. */
    path: string;
    /**
     * `ok` — present, the recorded bytes, and still vouched for by someone
     * accepted for it. `missing` — the file is gone. `changed` — something
     * other than `update` replaced it. Otherwise the state that was reached:
     * `invalid` (including a blocking attester's bad verdict),
     * `valid-untrusted` (nobody accepted vouches for it any more, or the
     * policy no longer holds), `unsigned`.
     */
    state: 'ok' | 'missing' | 'changed' | VerificationState;
    /** The whole-file hash as it is now, when there is a file to hash. */
    sha256?: string | undefined;
    reason: string;
    /** The review it was judged by, when it got that far. */
    review?: Review | undefined;
}

/**
 * Check every install against its record: the file is there, its bytes are the
 * ones that were installed, and it still verifies as whoever signed it.
 *
 * The hash is the cheap half and the interesting one. `update` is the only
 * thing that should ever replace an installed archive, so a file whose hash has
 * moved without the record moving with it was changed by something else — which
 * a signature check alone would not notice, since the replacement may be
 * perfectly well signed.
 */
export function installed({ roots = [] }: { roots?: string[] | undefined } = {}): InstalledCheck[] {
    return Object.values(records())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((record) => check(record, roots));
}

/**
 * Re-fetch the attestations every install depends on, so that `installed()`
 * judges them as they are now rather than as the cache last saw them — which
 * is how a withdrawn attestation, or a new warning, shows up. Returns the
 * problems met, if any; the cache keeps what it had for those.
 */
export async function refreshInstalled(network: NetworkOptions = {}): Promise<string[]> {
    const problems: string[] = [];
    for (const record of Object.values(records())) problems.push(...await refreshRecord(record, network));
    return problems;
}

// Fetch every attestation of one install's archive: from everyone known to
// have said something, plus anyone who has since — which is how a scanner's
// warning about something already installed reaches the person who installed it.
async function refreshRecord(record: InstallRecord, network: NetworkOptions): Promise<string[]> {
    const hash = record.hash?.split(':');
    if (!hash || hash.length !== 2) return [];
    const { refreshFor, discover } = await import('./atproto.ts');
    const { cachedFor } = await import('./attestation.ts');
    const problems: string[] = [];
    const policy = policyOf(record);
    const dids = new Set([...candidates(record, policy), ...cachedFor(hash[1]!)]);
    if (policy.discovery) {
        try {
            for (const did of await discover(hash[0]!, hash[1]!, { ...network, index: policy.discovery })) dids.add(did);
        } catch (err) {
            problems.push(`${record.name}: could not ask ${policy.discovery}: ${message(err)}`);
        }
    }
    for (const did of policy.ignore) dids.delete(did);
    if (!dids.size) return problems;
    for (const problem of await refreshFor([...dids].map((did) => ({ did })), hash[0]!, hash[1]!, network)) {
        problems.push(`${record.name}: ${problem}`);
    }
    return problems;
}

/** What `validate()` found for one install. */
export interface Validation {
    record: InstallRecord;
    check: InstalledCheck;
    /** Attestations not seen before. */
    added: Seen[];
    /** Attestations seen before that are gone: withdrawn, or no longer counted. */
    removed: Seen[];
    /** Fetches that failed; the cache answered instead. */
    problems: string[];
    /** True when it was validated recently enough to be left alone (`every`). */
    skipped: boolean;
}

/**
 * Re-validate installs — `which` names them as `uninstall` does, and none
 * means all — against everything known about them now: the attestations are
 * fetched afresh, discovery included, and each install is re-checked exactly
 * as `installed()` does. What sets this apart is the comparison: each install
 * remembers which attestations it has seen, so the answer says what is *new*
 * — a scanner's warning published since the install, an auditor vouching
 * late — and what has been withdrawn, and then remembers the new picture.
 *
 * Made to run unattended, at login or on a timer: `every` leaves alone any
 * install validated more recently than that, so a shell that starts often
 * does not ask the network each time.
 */
export async function validate(which: string[] = [], { roots = [], network = {}, every }: {
    roots?: string[] | undefined;
    network?: NetworkOptions | undefined;
    /** Milliseconds: skip installs validated more recently than this. */
    every?: number | undefined;
} = {}): Promise<Validation[]> {
    const all = records();
    const names = which.length ? [...new Set(which.map((each) => resolve(all, each)))] : Object.keys(all).sort();
    const results: Validation[] = [];
    for (const name of names) {
        const record = all[name]!;
        const last = record.validatedAt ? Date.parse(record.validatedAt) : NaN;
        if (every !== undefined && Date.now() - last < every) {
            results.push({ record, check: { record, path: pathOf(record), state: 'ok', reason: 'validated recently' }, added: [], removed: [], problems: [], skipped: true });
            continue;
        }
        const problems = await refreshRecord(record, network);
        const result = check(record, roots);
        // Only a check that got as far as a review knows who has attested; a
        // file that is missing or changed keeps its previous picture.
        const now = result.review ? seenIn(result.review) : record.seen ?? [];
        const before = record.seen ?? [];
        const key = (each: Seen) => `${each.did} ${each.kind ?? ''} ${each.verdict}`;
        const added = now.filter((each) => !before.some((other) => key(other) === key(each)));
        const removed = before.filter((each) => !now.some((other) => key(other) === key(each)));
        const updated = remember({ ...record, seen: now, validatedAt: new Date().toISOString() });
        results.push({ record: updated, check: { ...result, record: updated }, added, removed, problems, skipped: false });
    }
    return results;
}

// A linked folder has nothing to verify: it is there, and is still the
// package it was linked as, or it is not.
function checkLink(record: InstallRecord, path: string): InstalledCheck {
    let named: unknown;
    try {
        named = (JSON.parse(FS.readFileSync(PATH.join(record.link!, 'package.json'), 'utf-8')) as { name?: unknown }).name;
    } catch (err) {
        return { record, path, state: 'missing', reason: `the folder it links is not a plugin any more (${message(err)})` };
    }
    if (!FS.existsSync(path)) return { record, path, state: 'missing', reason: 'the link is not there any more' };
    if (named !== record.package) return { record, path, state: 'changed', reason: `${record.link} is now ${String(named)}, not ${record.package}` };
    return { record, path, state: 'ok', reason: `linked to ${record.link}, for development: loaded as it is, never verified` };
}

/** The attestations a review saw, as an install remembers them. */
function seenIn(review: Review): Seen[] {
    return review.items.flatMap(({ evidence }) => evidence.type === 'attestation'
        ? [{ did: evidence.did, handle: evidence.handle, kind: evidence.kind, verdict: evidence.verdict }]
        : []);
}

function check(record: InstallRecord, roots: string[]): InstalledCheck {
    const path = pathOf(record);
    if (record.link !== undefined) return checkLink(record, path);

    let bytes: Buffer;
    try {
        bytes = FS.readFileSync(path);
    } catch (err) {
        return { record, path, state: 'missing', reason: `not there any more (${message(err)})` };
    }

    const sha256 = digest(bytes);
    if (sha256 !== record.sha256) {
        return {
            record, path, sha256, state: 'changed',
            reason: `the file is not the bytes that were installed — expected ${record.sha256.slice(0, 12)}…, found ${sha256.slice(0, 12)}…`,
        };
    }

    // The same review an update would get, from the cache: whoever was
    // accepted must still vouch for it, the policy must still hold, and nobody
    // it blocks on may have marked it bad since.
    const policy = policyOf(record);
    let gathered: Gathered;
    try {
        gathered = gatherSync(bytes, { roots, candidates: candidates(record, policy), ignore: policy.ignore, maxAge: policy.maxAge, everyCached: true });
    } catch (err) {
        return { record, path, sha256, state: (err as { state?: VerificationState }).state ?? 'invalid', reason: message(err) };
    }
    const review = judge(gathered, { policy, accepted: acceptedOf(record), trust: selfTrust(record.url) });
    const warnings = warningsOf(review);
    if (review.decision === 'refuse') return { record, path, sha256, state: review.state, reason: review.reason, review };
    if (review.decision === 'ask') {
        const reason = review.alarms.length ? review.reason : 'nothing that was accepted for it vouches for it any more';
        return { record, path, sha256, state: 'valid-untrusted', reason, review };
    }
    return { record, path, sha256, state: 'ok', reason: [review.reason, ...warnings].join('; '), review };
}

/** The bad verdicts in a review that did not decide anything, as lines to show. */
export function warningsOf(review: Review): string[] {
    return review.items
        .filter(({ evidence }) => evidence.type === 'attestation' && evidence.verdict === 'bad')
        .map(({ evidence }) => {
            const e = evidence as Extract<ReviewItem['evidence'], { type: 'attestation' }>;
            return `warning: ${e.handle ?? e.did} marked it bad${e.kind ? ` (${e.kind})` : ''}`;
        });
}

/** What has been accepted for an install, reading older records' fields as acceptance. */
export function acceptedOf(record: InstallRecord): Accepted {
    if (record.accepted) return record.accepted;
    const accepted = noneAccepted();
    if (record.identity && record.issuer) accepted.signers.push({ identity: record.identity, issuer: record.issuer });
    for (const spec of [...(record.attesters ?? []), ...(record.attestedBy ?? [])]) {
        const { subject } = parseAttester(spec);
        if (!accepted.attesters.includes(subject)) accepted.attesters.push(subject);
    }
    return accepted;
}

// Whom to ask about an install's archive besides whoever the index names: those
// accepted for it, those who attested the installed version, and everyone the
// policy mentions.
function candidates(record: InstallRecord | undefined, policy: Policy, extra: Attester[] = []): string[] {
    const dids = new Set<string>();
    if (record) {
        for (const did of acceptedOf(record).attesters) dids.add(did);
        for (const spec of record.attestedBy ?? []) dids.add(parseAttester(spec).subject);
    }
    for (const { attesters } of policy.attesters) for (const { did } of attesters) dids.add(did);
    for (const { did } of [...policy.trust.attesters, ...policy.block, ...extra]) dids.add(did);
    for (const did of policy.ignore) dids.delete(did);
    return [...dids];
}

// This package's own release is signed by its publish workflow, and that is
// trusted for its own install — wherever it was installed from, mirror included.
function selfTrust(url: string): Signer[] {
    return url === SELF.url || url === self().url ? [{ identity: SELF.identity, issuer: SELF.issuer }] : [];
}

/** What `uninstall` removed: the install, and its plugins when nothing else can load them. */
export type Uninstalled = InstallRecord & {
    /** The app's plugins, removed with it. */
    plugins: InstallRecord[];
    /** Other installs of the same app, for whom its plugins were left where they are. */
    sharedWith: string[];
};

/**
 * Forget an install, and remove the file it put on the PATH.
 *
 * `which` is a name, a URL, the domain it was installed by, or nothing — and
 * nothing means this package's own install, which is what somebody typing
 * `bundle uninstall` means. The file association on Windows is left alone:
 * other archives may rely on it, and it is not this one's to take away.
 *
 * An app's plugins go with it: nothing can load them any more. The exception
 * is another install of the same app — the same package, under another name —
 * which loads the same scope, so they stay for that. A scope no app is
 * installed as, such as a suite's shared one, belongs to no single app and is
 * only ever emptied plugin by plugin.
 */
export function uninstall(which?: string): Uninstalled {
    const all = records();
    const name = resolve(all, which);
    const record = all[name]!;
    remove(record);
    delete all[name];

    const plugins: InstallRecord[] = [];
    let sharedWith: string[] = [];
    if (record.scope === undefined && record.package) {
        const scope = record.package;
        sharedWith = Object.values(all).filter((each) => each.scope === undefined && each.package === scope).map((each) => each.name).sort();
        if (!sharedWith.length) {
            for (const plugin of Object.values(all).filter((each) => each.scope === scope)) {
                remove(plugin);
                delete all[plugin.name];
                plugins.push(plugin);
            }
            if (plugins.length) prune(scopeDir(scope));
        }
    } else if (record.scope !== undefined) {
        prune(PATH.dirname(pathOf(record)));
    }
    write(all);
    return { ...record, plugins, sharedWith };
}

// An install's file, and for a plugin the name it was installed as beside it.
function remove(record: InstallRecord): void {
    FS.rmSync(pathOf(record), { force: true });
    if (record.scope !== undefined) FS.rmSync(labelFile(pathOf(record)), { force: true });
}

// Remove `dir` if it is empty, and its parents up to the plugins directory —
// a scope's directory, and the `@scope/` ones inside and above it.
function prune(dir: string): void {
    const top = pluginsDir();
    for (let at = dir; at.startsWith(top + PATH.sep); at = PATH.dirname(at)) {
        try {
            FS.rmdirSync(at);
        } catch {
            return;
        }
    }
}

/** The name this package installs itself under, which the extension decides. */
export function selfName(): string {
    return commandName('bundle.nzip');
}

// Which install is meant: the one named, the one installed from that URL,
// domain or listing, or — when nothing is said — this package's own. A listing
// is matched by its address, or as `@<did>/<name>`; a handle would need the
// network to mean anything.
function resolve(all: Record<string, InstallRecord>, which: string | undefined): string {
    const installed = Object.keys(all);
    const known = installed.length ? `installed: ${installed.sort().join(', ')}` : 'nothing is installed';

    if (which === undefined) {
        const mine = installed.find((name) => all[name]!.url === self().url) ?? selfName();
        if (!all[mine]) throw new Error(`this package is not installed as '${mine}' — ${known}`);
        return mine;
    }
    if (all[which]) return which;
    if (which.startsWith('@')) {
        const slash = which.lastIndexOf('/');
        const uri = `at://${which.slice(1, slash)}/com.pipobscure.bundle.listing/${which.slice(slash + 1)}`;
        const found = installed.find((name) => sourceOf(all[name]!) === uri);
        if (!found) throw new Error(`nothing installed from ${which} — ${known}`);
        return found;
    }
    if (hasScheme(which)) {
        const found = installed.find((name) => all[name]!.url === which || sourceOf(all[name]!) === which);
        if (!found) throw new Error(`nothing installed from ${which} — ${known}`);
        return found;
    }
    if (all[which]) return which;
    const domain = which.replace(/\.$/, '').toLowerCase();
    const aliased = installed.find((name) => sourceOf(all[name]!) === domain);
    if (aliased) return aliased;
    throw new Error(`nothing installed as '${which}' — ${known}`);
}

// ------------------------------------------------------------------ the act ---

// Review, decide, then move into place. The order is the whole point: an
// archive nobody accepted never exists at its destination, not even briefly.
async function place(bytes: Buffer, { name, dir, file, scope, pkg, label, source, url, response, options, log, previous }: {
    name: string;
    dir: string;
    file?: string | undefined;
    scope?: string | undefined;
    pkg?: string | undefined;
    label?: string | undefined;
    source: string;
    url: string;
    response: Response;
    options: InstallOptions;
    log: (line: string) => void;
    previous?: InstallRecord | undefined;
}): Promise<InstallRecord> {
    const policy = options.policy ?? policyOf({ name, scope });
    const demands: Demands = {
        identity: options.identity || undefined,
        issuer: options.issuer || undefined,
        attesters: options.attesters,
        quorum: options.quorum,
        block: options.block,
    };
    const accepted = previous ? acceptedOf(previous) : noneAccepted();
    const about = { name, url };

    const gathered = await gather(bytes, {
        roots: options.roots ?? [],
        candidates: candidates(previous, policy, [...(options.attesters ?? []), ...(options.block ?? [])]),
        discovery: options.discover === false ? false : policy.discovery,
        ignore: policy.ignore,
        network: options.network,
    }).catch((err: unknown) => {
        throw refusal((err as { state?: VerificationState }).state ?? 'invalid', `refusing to install ${url}: ${message(err)}`);
    });
    const review = judge(gathered, {
        policy, demands, accepted,
        trust: [...(options.trust ?? []), ...selfTrust(url)],
        previousIssuer: previous?.issuer,
    });
    options.onReview?.(review, about);

    if (review.decision === 'refuse') {
        throw refusal(review.state, `refusing to install ${url}: ${STATES[review.state].label} — ${review.reason}`, review);
    }
    let chosen = review.items.filter((item) => item.known && !item.excluded);
    if (review.decision === 'ask') {
        if (!options.decide) {
            throw Object.assign(new Error(`${url} needs a decision: ${review.reason}`), { code: 'ERR_BUNDLE_UNCONFIRMED', review });
        }
        chosen = await options.decide(review, about);
        if (!chosen.length) throw Object.assign(new Error(`declined ${url}`), { code: 'ERR_BUNDLE_DECLINED', review });
    }
    log(`  accepted: ${chosen.length} of ${review.items.length} — ${review.decision === 'proceed' ? review.reason : 'by your decision'}`);

    // A plugin is the app's data, not a command: it is not made executable,
    // and Windows is not told how to run it.
    const plugin = scope !== undefined;
    const target = PATH.join(dir, file ?? name);
    FS.mkdirSync(PATH.dirname(target), { recursive: true });
    const temporary = `${target}.incoming-${process.pid}`;
    try {
        FS.writeFileSync(temporary, bytes, { mode: plugin ? 0o644 : 0o755 });
        // Windows has no executable bit; what makes the file runnable there is
        // the .nzip association, which `ensureWindowsAssociation()` sets up.
        if (process.platform !== 'win32' && !plugin) FS.chmodSync(temporary, 0o755);
        FS.renameSync(temporary, target);
    } catch (err) {
        FS.rmSync(temporary, { force: true });
        throw err;
    }
    if (label !== undefined) {
        FS.writeFileSync(temporary, `${label}\n`);
        FS.renameSync(temporary, labelFile(target));
    }

    const associating = options.associate ?? !process.env['BUNDLE_NO_WINDOWS_SETUP'];
    if (process.platform === 'win32' && associating && !plugin) {
        for (const line of ensureWindowsAssociation(name)) log(`  ${line}`);
    }

    const { result } = gathered;
    const attestedBy = gathered.evidence
        .filter((each) => each.type === 'attestation' && each.verdict === 'good')
        .map((each) => { const e = each as { did: string; kind?: string | undefined }; return formatAttester({ did: e.did, kind: e.kind }); });
    return remember({
        name,
        scope,
        package: pkg,
        label,
        file,
        source,
        url,
        ...validators(response),
        identity: result.identity,
        issuer: result.issuer,
        subject: result.sigstore ? undefined : result.subject,
        hash: `${gathered.hashAlg}:${gathered.hash}`,
        attestedBy: attestedBy.length ? attestedBy : undefined,
        accepted: accept(accepted, chosen),
        seen: gathered.evidence.flatMap((each) => each.type === 'attestation'
            ? [{ did: each.did, handle: each.handle, kind: each.kind, verdict: each.verdict }]
            : []),
        sha256: digest(bytes),
        at: new Date().toISOString(),
        dir,
    });
}

function validators(response: Response): { etag?: string | undefined; lastModified?: string | undefined } {
    return {
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
    };
}

function digest(bytes: Buffer): string {
    return CRYPTO.createHash('sha256').update(bytes).digest('hex');
}

function remember(record: InstallRecord): InstallRecord {
    const all = records();
    all[record.name] = record;
    write(all);
    return record;
}

function write(installs: Record<string, InstallRecord>): void {
    const path = recordPath();
    FS.mkdirSync(PATH.dirname(path), { recursive: true });
    const temporary = `${path}.incoming-${process.pid}`;
    FS.writeFileSync(temporary, `${JSON.stringify({ version: 1, installs }, null, 2)}\n`);
    FS.renameSync(temporary, path);
}

// ------------------------------------------------------------- the details ---

/**
 * What to call the file: the name the server asked for, or the last segment of
 * the URL. Either way it is reduced to a bare file name — a `Content-Disposition`
 * is a suggestion from someone else's server, and a suggestion that can contain
 * `../` is an arbitrary write.
 *
 * Then the extension is decided rather than accepted, because `.nzip` is not
 * decoration: on Windows it is the whole mechanism — the association is by
 * extension — so it is put on. Everywhere else it is noise between a person and
 * the command they mean to type, so it comes off, and `bundle.nzip` installs as
 * `bundle`. Any other extension is left alone; it is the publisher's business.
 */
export function fileName(response: Response, url: string): string {
    const suggested = disposition(response.headers.get('content-disposition'));
    const fallback = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const chosen = safe(suggested) || safe(fallback);
    if (!chosen) throw new Error(`cannot tell what to call the file from ${url} — pass --name`);
    return commandName(chosen);
}

/** `chosen` as it should sit on the PATH: with `.nzip` on Windows, without it elsewhere. */
function commandName(chosen: string): string {
    if (process.platform === 'win32') return /\.nzip$/i.test(chosen) ? chosen : `${chosen}.nzip`;
    const bare = chosen.replace(/\.nzip$/i, '');
    // ...unless dropping it would leave nothing, as `.nzip` alone would.
    return bare || chosen;
}

function disposition(header: string | null): string {
    if (!header) return '';
    const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(header);
    if (encoded?.[1]) {
        try {
            return decodeURIComponent(encoded[1].trim());
        } catch {
            // A malformed filename* is not a reason to fail; fall through to
            // the plain parameter, which is what a well-behaved server also sends.
        }
    }
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    return (plain?.[2] ?? plain?.[1] ?? '').trim();
}

function safe(name: string): string {
    const base = PATH.basename(name.replace(/\\/g, '/'));
    if (!base || base === '.' || base === '..') return '';
    // No separators, no NULs, nothing that reads as a drive or a switch.
    if (/[\0/\\:]/.test(base) || base.startsWith('-')) return '';
    return base;
}

function onPath(dir: string): boolean {
    const entries = (process.env['PATH'] ?? '').split(PATH.delimiter).filter(Boolean);
    const target = PATH.resolve(dir);
    return entries.some((entry) => {
        try {
            return PATH.resolve(entry) === target;
        } catch {
            return false;
        }
    });
}

/** The ProgID this tool registers `.nzip` against. */
const PROG_ID = 'NodeBundle';

/**
 * Make `.nzip` runnable for the current user on Windows: associate it with a
 * file type that runs node with the archive mounted, and put the extension on
 * PATHEXT so the name alone is enough.
 *
 * Everything here is per-user — HKCU and `HKCU\Environment`, never `/M` — so it
 * needs no administrator. A machine-wide association is an installer's job, and
 * the node installer is the right place for it. Both halves are idempotent:
 * what is already right is left alone, and what is missing is written.
 */
export function ensureWindowsAssociation(name = 'a bundle'): string[] {
    if (process.platform !== 'win32') return [];
    const notes = [...associate(), ...extendPathExt()];
    if (notes.length) notes.push(`${name} runs by name once a new terminal picks that up`);
    notes.push(...shadowed());
    return notes;
}

/**
 * The command a `.nzip` opens with.
 *
 * The obvious form — node with `--vfs-load="%1"` — is wrong in the case that
 * matters most. When cmd resolves a name through PATHEXT (you type `pnpm`, it
 * finds `pnpm.nzip`) the shell substitutes the name *as typed*, without the
 * extension, and node is handed a path that does not exist. When Explorer or
 * `start` opens the file instead, `%1` is the full name *with* it. Neither can
 * be assumed, so the command asks: if the path exists, mount it; if not, mount
 * it with `.nzip` on the end.
 *
 * It goes through `cmd /d /s /c` for that `if`: `/d` skips AutoRun commands
 * someone may have configured, and `/s` makes the quoting predictable — the
 * outer quotes are stripped and the rest is taken literally.
 */
function openCommand(): string {
    const node = `"${process.execPath}" --experimental-vfs`;
    return `cmd /d /s /c "if exist "%1" (${node} --vfs-load="%1" -- %~2) else (${node} --vfs-load="%1.nzip" -- %~2)"`;
}

// The association is two keys, and both have to be right: the extension has to
// name the ProgID, and the ProgID has to carry the command. Checking only the
// second would skip the write for a `.nzip` that some other tool has since
// claimed — a silent no-op where the user asked for an association.
function associate(): string[] {
    const command = openCommand();
    const notes: string[] = [];

    if (query('HKCU\\Software\\Classes\\.nzip', '') !== PROG_ID) {
        reg(['add', 'HKCU\\Software\\Classes\\.nzip', '/ve', '/d', PROG_ID, '/f']);
        notes.push(`associated .nzip with ${PROG_ID}, for this user`);
    }
    if (query(`HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '') !== command) {
        reg(['add', `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);
        notes.push(`${PROG_ID} now opens with this node (${process.execPath})`);
    }
    return notes;
}

/**
 * Add `.NZIP` to the user's PATHEXT.
 *
 * Deliberately *not* `setx PATHEXT "%PATHEXT%;.NZIP"` with the value from
 * `process.env`: that value is the machine's and the user's merged together, so
 * writing it back would freeze a copy of the machine's PATHEXT into this user's
 * environment and mask every later system-wide change to it. What goes in is
 * the user's own value with `.NZIP` appended — or, when the user has none, the
 * literal `%PATHEXT%;.NZIP` as `REG_EXPAND_SZ`, which resolves against whatever
 * the machine value is at the time a session starts.
 */
function extendPathExt(): string[] {
    if ((process.env['PATHEXT'] ?? '').split(';').some((ext) => ext.trim().toUpperCase() === '.NZIP')) return [];

    // Already written, just not visible in this process's environment yet —
    // that is a terminal that predates the install, not something to do again.
    const mine = query('HKCU\\Environment', 'PATHEXT');
    if (mine !== null && mine.split(';').some((ext) => ext.trim().toUpperCase() === '.NZIP')) return [];

    const value = mine === null ? '%PATHEXT%;.NZIP' : `${mine.replace(/;+$/, '')};.NZIP`;
    // REG_EXPAND_SZ so a `%PATHEXT%` in the value means what it says. `setx`
    // would write REG_SZ and truncate past 1024 characters; `reg add` does
    // neither, at the cost of no WM_SETTINGCHANGE broadcast — which `setx` only
    // does for already-running programs that listen for it anyway.
    try {
        reg(['add', 'HKCU\\Environment', '/v', 'PATHEXT', '/t', 'REG_EXPAND_SZ', '/d', value, '/f']);
    } catch (err) {
        return [`could not add .NZIP to PATHEXT: ${message(err)}`];
    }
    return ['added .NZIP to your PATHEXT', ...announce()];
}

/**
 * Tell the desktop the environment changed, which is what makes a new terminal
 * — or anything Explorer launches from now on — see the new PATHEXT without a
 * sign-out. `setx` does this; writing the registry directly does not, so this
 * does it by hand.
 *
 * It is a `WM_SETTINGCHANGE` broadcast with `lParam` pointing at the string
 * "Environment", through `SendMessageTimeoutW` — and `node:ffi` is how a
 * JavaScript program gets to call that at all. The timeout matters: a broadcast
 * is delivered to every top-level window, and one hung program would otherwise
 * hang the install, so it aborts on those and gives up after two seconds.
 *
 * A broadcast that fails is not an install that failed: it only means somebody
 * opens a new terminal instead.
 */
function announce(): string[] {
    const HWND_BROADCAST = 0xffffn;
    const WM_SETTINGCHANGE = 0x001a;
    const SMTO_ABORTIFHUNG = 0x0002;

    try {
        const { DynamicLibrary } = require('node:ffi') as typeof import('node:ffi');
        const user32 = new DynamicLibrary('user32.dll');
        try {
            const send = user32.getFunction('SendMessageTimeoutW', {
                arguments: ['pointer', 'uint32', 'pointer', 'pointer', 'uint32', 'uint32', 'pointer'],
                return: 'pointer',
            });
            // Wide, NUL-terminated: this is the W entry point.
            const subject = Buffer.from('Environment\0', 'utf16le');
            const answer = Buffer.alloc(8);
            send(HWND_BROADCAST, WM_SETTINGCHANGE, 0n, subject, SMTO_ABORTIFHUNG, 2000, answer);
            return ['told the desktop the environment changed — new terminals have it'];
        } finally {
            user32.close();
        }
    } catch (err) {
        return [`open a new terminal for it to take effect (could not broadcast: ${message(err)})`];
    }
}

// An association set through Explorer's "Open with" lives in UserChoice and
// takes precedence over everything written above. Nothing here can change that
// — Windows protects the key with a hash — so say so rather than reporting
// success for a write that will not take effect.
function shadowed(): string[] {
    const choice = query('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.nzip\\UserChoice', 'ProgId');
    if (choice === null || choice === PROG_ID) return [];
    return [
        `! .nzip is set to open with '${choice}' in your app defaults, which wins over this association`,
        `  change it in Settings > Apps > Default apps, or run archives as 'bundle run <file>'`,
    ];
}

function reg(args: string[]): void {
    const res = spawnSync('reg', args, { encoding: 'utf-8' });
    if (res.status !== 0) throw new Error(`reg ${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
}

/**
 * One registry value, or null when the key or the value is not there. `name` is
 * the value's name; the empty string asks for the key's default value.
 */
function query(key: string, name: string): string | null {
    const res = spawnSync('reg', ['query', key, ...(name ? ['/v', name] : ['/ve'])], { encoding: 'utf-8' });
    if (res.status !== 0) return null;
    return parseRegQuery(res.stdout ?? '', name);
}

/**
 * The one value `reg query` was asked for, out of what it printed.
 *
 * Its output is `    <name>    <TYPE>    <value>`, with the default value named
 * `(Default)`. A value can itself contain runs of spaces — a command line with
 * quoted paths usually does — so only the name and the type are matched, and
 * everything after the type is the value.
 *
 * Exported because this is the part of the Windows path that can be tested
 * anywhere; the `reg` call around it cannot.
 */
export function parseRegQuery(stdout: string, name: string): string | null {
    const wanted = name || '(Default)';
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s{4,}(\S(?:.*?\S)?)\s{4,}REG_(?:EXPAND_)?SZ\s{4,}(.*)$/.exec(line);
        if (match && match[1] === wanted) return (match[2] ?? '').trimEnd();
    }
    return null;
}

export { message };
