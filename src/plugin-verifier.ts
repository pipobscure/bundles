import * as VFS from 'node:vfs';
import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { AUTHORITY, parseManifest, verifySync } from './manifest.ts';
import { attestersFrom, evaluate, type Attester } from './attestation.ts';
import { loadPolicy } from './policy.ts';
import { BundleProvider } from './provider.ts';

// The verifying half of plugins: checking a plugin before it is mounted, when
// that has been asked for. The half every host imports — finding plugins,
// resolving them, mounting them — is `plugins.ts`, which reaches this through
// a global when the process runs under a verifying runtime, and otherwise
// loads it only when a plugin is to be verified, so a host that does not
// verify never carries it in its bundle.
//
// A plugin is judged as a plugin, not as the app that loads it. It is, almost
// by definition, written by someone else, so the checks that describe who made
// the app — the signer it had to be signed by, the roots it was anchored in,
// its `apps` section of the policy — never apply to a plugin. What carries over
// from the runtime is what holds whoever the author is: the attestations it
// requires, its blocks, and that a signature is needed at all. On top of that
// come the policy's section for the plugin's scope, and whatever the host asks
// for in code. Every source's rules hold at once; none can loosen another's.
//
// See proposals/plugins.md.

/** Where a verifying runtime leaves its verifier, for the plugin loader (`plugins.ts`) to find. */
export const VERIFIER = Symbol.for('@pipobscure/bundle.plugins.verifier');

/** What a host can ask of its plugins, in code: `use(scope, { verify: rules })`. */
export interface PluginRules {
    /** The sigstore identity plugins must be signed with. */
    identity?: string | undefined;
    /** The sigstore OIDC issuer plugins must be signed through. */
    issuer?: string | undefined;
    /** Attesters that must have vouched for each plugin, as `[kind@]did`. */
    attesters?: string[] | undefined;
    /** How many of them (default: all). */
    quorum?: number | undefined;
    /** DIDs whose bad verdict refuses a plugin. */
    block?: string[] | undefined;
    /** A certificate (PEM text, or a path to one) every plugin's chain must lead to. */
    ca?: string | undefined;
}

/**
 * What the plugin loader calls. Versioned, because the runtime and the copy of
 * the loader inside an app's bundle can be different releases.
 */
export interface PluginVerifier {
    readonly version: 1;
    /** True when a verifying runtime installed this: every plugin is verified, asked for or not. */
    readonly enforcing: boolean;
    /** Verify a plugin and mount it, or throw an error whose `reasons` say every way it fell short. */
    mountPlugin(file: string, request: { scope: string; rules?: PluginRules | undefined }): { root: string };
}

/** One group of attesters, all of which (or a quorum of which) must have vouched. */
export interface AttesterGroup {
    attesters: Attester[];
    quorum?: number | undefined;
}

/** What carries over from the runtime that verified the app to the plugins it loads. */
export interface Carried {
    /** The runtime would not mount an unsigned archive without attestations. */
    signature: boolean;
    groups: AttesterGroup[];
    block: Attester[];
    maxAge?: number | undefined;
    /** The sigstore trust root — the machine's, not the app's. */
    trustedRoot?: string | undefined;
}

/** Nothing carried over: a process that is not verifying, which asked to verify its plugins itself. */
export const NOTHING_CARRIED: Carried = { signature: false, groups: [], block: [] };

const RUNTIME = 'carried over from the runtime';
const APP = 'required by this app';

/**
 * A verifier. `enforcing` says a verifying runtime is behind it, so every
 * plugin is verified whether the host asked or not.
 */
export function verifier({ enforcing = false, carried = NOTHING_CARRIED }: {
    enforcing?: boolean | undefined;
    carried?: Carried | undefined;
} = {}): PluginVerifier & { readonly carried: Carried } {
    return {
        version: 1,
        enforcing,
        carried,
        mountPlugin: (file, { scope, rules }) => mountPlugin(file, scope, rules ?? {}, carried),
    };
}

/**
 * What a verifying runtime calls once it is in place: from now on every
 * plugin this thread loads is verified, with `carried`. A second verifying
 * runtime in the same thread adds to what the first carried over.
 */
export function enforce(carried: Carried): void {
    const global = globalThis as unknown as Record<symbol, ReturnType<typeof verifier> | undefined>;
    const before = global[VERIFIER]?.carried;
    global[VERIFIER] = verifier({
        enforcing: true,
        carried: before ? {
            signature: before.signature || carried.signature,
            groups: [...before.groups, ...carried.groups],
            block: [...before.block, ...carried.block],
            maxAge: shorter(before.maxAge, carried.maxAge),
            trustedRoot: carried.trustedRoot ?? before.trustedRoot,
        } : carried,
    });
}

/**
 * What carries over from a runtime's settings: its attesters, its blocks, and
 * — when it names no attesters — that it requires a signature. Never its
 * signer identity, its issuer, its extra roots or `allowUntrusted`: those are
 * about the app's author.
 */
export function carriedFrom({ attesters, quorum, block, maxAge, trustedRoot }: {
    attesters: Attester[];
    quorum?: number | undefined;
    block: Attester[];
    maxAge?: number | undefined;
    trustedRoot?: string | undefined;
}): Carried {
    return {
        signature: attesters.length === 0,
        groups: attesters.length ? [{ attesters, quorum }] : [],
        block,
        maxAge,
        trustedRoot,
    };
}

/** The verifier the loader uses when the process is not verifying, and the host asked. */
export const pluginVerifier = verifier();

// ------------------------------------------------------------------ checking ---

function mountPlugin(file: string, scope: string, rules: PluginRules, carried: Carried): { root: string } {
    if (rules.quorum !== undefined && !rules.attesters?.length) throw new TypeError('verify.quorum needs verify.attesters');
    const path = PATH.resolve(file);
    const policy = loadPolicy(undefined, { scope, global: false });
    const ca = rules.ca ? new CRYPTO.X509Certificate(rules.ca.includes('-----BEGIN') ? rules.ca : FS.readFileSync(rules.ca, 'utf-8')) : undefined;
    const reasons: string[] = [];

    const archive = ZLIB.ZipFile.openSync(path);
    let mounted = false;
    try {
        const res = verifySync(path, {
            archive, deep: false, integrity: true,
            extraRoots: ca ? [ca.toString()] : [],
            trustedRoot: carried.trustedRoot,
            identity: rules.identity, issuer: rules.issuer,
        });
        // Bytes that do not hold together are the whole answer.
        if (res.state === 'invalid' || !res.hash || !res.hashAlg) throw refusal(path, [res.reason]);

        const groups = [
            ...carried.groups.map((group) => ({ ...group, source: RUNTIME })),
            ...policy.attesters.map(({ attesters, quorum, source }) => ({ attesters, quorum, source })),
            ...(rules.attesters?.length ? [{ attesters: attestersFrom(rules.attesters), quorum: rules.quorum, source: APP }] : []),
        ];
        const maxAge = shorter(carried.maxAge, policy.maxAge);
        for (const { attesters, quorum, source } of groups) {
            const outcome = evaluate({ attesters, quorum, maxAge }, res.hashAlg, res.hash);
            if (!outcome.met) reasons.push(`${outcome.reason} (${source})`);
        }
        const blocks: [Attester[], string][] = [
            [carried.block, RUNTIME],
            [policy.block, `the policy's scopes.${scope}`],
            [attestersFrom(rules.block), APP],
        ];
        for (const [block, source] of blocks) {
            if (!block.length) continue;
            const outcome = evaluate({ attesters: [], block, maxAge }, res.hashAlg, res.hash);
            if (outcome.blocked.length) reasons.push(`${outcome.reason} (${source})`);
        }

        // A plugin nobody has attested must at least be signed, and anchored;
        // and so must one whose signer, issuer or authority was asked for.
        const needed = [
            ...(carried.signature ? [RUNTIME] : []),
            ...policy.signature,
            ...(rules.identity || rules.issuer || ca ? [APP] : []),
        ];
        if (!groups.length && !needed.length) needed.push('nothing else vouches for it');
        if (needed.length && res.state !== 'valid') {
            reasons.push(`${res.state === 'unsigned' ? 'unsigned' : res.reason}, and a trusted signature is required (${needed.join('; ')})`);
        }
        for (const { list, source } of policy.issuers) {
            if (res.sigstore && !list.includes(res.issuer ?? '')) reasons.push(`signed through ${res.issuer}, which is not one of ${list.join(', ')} (${source})`);
        }
        if (ca && res.signed && !leadsTo(archive, ca)) reasons.push(`not signed under the certificate authority ${ca.subject.replace(/\n/g, ', ')} (${APP})`);

        if (reasons.length) throw refusal(path, reasons);
        const provider = new BundleProvider(archive, { hashAlg: res.hashAlg, digests: res.digests });
        const root = VFS.create(provider, { emitExperimentalWarning: false }).mount();
        mounted = true;
        return { root };
    } finally {
        if (!mounted) archive.closeSync();
    }
}

// Whether the chain the archive carries ends at `ca`, or at something `ca` issued.
function leadsTo(archive: ZLIB.ZipFile, ca: CRYPTO.X509Certificate): boolean {
    if (!archive.has(AUTHORITY)) return false;
    const top = parseManifest(archive.getSync(AUTHORITY).contentSync()).chain.at(-1);
    if (!top) return false;
    return top.fingerprint256 === ca.fingerprint256 || (top.checkIssued(ca) && top.verify(ca.publicKey));
}

function refusal(path: string, reasons: string[]): Error {
    return Object.assign(new Error(`bundle: refusing to load the plugin '${path}': ${reasons.join('; ')}`),
        { code: 'ERR_BUNDLE_UNTRUSTED', reasons });
}

function shorter(a: number | undefined, b: number | undefined): number | undefined {
    return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}
