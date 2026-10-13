import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { cached, cachedFor, parseAttester, stateDir } from './attestation.ts';
import { message } from './manifest.ts';
import type { InstallOptions, InstallRecord, Located } from './install.ts';
import type { Accepted, Inherited, Minimum, Review } from './review.ts';
import type { Signer } from './policy.ts';
import type { FoundSuite, SuiteMember } from './suite.ts';

// Installing a suite: each of its members, as `install()` would install it by
// itself — reviewed on its own, under its own policy, with the person's
// decision where one is needed — and remembering which install came from
// which member, so the suite can be kept in step and taken away again.
//
// **Asked once.** A suite says what each member is expected to carry: a
// signer, attesters. Before anything is fetched, everyone it names is shown
// together, and whoever the person accepts counts as accepted for each member
// that names them — so a suite whose members carry what it says installs
// with one answer. The suite's say-so is not what is accepted: the person
// is, and only for evidence the archive actually carries. Anything else about
// a member is still a question of its own.
//
// **A floor, not trust.** A member that does not carry what its suite
// requires is refused, at install and at every update, and `installed` says
// so. Meeting it accepts nothing.
//
// **A suite can be attested,** by the hash of what it says (`suiteHash()`).
// A good attestation counts for each member installed from it: an IT
// department that attests a suite `permitted` permits its members, where the
// policy requires that of everything. A bad one — `prohibited` — refuses the
// suite, where the policy blocks on whoever said it, and does not carry over:
// a bundle in a prohibited suite can still be permitted on its own.
//
// **What it brought, it takes away.** Uninstalling a suite removes what it
// installed, and nothing else: an install made by hand before it, or one
// another suite has too, stays. `update` asks the suite again, installs
// members that were added, removes those taken out, and then updates the
// rest as usual. A member the person uninstalls by itself is left out from
// then on, until they install it again.
//
// What is installed as suites is kept in `suites.json` beside
// `installed.json`, so that an older `bundle`, rewriting that file, cannot
// drop it. This module is read by install.ts for the floors, so it loads
// nothing heavy until a suite is actually installed.

/** A suite, as installed here. */
export interface InstalledSuite {
    /** The suite's name: what it is known by here, and the key in the record. */
    name: string;
    /** Where it is asked again: the `at://` address of the suite, with the DID in it; the domain that publishes it; or the URL that serves it. */
    source: string;
    /** What it was installed as, as typed: `@<handle>/<name>`. Only identifies. */
    label?: string | undefined;
    /** Where its apps go, when it was installed with `--dir`. */
    dir?: string | undefined;
    /**
     * What it says now, as a hash (`suiteHash()`): an attestation of that
     * counts for its members. Updated whenever the suite is asked again.
     */
    hash?: string | undefined;
    members: MemberState[];
    /** When it was installed, or its members last changed, ISO 8601. */
    at: string;
}

/** One member of an installed suite: as the suite says, and what became of it here. */
export interface MemberState extends SuiteMember {
    /** The install it is: the name of its record in `installed.json`, once installed. */
    install?: string | undefined;
    /** Installed by the suite, rather than there already: uninstalling the suite removes it. */
    brought?: boolean | undefined;
    /** Uninstalled by the person: left out from then on, until it is installed again. */
    removed?: boolean | undefined;
}

/** What became of one member. */
export interface MemberResult {
    listing: string;
    /**
     * `installed` — the suite installed it. `present` — installed already,
     * now the suite's too. `left-out` — uninstalled by the person, and left
     * so. `removed` — no longer a member, and uninstalled. `kept` — no longer
     * a member, but stays: it was there before the suite, or another suite
     * has it. Otherwise it is not installed — refused by its review or the
     * suite's floor, declined, needing a decision nobody was there to make,
     * or failed — and the next update tries again.
     */
    state: 'installed' | 'present' | 'left-out' | 'removed' | 'kept' | 'refused' | 'declined' | 'unconfirmed' | 'failed';
    install?: string | undefined;
    reason?: string | undefined;
    review?: Review | undefined;
}

/** What installing, updating or uninstalling a suite did. */
export interface SuiteResult {
    suite: InstalledSuite;
    members: MemberResult[];
    /** Why the suite could not be asked; its members were left as they were. */
    problem?: string | undefined;
}

/** Everyone a suite expects its members to carry, offered to be accepted once. */
export interface Offer {
    signers: (Signer & { members: string[] })[];
    attesters: { did: string; kind?: string | undefined; members: string[] }[];
}

export interface SuiteOptions extends InstallOptions {
    /** The suite, fetched and verified already — as `install()` hands it on. */
    suite?: FoundSuite | undefined;
    /**
     * Shown everyone the suite expects, once, before anything is installed:
     * return those to accept for every member that names them. Without it,
     * nothing is accepted up front, and each member is its own question.
     */
    confirm?: ((offer: Offer, about: { name: string; source: string }) => Promise<Accepted>) | undefined;
}

/** Where the record of installed suites lives. */
export function suitesPath(): string {
    return PATH.join(stateDir(), 'suites.json');
}

/** Every suite installed, by name. */
export function suites(): Record<string, InstalledSuite> {
    try {
        const parsed = JSON.parse(FS.readFileSync(suitesPath(), 'utf-8')) as { suites?: Record<string, InstalledSuite> };
        return parsed.suites ?? {};
    } catch {
        return {};
    }
}

function write(all: Record<string, InstalledSuite>): void {
    const path = suitesPath();
    FS.mkdirSync(PATH.dirname(path), { recursive: true });
    const temporary = `${path}.incoming-${process.pid}`;
    FS.writeFileSync(temporary, `${JSON.stringify({ version: 1, suites: all }, null, 2)}\n`);
    FS.renameSync(temporary, path);
}

function save(suite: InstalledSuite): void {
    const all = suites();
    all[suite.name] = suite;
    write(all);
}

/**
 * The floors an install answers to: what each suite it belongs to requires of
 * it. Empty for an install no suite has.
 */
export function minimumsFor(name: string): Minimum[] {
    const found: Minimum[] = [];
    for (const suite of Object.values(suites())) {
        for (const member of suite.members) {
            if (member.install !== name) continue;
            const floor = minimumOf(member, `suite ${suite.name}`);
            if (floor) found.push(floor);
        }
    }
    return found;
}

/**
 * The suites an install is in, as hashes whose attestations count as its
 * own: so that a suite attested `permitted` by an IT department permits each
 * member installed from it.
 */
export function inheritFor(name: string): Inherited[] {
    return Object.values(suites())
        .filter((suite) => suite.hash !== undefined && suite.members.some((member) => member.install === name))
        .map((suite) => inherited(suite));
}

function inherited(suite: InstalledSuite): Inherited {
    const [hashAlg, hash] = suite.hash!.split(':') as [string, string];
    return { hashAlg, hash, via: `suite ${suite.name}` };
}

// A member's `require`, as the review takes it.
function minimumOf({ require }: SuiteMember, source: string): Minimum | undefined {
    if (!require || (!require.identity && !require.issuer && !require.attesters?.length)) return undefined;
    const attesters = require.attesters?.map((spec) => {
        const { subject, kind } = parseAttester(spec);
        return { did: subject, kind };
    });
    return { identity: require.identity, issuer: require.issuer, attesters, quorum: require.quorum, source };
}

/**
 * Which installed suite `which` means — its name, its `at://` address,
 * `@<did>/<name>`, or what it was installed as — or undefined.
 */
export function findSuite(which: string): string | undefined {
    const all = suites();
    if (all[which]) return which;
    let uri = which;
    if (which.startsWith('@')) {
        const slash = which.lastIndexOf('/');
        uri = `at://${which.slice(1, slash)}/com.pipobscure.bundle.suite/${which.slice(slash + 1)}`;
    }
    return Object.values(all).find((suite) => suite.source === uri || suite.label === which)?.name;
}

/** The suites an install belongs to, by name. */
export function suitesOf(name: string): string[] {
    return Object.values(suites()).filter((suite) => suite.members.some((member) => member.install === name)).map((suite) => suite.name).sort();
}

/** The installs a suite has, by name. */
export function installsOf(suite: InstalledSuite): string[] {
    return suite.members.flatMap((member) => (member.install !== undefined ? [member.install] : []));
}

/**
 * Install a suite: `target` is `@<handle or did>/<name>`, its `at://`
 * address, a domain whose `nsuite:` TXT record names where it is served, or
 * the `https:` URL that serves it;
 * and `options.suite` the suite when it has been found already.
 * What every member came to is returned; one that is refused or declined does
 * not stop the rest.
 */
export async function installSuite(target: string, options: SuiteOptions = {}): Promise<SuiteResult> {
    if (options.scope !== undefined || options.name !== undefined) {
        throw new Error(`${target} is a suite: its members say where each goes, so --for and --name do not apply`);
    }
    const found = options.suite ?? await fetchTarget(target, options);
    await judgeSuite(found.name, found.record.members, options);
    const before = suites()[found.name];
    if (before && before.source !== found.uri) {
        throw new Error(`a suite called '${found.name}' is installed already, from ${before.source} — uninstall it first`);
    }
    const suite: InstalledSuite = before ?? {
        name: found.name,
        source: found.uri,
        label: target.startsWith('@') ? target : undefined,
        dir: options.dir ? PATH.resolve(options.dir) : undefined,
        members: [],
        at: new Date().toISOString(),
    };
    (options.log ?? (() => {}))(`* ${target} is ${found.uri}, a suite of ${found.record.members.length}`);
    return await follow(suite, found.record.members, options);
}

/**
 * The suite `target` names — `@<handle or did>/<name>`, an `at://` address,
 * an `https:` URL that serves it, or a domain whose `nsuite:` record names one.
 */
export async function fetchTarget(target: string, options: SuiteOptions = {}): Promise<FoundSuite> {
    const SUITE = await import('./suite.ts');
    if (target.startsWith('at://')) return await SUITE.followSuite(target, options.network);
    if (/^https:\/\//i.test(target)) return await SUITE.fetchSuiteUrl(target);
    if (!target.startsWith('@')) return await SUITE.resolveSuiteDomain(target, { resolveTxt: options.resolveTxt });
    const { parseListingTarget } = await import('./listing.ts');
    const parsed = parseListingTarget(target);
    if (!parsed) throw new Error(`'${target}' is not a suite — those are @<handle or did>/<name>, or an at:// address`);
    const did = parsed.who.startsWith('did:') ? parsed.who : (await (await import('./atproto.ts')).resolveHandle(parsed.who, options.network)).did;
    const found = await SUITE.fetchSuite(did, parsed.name, options.network);
    if (!found) throw new Error(`${target}: ${did} has no suite called '${parsed.name}'`);
    return found;
}

/**
 * Bring installed suites in step with what they say now — `which` as
 * `findSuite()` takes it, or all of them. A suite that cannot be asked, or
 * has been taken down, is left as it is, and says why. Updating the members
 * already installed is `update()`'s job, not this.
 */
export async function updateSuites(which: string | undefined, options: SuiteOptions = {}): Promise<SuiteResult[]> {
    const SUITE = await import('./suite.ts');
    const log = options.log ?? (() => {});
    const all = suites();
    const named = which === undefined ? undefined : findSuite(which);
    if (which !== undefined && !named) throw new Error(`no suite installed as '${which}'`);
    const results: SuiteResult[] = [];
    for (const name of named !== undefined ? [named] : Object.keys(all).sort()) {
        const suite = all[name]!;
        log(`* suite ${name}: asking ${suite.source}`);
        let members: SuiteMember[];
        try {
            // Asked where it was found: its repository, or the domain's `nsuite:` record.
            members = (suite.source.startsWith('at://') ? await SUITE.followSuite(suite.source, options.network)
                : suite.source.startsWith('https://') ? await SUITE.fetchSuiteUrl(suite.source)
                : await SUITE.resolveSuiteDomain(suite.source, { resolveTxt: options.resolveTxt })).record.members;
            await judgeSuite(name, members, options);
        } catch (err) {
            log(`  ! ${message(err)} — its members are left as they are`);
            results.push({ suite, members: [], problem: message(err) });
            continue;
        }
        results.push(await follow(suite, members, options));
    }
    return results;
}

/**
 * Uninstall a suite — `which` as `findSuite()` takes it — and what it brought,
 * unless another suite has that too. What was there before it, or installed
 * by hand since, stays.
 */
export async function uninstallSuite(which: string): Promise<SuiteResult> {
    const { records } = await import('./install.ts');
    const name = findSuite(which);
    if (!name) throw new Error(`no suite installed as '${which}'`);
    const all = suites();
    const suite = all[name]!;
    delete all[name];
    write(all);
    // Plugins before the apps they are for: an app takes its plugins with it.
    const scoped = (member: MemberState) => (member.install !== undefined && records()[member.install]?.scope !== undefined ? 0 : 1);
    const members: MemberResult[] = [];
    for (const member of [...suite.members].sort((a, b) => scoped(a) - scoped(b))) members.push(await drop(member, suite.name));
    return { suite, members };
}

/**
 * An install made by hand that a suite has too: it is the person's own now,
 * and stays when the suite goes. A member they had uninstalled, installed
 * again, is the suite's member again.
 */
export function adopt(record: InstallRecord, source: string): void {
    const all = suites();
    let changed = false;
    for (const suite of Object.values(all)) {
        for (const member of suite.members) {
            if (member.install !== record.name && !(member.install === undefined && member.listing === source)) continue;
            Object.assign(member, { install: record.name, brought: false, removed: undefined });
            changed = true;
        }
    }
    if (changed) write(all);
}

/**
 * Installs that are gone. Those the person uninstalled (`removed`) are left
 * out of their suites from then on; the others (`along`) — plugins that went
 * with their app — are installed again by an update, once their app is back.
 * The suites that had any of them, by name.
 */
export function forget(removed: string[], along: string[] = []): string[] {
    const all = suites();
    const affected = new Set<string>();
    for (const suite of Object.values(all)) {
        for (const member of suite.members) {
            if (member.install === undefined) continue;
            const mine = removed.includes(member.install);
            if (!mine && !along.includes(member.install)) continue;
            Object.assign(member, { install: undefined, brought: undefined, removed: mine || undefined });
            affected.add(suite.name);
        }
    }
    if (affected.size) write(all);
    return [...affected].sort();
}

/**
 * What has been said of a suite itself, by the hash of what it says: fetched
 * from everyone the policy names, whoever has said something of it before,
 * and whoever the backlink index knows of. A bad verdict from an attester the
 * policy (or `--block`) blocks on refuses the suite; any other is a warning.
 * Good verdicts are said, and count for its members as they are installed.
 */
export async function judgeSuite(name: string, members: SuiteMember[], options: SuiteOptions = {}): Promise<{ did: string; kind?: string | undefined; verdict: 'good' | 'bad' }[]> {
    const { suiteHash } = await import('./suite.ts');
    const { loadPolicy } = await import('./policy.ts');
    const ATPROTO = await import('./atproto.ts');
    const log = options.log ?? (() => {});
    const policy = options.policy ?? loadPolicy();
    const { hashAlg, hex } = suiteHash({ members });
    const blocking = new Set([...policy.block, ...(options.block ?? [])].map(({ did }) => did));
    const dids = new Set([
        ...blocking, ...policy.trust.attesters.map(({ did }) => did), ...policy.attesters.flatMap(({ attesters }) => attesters.map(({ did }) => did)),
        ...(options.attesters ?? []).map(({ did }) => did), ...cachedFor(hex),
    ]);
    if (policy.discovery && options.discover !== false) {
        try {
            for (const did of await ATPROTO.discover(hashAlg, hex, { ...options.network, index: policy.discovery })) dids.add(did);
        } catch (err) {
            log(`  ! could not ask ${policy.discovery} who has attested suite ${name}: ${message(err)}`);
        }
    }
    for (const did of policy.ignore) dids.delete(did);
    for (const problem of await ATPROTO.refreshFor([...dids].map((did) => ({ did })), hashAlg, hex, options.network)) {
        log(`  ! could not fetch an attestation of suite ${name}: ${problem}`);
    }
    const said = [...dids].flatMap((did) => {
        const found = cached(did, hashAlg, hex, { maxAge: policy.maxAge });
        return found ? [{ did, handle: found.handle, kind: found.attested, verdict: found.verdict ?? 'good' as const }] : [];
    });
    const who = (each: { did: string; handle?: string | undefined; kind?: string | undefined }) => `${each.handle ?? each.did}${each.kind ? ` (${each.kind})` : ''}`;
    const blocked = said.filter((each) => each.verdict === 'bad' && blocking.has(each.did));
    if (blocked.length) {
        throw Object.assign(new Error(`refusing suite ${name}: marked bad by ${blocked.map(who).join(', ')}, which this machine blocks on — its bundles can still be installed by themselves`),
            { code: 'ERR_BUNDLE_UNTRUSTED' });
    }
    for (const each of said) {
        log(each.verdict === 'bad' ? `  ! suite ${name} is marked bad by ${who(each)}` : `* suite ${name} is attested by ${who(each)}, which counts for its members`);
    }
    return said.map(({ did, kind, verdict }) => ({ did, kind, verdict }));
}

/** Everyone `members` expect to carry: signers as identity and issuer both, and attesters. */
export function offerFor(members: SuiteMember[], label: (member: SuiteMember) => string = (member) => member.listing): Offer {
    const offer: Offer = { signers: [], attesters: [] };
    for (const member of members) {
        const { identity, issuer, attesters = [] } = member.require ?? {};
        // A signer is accepted as identity and issuer together; a floor that
        // names one alone is checked, but has no one to offer.
        if (identity && issuer) {
            const known = offer.signers.find((each) => each.identity === identity && each.issuer === issuer);
            if (known) known.members.push(label(member));
            else offer.signers.push({ identity, issuer, members: [label(member)] });
        }
        for (const spec of attesters) {
            const { subject: did, kind } = parseAttester(spec);
            const known = offer.attesters.find((each) => each.did === did && each.kind === kind);
            if (known) known.members.push(label(member));
            else offer.attesters.push({ did, kind, members: [label(member)] });
        }
    }
    return offer;
}

// ----------------------------------------------------------------- the act ---

// Make the installed suite what it says now: members gone are dropped, and
// members not installed — new, or that did not install last time — are
// installed, after one question about everyone they expect. The record is
// saved after each, so an interrupted run still knows what it brought.
async function follow(suite: InstalledSuite, listed: SuiteMember[], options: SuiteOptions): Promise<SuiteResult> {
    const { records } = await import('./install.ts');
    const LISTING = await import('./listing.ts');
    const log = options.log ?? (() => {});
    const results: MemberResult[] = [];

    const wanted = new Set(listed.map(({ listing }) => listing));
    for (const member of suite.members.filter(({ listing }) => !wanted.has(listing))) {
        log(`* ${member.listing} is no longer in ${suite.name}`);
        results.push(await drop(member, suite.name));
    }
    const previous = new Map(suite.members.map((member) => [member.listing, member]));
    const { hashAlg, hex } = (await import('./suite.ts')).suiteHash({ members: listed });
    suite.hash = `${hashAlg}:${hex}`;
    suite.members = listed.map(({ listing, for: scope, require }) => {
        const { install, brought, removed } = previous.get(listing) ?? {};
        return { listing, for: scope, require, install, brought, removed };
    });
    suite.at = new Date().toISOString();
    save(suite);

    const installed = (member: MemberState) => member.install !== undefined && records()[member.install] !== undefined;
    for (const member of suite.members) {
        if (member.removed) results.push({ listing: member.listing, state: 'left-out', reason: 'uninstalled by itself; installing it again brings it back' });
        else if (installed(member)) results.push({ listing: member.listing, state: 'present', install: member.install });
    }
    const pending = suite.members.filter((member) => !member.removed && !installed(member));

    // One question, about everyone the members still to install expect.
    let accepted: Accepted = { signers: [], certificates: [], attesters: [] };
    const offer = offerFor(pending);
    if (options.confirm && (offer.signers.length || offer.attesters.length)) {
        accepted = await options.confirm(offer, { name: suite.name, source: suite.source });
    }

    // Each member's listing, fetched once: it says whether the member is a
    // plugin, and for which app — and is handed on, so the install does not
    // fetch it again.
    const fetched = await Promise.all(pending.map(async (member) => {
        try {
            return { member, found: await LISTING.followListing(member.listing, options.network) as Located };
        } catch (err) {
            return { member, error: message(err) };
        }
    }));
    // Apps first, so that a plugin for one finds it installed.
    const plugin = ({ member, found }: { member: MemberState; found?: Located | undefined }) =>
        (member.for !== undefined || (found && LISTING.appOf(found.record)) ? 1 : 0);
    fetched.sort((a, b) => plugin(a) - plugin(b));

    for (const { member, found, error } of fetched) {
        const result = found ? await add(suite, member, found, accepted, options) : { listing: member.listing, state: 'failed' as const, reason: error };
        if (result.state !== 'installed' && result.state !== 'present') log(`  ${member.listing}: ${result.state} — ${result.reason ?? ''}`);
        results.push(result);
        save(suite);
    }
    const order = new Map(listed.map(({ listing }, i) => [listing, i]));
    results.sort((a, b) => (order.get(a.listing) ?? -1) - (order.get(b.listing) ?? -1));
    return { suite, members: results };
}

// Install one member, as `install()` would install its listing by itself —
// or find it installed already, and have the suite share it.
async function add(suite: InstalledSuite, member: MemberState, found: Located, accepted: Accepted, options: SuiteOptions): Promise<MemberResult> {
    const { install, records, sourceOf, commandName } = await import('./install.ts');
    const LISTING = await import('./listing.ts');
    const { listing } = member;

    // Where it goes: a scope the suite names; for an app the suite names, that
    // app's package; else, for a plugin, the app its listing names.
    const all = Object.values(records());
    const hostOf = (app: string) => all.find((record) => record.scope === undefined && sourceOf(record) === app);
    let scope: string | undefined;
    const app = member.for !== undefined && LISTING.parseListingUri(member.for) ? member.for
        : member.for === undefined ? LISTING.appOf(found.record) : undefined;
    if (app !== undefined) {
        const host = hostOf(app);
        if (!host?.package) return { listing, state: 'failed', reason: `a plugin for ${app}, which is not installed here${host ? ' as a package' : ''}` };
        scope = host.package;
    } else {
        scope = member.for;
    }

    // Installed already, from this listing: the suite has it too, and leaves it be.
    const there = all.find((record) => sourceOf(record) === listing && record.scope === scope && record.link === undefined);
    if (there) {
        Object.assign(member, { install: there.name, brought: member.brought ?? false });
        return { listing, state: 'present', install: there.name };
    }
    // Never over an install of something else that happens to share the name.
    if (scope === undefined) {
        const name = commandName(found.name);
        const other = records()[name];
        if (other) return { listing, state: 'failed', reason: `'${name}' is installed already, from ${sourceOf(other)}` };
    }

    // What the person accepted for the suite counts for this member only where
    // the suite says this member carries it.
    const { identity, issuer, attesters = [] } = member.require ?? {};
    const mine: Accepted = {
        signers: accepted.signers.filter((signer) => signer.identity === identity && signer.issuer === issuer),
        certificates: [],
        attesters: accepted.attesters.filter((did) => attesters.some((spec) => parseAttester(spec).subject === did)),
    };
    const floor = minimumOf(member, `suite ${suite.name}`);
    try {
        const record = await install(listing, {
            ...options, scope, name: undefined, dir: scope === undefined ? suite.dir : undefined, located: found,
            accepted: mine, minimum: floor ? [floor] : [], inherit: [inherited(suite)],
        });
        Object.assign(member, { install: record.name, brought: true });
        return { listing, state: 'installed', install: record.name };
    } catch (err) {
        const code = (err as { code?: string }).code;
        const state = code === 'ERR_BUNDLE_UNCONFIRMED' ? 'unconfirmed'
            : code === 'ERR_BUNDLE_DECLINED' ? 'declined'
            : code === 'ERR_BUNDLE_UNTRUSTED' ? 'refused'
            : 'failed';
        return { listing, state, reason: message(err), review: (err as { review?: Review }).review };
    }
}

// A member leaving its suite, `from`: uninstalled if the suite brought it and
// no other suite has it; otherwise left installed — and handed to another
// suite that has it, when this one brought it.
async function drop(member: MemberState, from: string): Promise<MemberResult> {
    const { records, uninstall } = await import('./install.ts');
    const { listing, install: name } = member;
    if (name === undefined || !records()[name]) return { listing, state: 'kept', reason: 'it was not installed' };
    if (!member.brought) return { listing, state: 'kept', install: name, reason: 'it was installed before the suite' };
    const all = suites();
    for (const suite of Object.values(all)) {
        if (suite.name === from) continue;
        const other = suite.members.find((each) => each.install === name);
        if (!other) continue;
        other.brought = true;
        write(all);
        return { listing, state: 'kept', install: name, reason: `suite ${suite.name} has it too` };
    }
    const gone = uninstall(name);
    // An app takes its plugins with it; a suite that has those installs them
    // again once the app is back.
    forget([], gone.plugins.map((plugin) => plugin.name));
    return { listing, state: 'removed', install: name };
}
