import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { attestersFrom, parseDuration, type Attester } from './attestation.ts';
import { isScope } from './scopes.ts';

export { SCOPE_PATTERN, isScope } from './scopes.ts';

// The rules this machine installs by.
//
// Installing and updating ask a person to accept whoever vouches for an archive
// they have not seen before. The policy file is where that person — or whoever
// administers the machine — writes down the decisions that should not be left
// to a prompt:
//
//   * **requirements**, which are mandatory: an archive that does not meet one
//     is refused, never offered. Only these and command-line flags (`--identity`,
//     `--issuer`, `--attester`) create obligations; nothing an archive was
//     installed with does, so a publisher who moves to a different signer or
//     gathers different attestations produces a question, not a breakage.
//   * **issuers**, the only OIDC issuers whose sigstore signatures count at all.
//   * **trust**, signers and attesters accepted without asking.
//   * **block**, attesters whose bad verdict refuses an archive outright, and
//     **ignore**, attesters whose verdicts are not even shown. A bad verdict
//     from anyone else is a warning — anyone can publish one, so on its own it
//     decides nothing — unless it comes from someone already trusted or
//     accepted, in which case nothing proceeds without asking.
//
// Two files are read: one for the machine and one for the user. Requirements
// from both apply; trust from both adds up. Each file has global rules; under
// `apps`, rules for one installed name; and under `scopes`, rules for the
// plugins installed for one app (`bundle install --for <scope>`), which apply
// to those plugins and never to the app. Unknown keys are an error, so a typo
// cannot quietly loosen anything.
//
//   {
//     "require": {
//       "signature": true,
//       "sameIssuer": true,
//       "attesters": ["audited@did:web:audit.example.com"],
//       "quorum": 1
//     },
//     "issuers": ["https://token.actions.githubusercontent.com"],
//     "trust": {
//       "signers": [{ "identity": "https://github.com/o/r/.github/workflows/release.yml@refs/heads/main",
//                     "issuer": "https://token.actions.githubusercontent.com" }],
//       "attesters": ["did:web:audit.example.com"],
//       "certificates": ["AB:CD:…"]
//     },
//     "block": ["did:web:scanner.example.com"],
//     "ignore": ["did:plc:…"],
//     "discovery": "https://constellation.microcosm.blue",
//     "maxAge": "7d",
//     "apps": { "pnpm": { "require": { "sameIssuer": true } } },
//     "scopes": { "bled": { "require": { "attesters": ["audited@did:web:bled.dev"] } } }
//   }

// The settings each part of a policy file may have — what the checker below
// accepts, and what the published JSON Schema lists, which a test holds to
// exactly these.
export const FILE_KEYS = ['$schema', 'require', 'issuers', 'trust', 'block', 'ignore', 'discovery', 'maxAge', 'apps', 'scopes'];
export const RULE_KEYS = ['require', 'issuers', 'trust', 'block', 'ignore'];
export const REQUIRE_KEYS = ['signature', 'sameIssuer', 'attesters', 'quorum'];
export const TRUST_KEYS = ['signers', 'attesters', 'certificates'];
export const SIGNER_KEYS = ['identity', 'issuer'];

/** A SHA-256 certificate fingerprint, as `node:crypto` prints one. */
export const FINGERPRINT_PATTERN = '^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$';
/** Where discovery may point. */
export const DISCOVERY_PATTERN = '^https?://';

/**
 * Where the JSON Schema for policy files is published: attached to each GitHub
 * release, so a file can name the schema of the version that wrote it.
 * `version` absent means the latest release's.
 */
export function schemaUrl(version?: string | undefined): string {
    const releases = 'https://github.com/pipobscure/bundles/releases';
    return version ? `${releases}/download/v${version}/policy.schema.json` : `${releases}/latest/download/policy.schema.json`;
}

/** A policy file's text, with `$schema` first, pointing at `version`'s schema. */
export function formatPolicyFile(file: PolicyFile, version: string): string {
    const { $schema: _, ...rules } = file as PolicyFile & { $schema?: unknown };
    return `${JSON.stringify({ $schema: schemaUrl(version), ...rules }, null, 2)}\n`;
}

/**
 * A policy file to start from: nothing required, nothing trusted, every section
 * present so an editor offers what goes in each.
 */
export function starterPolicy(): PolicyFile {
    return { require: {}, trust: { signers: [], attesters: [] }, block: [], ignore: [] };
}

/** The public backlink index attestations are discovered through. */
export const DEFAULT_DISCOVERY = 'https://constellation.microcosm.blue';

/** A sigstore signer: an identity, through an issuer. */
export interface Signer {
    identity: string;
    issuer: string;
}

/** The rules one section of a policy file may give. */
export interface Rules {
    require?: {
        /** The archive must carry a signature that verifies (from an accepted issuer). */
        signature?: boolean | undefined;
        /** An update must be signed through the same issuer as the version it replaces. */
        sameIssuer?: boolean | undefined;
        /** Attesters that must have vouched, as `[kind@]did`. */
        attesters?: string[] | undefined;
        /** How many of them (default: all). */
        quorum?: number | undefined;
    } | undefined;
    /** The only OIDC issuers whose signatures count. */
    issuers?: string[] | undefined;
    trust?: {
        signers?: Signer[] | undefined;
        /** `[kind@]did`: attestations accepted without asking. */
        attesters?: string[] | undefined;
        /** SHA-256 fingerprints of certificate-chain roots accepted without asking. */
        certificates?: string[] | undefined;
    } | undefined;
    /** DIDs whose bad verdict refuses an archive. */
    block?: string[] | undefined;
    /** DIDs whose verdicts, good or bad, are not shown or counted. */
    ignore?: string[] | undefined;
}

/** A policy file. */
export interface PolicyFile extends Rules {
    /** Where attestations are discovered, or false not to look. */
    discovery?: string | false | undefined;
    /** How stale a cached attestation proof may be, as a duration. */
    maxAge?: string | undefined;
    apps?: Record<string, Rules> | undefined;
    /** Rules for the plugins installed for one app, by its package name. */
    scopes?: Record<string, Rules> | undefined;
}

/** An attestation requirement, and where it came from. */
export interface AttesterClause {
    attesters: Attester[];
    quorum?: number | undefined;
    source: string;
}

/** Everything in force for one install, from every source. */
export interface Policy {
    /** The files that were read. */
    files: string[];
    /** Where a signature was required, if anywhere. */
    signature: string[];
    /** Where same-issuer updates were required, if anywhere. */
    sameIssuer: string[];
    attesters: AttesterClause[];
    /** Each source's list of acceptable issuers; a signature must be in every one. */
    issuers: { list: string[]; source: string }[];
    trust: { signers: Signer[]; attesters: Attester[]; certificates: string[] };
    block: Attester[];
    ignore: string[];
    discovery: string | false;
    maxAge?: number | undefined;
}

/** An empty policy: nothing required, nothing trusted, discovery on. */
export function emptyPolicy(): Policy {
    return {
        files: [], signature: [], sameIssuer: [], attesters: [], issuers: [],
        trust: { signers: [], attesters: [], certificates: [] },
        block: [], ignore: [],
        discovery: DEFAULT_DISCOVERY,
    };
}

/** The machine-wide policy file (`BUNDLE_SYSTEM_POLICY` overrides it). */
export function systemPolicyPath(): string {
    const configured = process.env['BUNDLE_SYSTEM_POLICY'];
    if (configured) return PATH.resolve(configured);
    if (process.platform === 'win32') return PATH.join(process.env['ProgramData'] || 'C:\\ProgramData', 'bundle', 'policy.json');
    if (process.platform === 'darwin') return '/Library/Application Support/bundle/policy.json';
    return '/etc/bundle/policy.json';
}

/** The user's policy file (`BUNDLE_POLICY` overrides it). */
export function userPolicyPath(): string {
    const configured = process.env['BUNDLE_POLICY'];
    if (configured) return PATH.resolve(configured);
    const home = OS.homedir();
    if (process.platform === 'win32') return PATH.join(process.env['APPDATA'] || PATH.join(home, 'AppData', 'Roaming'), 'bundle', 'policy.json');
    if (process.platform === 'darwin') return PATH.join(home, 'Library', 'Application Support', 'bundle', 'policy.json');
    return PATH.join(process.env['XDG_CONFIG_HOME'] || PATH.join(home, '.config'), 'bundle', 'policy.json');
}

/**
 * The policy in force for `app` (an installed name), or the global one: the
 * system file, then the user's, each with its `apps[app]` section.
 *
 * With `scope`, it is the policy for a plugin installed for that app instead:
 * the global rules and each file's `scopes[scope]` section — never the app's
 * own `apps` section, which is about the app's author, not the plugin's. With
 * `global: false` as well, only the scope's sections: what a plugin is checked
 * against when it is loaded, on top of what the runtime carries over.
 */
export function loadPolicy(app?: string | undefined, { scope, global = true }: {
    scope?: string | undefined;
    global?: boolean | undefined;
} = {}): Policy {
    const policy = emptyPolicy();
    let discovery: string | false | undefined;
    for (const path of [systemPolicyPath(), userPolicyPath()]) {
        const file = readPolicyFile(path);
        if (!file) continue;
        policy.files.push(path);
        if (global) apply(policy, file, path);
        const section = scope !== undefined ? file.scopes?.[scope] : app !== undefined ? file.apps?.[app] : undefined;
        if (section) apply(policy, section, scope !== undefined ? `${path} (scopes.${scope})` : `${path} (apps.${app})`);
        // The user's choice of index wins, unless the machine turned discovery off.
        if (file.discovery !== undefined && discovery !== false) discovery = file.discovery;
        if (file.maxAge !== undefined) {
            const age = parseDuration(file.maxAge);
            policy.maxAge = policy.maxAge === undefined ? age : Math.min(policy.maxAge, age);
        }
    }
    if (discovery !== undefined) policy.discovery = discovery;
    return policy;
}

/** Read and check one policy file; null when there is none. */
export function readPolicyFile(path: string): PolicyFile | null {
    let text: string;
    try {
        text = FS.readFileSync(path, 'utf-8');
    } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return null;
        throw err;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    checkFile(parsed, path);
    return parsed as PolicyFile;
}

function apply(policy: Policy, rules: Rules, source: string): void {
    const { require, issuers, trust, block, ignore } = rules;
    policy.block.push(...attestersFrom(block));
    policy.ignore.push(...attestersFrom(ignore).map(({ did }) => did));
    if (require?.signature) policy.signature.push(source);
    if (require?.sameIssuer) policy.sameIssuer.push(source);
    if (require?.attesters?.length) {
        policy.attesters.push({ attesters: attestersFrom(require.attesters), quorum: require.quorum, source });
    }
    if (issuers?.length) policy.issuers.push({ list: issuers, source });
    policy.trust.signers.push(...(trust?.signers ?? []));
    policy.trust.attesters.push(...attestersFrom(trust?.attesters));
    policy.trust.certificates.push(...(trust?.certificates ?? []).map((fingerprint) => fingerprint.toUpperCase()));
}

// ---------------------------------------------------------------- checking ---

function checkFile(value: unknown, path: string): void {
    const file = object(value, path);
    keys(file, FILE_KEYS, path);
    if (file['$schema'] !== undefined) string(file['$schema'], `${path}: $schema`);
    checkRules(file, path);
    if (file['discovery'] !== undefined && file['discovery'] !== false) {
        const discovery = string(file['discovery'], `${path}: discovery`);
        if (!new RegExp(DISCOVERY_PATTERN).test(discovery)) throw new Error(`${path}: discovery must be an http(s) URL or false`);
    }
    if (file['maxAge'] !== undefined) parseDuration(string(file['maxAge'], `${path}: maxAge`));
    for (const part of ['apps', 'scopes']) {
        if (file[part] === undefined) continue;
        for (const [name, rules] of Object.entries(object(file[part], `${path}: ${part}`))) {
            const where = `${path}: ${part}.${name}`;
            if (!name) throw new Error(`${path}: ${part} has an entry with no name`);
            if (part === 'scopes' && !isScope(name)) throw new Error(`${path}: scopes: '${name}' is not a package name`);
            keys(object(rules, where), RULE_KEYS, where);
            checkRules(rules as Record<string, unknown>, where);
        }
    }
}

function checkRules(rules: Record<string, unknown>, where: string): void {
    if (rules['require'] !== undefined) {
        const require = object(rules['require'], `${where}: require`);
        keys(require, REQUIRE_KEYS, `${where}: require`);
        for (const flag of ['signature', 'sameIssuer']) {
            if (require[flag] !== undefined && typeof require[flag] !== 'boolean') throw new Error(`${where}: require.${flag} must be true or false`);
        }
        const attesters = strings(require['attesters'], `${where}: require.attesters`);
        attestersFrom(attesters);
        if (require['quorum'] !== undefined) {
            const quorum = require['quorum'];
            if (typeof quorum !== 'number' || !Number.isInteger(quorum) || quorum < 1 || quorum > attesters.length) {
                throw new Error(`${where}: require.quorum must be between 1 and the number of attesters`);
            }
        }
    }
    strings(rules['issuers'], `${where}: issuers`);
    for (const list of ['block', 'ignore']) {
        for (const did of strings(rules[list], `${where}: ${list}`)) {
            if (attestersFrom([did])[0]!.kind) throw new Error(`${where}: ${list} takes DIDs, not '${did}'`);
        }
    }
    if (rules['trust'] !== undefined) {
        const trust = object(rules['trust'], `${where}: trust`);
        keys(trust, TRUST_KEYS, `${where}: trust`);
        if (trust['signers'] !== undefined) {
            if (!Array.isArray(trust['signers'])) throw new Error(`${where}: trust.signers must be a list`);
            for (const signer of trust['signers']) {
                const entry = object(signer, `${where}: trust.signers[]`);
                keys(entry, SIGNER_KEYS, `${where}: trust.signers[]`);
                string(entry['identity'], `${where}: trust.signers[].identity`);
                string(entry['issuer'], `${where}: trust.signers[].issuer`);
            }
        }
        attestersFrom(strings(trust['attesters'], `${where}: trust.attesters`));
        for (const fingerprint of strings(trust['certificates'], `${where}: trust.certificates`)) {
            if (!new RegExp(FINGERPRINT_PATTERN).test(fingerprint)) {
                throw new Error(`${where}: '${fingerprint}' is not a SHA-256 fingerprint (AB:CD:…)`);
            }
        }
    }
}

function object(value: unknown, where: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
    return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw new Error(`${where}: unknown setting '${key}' (expected one of ${allowed.join(', ')})`);
    }
}

function string(value: unknown, where: string): string {
    if (typeof value !== 'string' || !value) throw new Error(`${where} must be a non-empty string`);
    return value;
}

function strings(value: unknown, where: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item)) {
        throw new Error(`${where} must be a list of strings`);
    }
    const duplicate = value.find((item, index) => value.indexOf(item) !== index);
    if (duplicate !== undefined) throw new Error(`${where} lists '${String(duplicate)}' twice`);
    return value as string[];
}
