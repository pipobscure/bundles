import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { parseArgs } from 'node:util';
import { createBundle, signBundle, verifyBundle, runBundle, fileSigner } from './api.ts';
import { members } from './archive.ts';
import { launcherPath, packageVersion } from './files.ts';
import * as AUDIT from './audit.ts';
import { message, wholeFileHash, STATES, type VerificationResult, type VerificationState } from './manifest.ts';
import { formatAttester, parseDuration, policyFromEnvironment, cachedDids, type Attester } from './attestation.ts';

// Re-exported because this is where a CLI consumer looks for it; it is defined
// in the format layer so the `bundle` launcher can report an exit code without
// loading the whole CLI.
export { STATES };
import * as SKILLS from './skill.ts';
import * as REVIEW from './review.ts';

// Argument parsing and reporting, and nothing else. Every command below is a
// `parseArgs` call, a message or two, and one call into `api.ts` — which is
// deliberate: what the CLI can do is exactly what an embedder can do, because
// they are the same functions.

export const USAGE = `usage: bundle <command> [options]
       bundle -v, --version

commands:
  create    build an archive from a list of files
  sign      sign an archive into a new file, optionally behind a prefix
  audit     report what is about to be reviewed, and gate signing on the verdict
  verify    verify an archive and report its trust state
  attest    vouch for an archive from an atproto account, or withdraw that
  run       mount a signed archive and run it
  install   fetch a signed archive from a URL or domain and put it on your PATH
  update    refetch what was installed, and replace it if it changed
  installed list what is installed, and re-check each against its record
  uninstall remove an installed archive, and forget where it came from
  sea       build a node runtime that verifies an archive before running it
  trust     refresh the sigstore trust root and the cached attestations
  policy    show the rules this machine installs by, and where they come from
  lexicon   show, check or publish the atproto lexicons attestations are written in
  skill     install this package's bundle-auditing skill into a project

create options:
  -b, --base <dir>      base directory the file list is relative to (default: .)
  -p, --prefix <file>   prefix prepended before the archive (launcher or binary);
                        omit it for a plain archive meant to be run from a mount
  -f, --files <file>    read the newline-separated file list from here (default: stdin)
  -o, --output <file>   write the archive here (default: stdout)
  -k, --key <file>      leaf private key (PEM); signs at build time with --chain
  -c, --chain <file>    full certificate chain (PEM, leaf first)
      --hash <alg>      digest for the whole-file hash and member digests (default: sha256)
      --sign <alg>      digest the signature over that hash uses (default: sha256)

sign options:                       usage: sign [options] <archive>
  -o, --output <file>   write the signed archive here (default: stdout)
  -l, --launcher        prepend this package's shell launcher, so the result runs
                        by name — the usual way to make a self-executing archive
  -p, --prefix <file>   prepend some other prefix: a launcher of your own, or a
                        node binary; omit both for a plain mountable archive
  -x, --executable      make the output executable (implied by --launcher/--prefix)
      --hash <alg>      digest for the whole-file hash and member digests (default: sha256)
      --sign <alg>      digest the signature over that hash uses (default: sha256)

  by default this signs through sigstore, taking the identity from CI when
  there is one and otherwise opening a GitHub sign-in:
      --flow <how>          auto | ci | browser | device (default: auto)
      --token <jwt>         use this OIDC token instead of signing in
      --oidc-issuer <url>   OIDC issuer (default: sigstore's dex)
      --connector <name>    identity provider to jump to (default: github)
      --fulcio <url>        certificate authority (default: fulcio.sigstore.dev)
      --rekor <url>         transparency log; empty string to skip it
      --tsa <url>           timestamp authority; empty string to skip it

  or, to sign against a certificate authority of your own:
  -k, --key <file>      leaf private key (PEM)
  -c, --chain <file>    full certificate chain (PEM, leaf first)

audit options:                      usage: audit [options] <archive>
  -b, --baseline <file> a previously approved archive to review against, so the
                        review is of what changed rather than of everything
  -v, --verdict <file>  where the verdict is (default: <archive>.audit.json)
      --check           exit non-zero unless a clean verdict pins these bytes
      --approve         record a clean verdict you reached by reading it yourself
  -n, --note <text>     what you checked, recorded with --approve

  with none of those it reports what is about to be reviewed and how. The review
  itself needs judgement, so no command performs it: install the skill with
  'bundle skill' and run /audit-bundle, or read the archive yourself and
  --approve. Signing is not gated unless you run --check before it.

verify options:                     usage: verify [options] <archive>
  -a, --archive <file>  archive to verify (or pass it as a positional argument)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --sigstore-root <file>  sigstore trust root (default: the cache 'trust' fills)
      --attester <[kind@]who>  require an attestation from this DID or handle,
                        optionally of this kind (audited@did:web:…); repeatable
      --quorum <n>      how many of the attesters must have attested (default: all)
      --max-age <time>  how stale a cached attestation may be (default: 7d)
      --block <who>     refuse it if this DID or handle has marked it bad; repeatable
      --json            print the result as JSON

  with attesters, their attestations of this file are fetched first; if that
  fails, what the cache holds is used. A signature is then optional — when
  there is one it must verify, but its certificate only has to be trusted if
  --identity or --issuer ask for a signer too.

attest options:                     usage: attest [options] <archive>...
      --as <handle | did>  the account to attest as
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --kind <kind>     what is being said: published, audited, reproduced —
                        or, with --verdict bad, malware, vulnerable, …
      --verdict <v>     good (the default) to vouch for it, bad to warn
                        everyone who installs it against it
      --note <text>     a short note kept with the attestation
      --revoke          withdraw the attestations instead
      --password-file <file>  use an app password from this file instead of
                        signing in — for CI, where there is no browser
                        (BUNDLE_ATPROTO_PASSWORD works too; never an argument)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable

  every archive named is checked first, and one that does not hold together
  stops them all. Then one sign-in covers them: OAuth, in the browser, against
  the account's own PDS, asking for write access to attestation records and
  nothing else where the server supports that. Nothing is kept — the session is
  revoked when the command is done, so every attest is approved by whoever it
  speaks for.

  writes com.pipobscure.bundle.attestation/<hash> to the account's repository, naming
  the archive's whole-file hash — the hash a signature covers. The archive is
  checked first: one whose bytes or signature do not hold together is refused.

run options:                        usage: run [options] <archive> [app args...]
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --attester <[kind@]who>  require an attestation from this DID or handle;
                        repeatable. Fetched before running, else the cache
      --quorum <n>      how many of the attesters must have attested (default: all)
      --max-age <time>  how stale a cached attestation may be (default: 7d)
      --block <who>     refuse it if this DID or handle has marked it bad; repeatable
      --untrusted       run an archive whose signature is good but unanchored —
                        never one that misses what the flags above demand

  these options come before the archive; everything after it is the program's,
  flags included. A '--' is accepted there too, for the habit.

sea options:                        usage: sea [options] [archive]
  -o, --output <file>   write the executable here (required)
      --node <file>     node binary to embed (default: the running one)
      --base <file>     reuse a SEA base built earlier instead of building one
      --no-sigstore     leave the sigstore libraries out of the embedded verifier
      --untrusted       let the finished executable run an archive whose
                        signature is good but unanchored
  -r, --root <file>     trusted root the executable checks against; repeatable
      --identity <san>  identity the executable requires of a signature
      --issuer <url>    issuer the executable requires of a signature
      --attester <[kind@]who>  attester the executable requires; repeatable.
                        Handles are resolved now, and the DID is what is baked
      --quorum <n>      how many of the attesters (default: all)
      --max-age <time>  how stale a cached attestation may be (default: 7d)
      --block <who>     refuse what this DID or handle has marked bad; repeatable

  with an archive, the result is that application: one file that verifies
  itself and runs what is inside it. without one, the result is a verifying
  node — a runtime that takes an archive on its own command line:

      bundle sea -o node-verifying
      ./node-verifying ./my-app.zip --args --for --the --app

  a runtime built with a policy (-r, --identity, --issuer, --attester) is
  sealed: it accepts no policy from its command line, because a binary that
  demands a signing identity is not one whose user can ask it to stop. It
  checks attestations against the cache 'bundle trust' keeps current, and
  never the network.

  the signing options are the same as 'sign': sigstore by default, or --key
  with --chain against a certificate authority of your own

install options:                    usage: install [options] [url | domain]
  -y, --yes             accept everything found, rather than asking
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --attester <[kind@]who>  require an attestation from this DID or handle;
                        repeatable
      --quorum <n>      how many of the attesters must have attested (default: all)
      --block <who>     refuse it if this DID or handle has marked it bad; repeatable
      --no-discover     do not ask the backlink index who has attested it
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
  -n, --name <name>     install under this name, rather than the one the
                        server suggests (Content-Disposition, else the URL)
  -d, --dir <dir>       where to install (default: ~/.local/bin, or
                        %LOCALAPPDATA%\\bundle\\bin; BUNDLE_INSTALL_DIR overrides)

  everything that vouches for the archive is found and shown: its signature,
  and every attestation of it — from attesters this machine knows, and from
  anyone a backlink index says has attested it (each one fetched from the
  attester's own PDS and verified). Bad verdicts are shown as warnings.

  what is accepted without asking: a signer or attester accepted for this
  install before, one the policy trusts ('bundle policy'), one a flag demands,
  or a certificate anchored in the trust store. Anything else is a question —
  on a terminal you are asked which to accept; elsewhere it stops with exit 4
  unless --yes. What you accept is remembered for later updates.

  what refuses: an archive whose bytes or signature do not verify; a missing
  --identity, --issuer or --attester; a policy requirement not met; a bad
  verdict from someone --block or the policy blocks on.

  a domain instead of a url is looked up in DNS: a TXT record of the form
  'nzip:<url>' says what to fetch, with <url> either https or resolved
  against https://<domain>/, and the domain's first label is the name. So a
  TXT record 'nzip:/app/npm.nzip' on npm.npmjs.org makes
  'bundle install npm.npmjs.org' fetch https://npm.npmjs.org/app/npm.nzip
  and install it as 'npm'. The record only says where; the archive is
  verified exactly as a url's would be.

  with neither, this package installs itself from its own published release,
  whose publish workflow's signature is accepted without asking — so
  'npx @pipobscure/bundle install' leaves a signed 'bundle' on your PATH that
  'bundle update' keeps current. The archive is named '.nzip', and the name it
  installs under drops that everywhere but Windows, where the extension is what
  makes it runnable.

update options:                     usage: update [options] [name]
  -y, --yes             accept everything found for a new version, rather than asking
      --identity, --issuer, --attester, --quorum, --block, --no-discover, --root
                        as for install, demanded of every new version this run

  with no name, every install is checked. Each is a conditional request with
  the recorded ETag, so nothing is downloaded twice. A new version is reviewed
  like an install, against what has been accepted for it so far: a new signer,
  or different attestations, is a question rather than a failure — publishers
  move, and auditors do not review every release. Only flags and the policy
  make anything mandatory.

installed options:                  usage: installed [options]
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --json            print the results as JSON

  says what is installed, where it came from and who vouched for it — and
  checks each one: the file is there, its bytes are still the bytes that were
  installed, someone accepted for it still vouches for it, the policy still
  holds, and nobody it blocks on has marked it bad since. Attestations are
  fetched fresh first. Exits non-zero if any of that is no longer true.

policy options:                     usage: policy [show | init | check <file>] [options]
  -a, --app <name>      the rules for this installed name, apps section included
      --json            print the rules in force as JSON (merged — not a policy file)
      --system          the machine's file: the one init writes, or the one shown
      --user            the user's file (what init writes by default)
  -f, --force           init over a file that is already there

  with no subcommand, says what rules are in force and which files they come
  from. 'show' prints the policy files themselves; 'init' writes a starter file;
  'check' validates a file the way an install will read it.

  the policy is read from a file for the machine (/etc/bundle/policy.json, or
  BUNDLE_SYSTEM_POLICY) and one for the user (~/.config/bundle/policy.json, or
  BUNDLE_POLICY). Both are JSON, described by a JSON Schema published with each
  release; files written or shown here start with a "$schema" pointing at the
  one for this version, so an editor can complete and check them.

lexicon options:                    usage: lexicon [check | publish] [options]
      --as <handle | did>  the account to publish from
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --dry-run         say what publish would write, and stop before signing in
      --force           publish even though DNS does not name that account yet
      --password-file <file>  an app password instead of signing in, for CI
                        (BUNDLE_ATPROTO_PASSWORD works too)

  with no subcommand, lists the lexicons this package carries and the DNS
  record each needs: a TXT record '_lexicon.<authority>' saying 'did=<DID>',
  naming the account whose repository publishes them. 'check' resolves that
  and compares what is published — verified — with what is here. 'publish'
  writes each as a com.atproto.lexicon.schema record from --as, signing in
  with access to that collection only, and reads it back.

uninstall options:                  usage: uninstall [name | url | domain]

  deletes the file and forgets the record. With no argument it removes this
  package's own install — what 'bundle install' left behind. The .nzip
  association on Windows is left alone: other archives may need it.

trust options:
      --mirror <url>    TUF repository to refresh from (default: sigstore's)
      --attester <who>  also keep this DID's or handle's attestations; repeatable
      --no-sigstore     refresh only the attestations

  attestations are kept for every attester named here, in BUNDLE_ATTESTERS,
  in an install record, or already in the cache: each one's attestations are
  listed, new ones fetched and verified, and withdrawn ones dropped. That is
  what a verifying runtime — which never reaches for the network — checks
  against, and what decides how stale its answer can be.

skill options:                      usage: skill [options] [name]
  -d, --dir <dir>       where to install (default: .claude/skills)
  -f, --force           overwrite files that are already there
  -l, --list            list the skills this package carries and stop

  -h, --help            show this help`;

/** Where a command's output goes. Swappable so tests need no subprocess. */
export interface Console {
    out(line: string): void;
    err(line: string): void;
    /**
     * Ask a person something and return the answer — present only when there
     * is a person to ask. Without it, a decision that needs one is not made.
     */
    ask?: ((question: string) => Promise<string>) | undefined;
    /** Open a URL for a person to sign in at (default: the system browser). */
    open?: ((url: string) => void) | undefined;
}

const CONSOLE: Console = {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    ask: process.stdin.isTTY && process.stderr.isTTY
        ? async (question) => {
            const READLINE = await import('node:readline/promises');
            const rl = READLINE.createInterface({ input: process.stdin, output: process.stderr });
            try {
                return await rl.question(question);
            } finally {
                rl.close();
            }
        }
        : undefined,
};

/** The exit code for an install or update that needs a decision nobody made, or that was declined. */
export const UNDECIDED = 4;

/**
 * The commands, in the order the usage text lists them. Keeping the dispatch
 * table and the help in one place is what stops the two drifting apart.
 */
export const COMMANDS: Record<string, (args: string[], io: Console) => number | Promise<number>> = {
    create, sign, audit, verify: check, attest, run, install, update, installed, uninstall, sea, trust, policy: policyCommand, lexicon, skill,
};

/**
 * Run one CLI invocation. `argv` is the user's arguments — everything after the
 * runtime and the entry point — and the return value is the process exit code,
 * so a caller decides what to do with it rather than being exited out from
 * under.
 */
export async function main(argv: string[], io: Console = CONSOLE): Promise<number> {
    const [cmd, ...rest] = argv;
    try {
        if (cmd === undefined) {
            io.out(USAGE);
            return 64;
        }
        if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
            io.out(USAGE);
            return 0;
        }
        if (cmd === '-v' || cmd === '--version') {
            io.out(version());
            return 0;
        }
        const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
        if (!command) throw new Error(`unknown command: ${cmd}`);
        return await command(rest, io);
    } catch (err) {
        io.err(`error: ${message(err)}`);
        return 70;
    }
}

// The version of whatever is running — read from the package.json beside it,
// which inside the bundled CLI is the archive's own member, so it answers for
// the archive and not for some other copy of this package on the machine.
function version(): string {
    return packageVersion();
}

async function create(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({
        args,
        options: {
            base:   { type: 'string', short: 'b', default: '.' },
            prefix: { type: 'string', short: 'p' },
            files:  { type: 'string', short: 'f' },
            output: { type: 'string', short: 'o' },
            key:    { type: 'string', short: 'k' },
            chain:  { type: 'string', short: 'c' },
            hash:   { type: 'string', default: 'sha256' },
            sign:   { type: 'string', default: 'sha256' },
        },
    });
    if (Boolean(values.key) !== Boolean(values.chain)) throw new Error('create: --key and --chain must be given together');

    const listing = values.files ? FS.readFileSync(values.files, 'utf-8') : await readStdin();
    const files = [...new Set(listing.split(/\r?\n/).filter(Boolean))].sort();
    if (!files.length) throw new Error('create: the file list is empty');

    for (const file of files) io.err(`+ ${file}`);
    io.err(values.key
        ? `* signed archive (${files.length} members, ${values.hash} digests, ${values.sign} signature)`
        : `* unsigned archive (${files.length} members, ${values.hash} digests)`);

    await createBundle({
        base: values.base, files, prefix: values.prefix, output: values.output,
        hashAlg: values.hash, signAlg: values.sign,
        key: values.key ? FS.readFileSync(values.key) : undefined,
        chain: values.chain ? FS.readFileSync(values.chain, 'utf-8') : undefined,
    });
    return 0;
}

async function sign(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            output:     { type: 'string',  short: 'o' },
            launcher:   { type: 'boolean', short: 'l' },
            prefix:     { type: 'string',  short: 'p' },
            executable: { type: 'boolean', short: 'x' },
            key:        { type: 'string',  short: 'k' },
            chain:      { type: 'string',  short: 'c' },
            hash:       { type: 'string',  default: 'sha256' },
            sign:       { type: 'string',  default: 'sha256' },
            flow:       { type: 'string',  default: 'auto' },
            token:      { type: 'string' },
            'oidc-issuer': { type: 'string' },
            connector:  { type: 'string' },
            fulcio:     { type: 'string' },
            rekor:      { type: 'string' },
            tsa:        { type: 'string' },
        },
    });
    const source = positionals[0];
    if (!source) throw new Error('sign: an archive path is required');
    if (Boolean(values.key) !== Boolean(values.chain)) throw new Error('sign: --key and --chain must be given together');
    if (values.launcher && values.prefix) throw new Error('sign: --launcher and --prefix are alternatives');

    // `--launcher` is `--prefix <this package's shell-base>`, spelled so that
    // nobody has to know the prefix ships inside node_modules.
    const prefix = values.launcher ? launcherPath() : values.prefix;

    for (const name of members(source)) io.err(`+ ${name}`);
    if (prefix) io.err(`* prefix ${prefix} (${FS.statSync(prefix).size} bytes)`);

    const signer = await chooseSigner(values, io);

    const res = await signBundle({
        source, output: values.output, prefix, executable: values.executable,
        hashAlg: values.hash, signAlg: values.sign, signer,
    });
    io.err(`* signed: ${res.hash}`);
    if (res.output) io.err(`* wrote ${res.output} (${res.size} bytes)`);
    return 0;
}

async function check(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            archive:  { type: 'string', short: 'a' },
            root:     { type: 'string', short: 'r', multiple: true },
            identity: { type: 'string' },
            issuer:   { type: 'string' },
            'sigstore-root': { type: 'string' },
            json:     { type: 'boolean' },
            ...POLICY_OPTIONS,
        },
    });
    const archive = values.archive ?? positionals[0];
    if (!archive) throw new Error('verify: an archive path is required');

    const { attesters, quorum, maxAge, block } = await policy(values);
    await fetchAttestations(archive, [...attesters, ...block], io);
    const res = await verifyBundle(archive, {
        roots: values.root ?? [],
        identity: values.identity,
        issuer: values.issuer,
        trustedRoot: values['sigstore-root'],
        attesters, quorum, maxAge, block,
    });
    report(res, Boolean(values.json), io);
    return STATES[res.state].code;
}

// Vouch for an archive from an atproto account: a record in that account's own
// repository naming the archive's whole-file hash. Or withdraw it again.
async function attest(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            as:              { type: 'string' },
            kind:            { type: 'string' },
            note:            { type: 'string' },
            verdict:         { type: 'string', default: 'good' },
            'password-file': { type: 'string' },
            revoke:          { type: 'boolean' },
            root:            { type: 'string', short: 'r', multiple: true },
        },
    });
    const archives = [...new Set(positionals)];
    if (!archives.length) throw new Error('attest: at least one archive path is required');
    const identifier = values.as ?? process.env['BUNDLE_ATPROTO_IDENTIFIER'];
    if (!identifier) throw new Error('attest: say which account with --as <handle or did>, or BUNDLE_ATPROTO_IDENTIFIER');
    if (values.kind !== undefined && !/^[A-Za-z0-9._-]+$/.test(values.kind)) throw new Error(`attest: '${values.kind}' is not a valid kind`);
    if (values.verdict !== 'good' && values.verdict !== 'bad') throw new Error(`attest: --verdict is good or bad, not '${values.verdict}'`);
    const verdict: 'good' | 'bad' = values.verdict;

    // Every archive is checked before anyone signs in, and one that does not
    // hold together stops the lot: a release is attested whole or not at all.
    // Vouching for bytes that do not hold together is never what anyone means
    // — and a warning about them is a warning about a file nobody is offered.
    const checked: { archive: string; hashAlg: string; hash: string }[] = [];
    for (const archive of archives) {
        const hashed = wholeFileHash(archive);
        if (!hashed) throw new Error(`attest: ${archive} carries no manifest, so it is not an archive this tool can vouch for`);
        if (!values.revoke) {
            const res = await verifyBundle(archive, { roots: values.root ?? [], deep: true, integrity: true });
            if (res.state === 'invalid') {
                io.err(`error: refusing to attest ${archive}: ${res.reason}`);
                return STATES.invalid.code;
            }
            if (res.hash !== hashed.hash) throw new Error(`attest: ${archive} changed while it was being checked`);
            io.err(`* ${archive}: ${res.signed ? 'signed' : 'unsigned'}, ${res.digests?.size ?? 0} members, all digests match`);
        }
        checked.push({ archive, ...hashed });
    }

    // Never from an argument: a command line is visible to every process on
    // the machine, and ends up in shell history.
    const password = values['password-file']
        ? FS.readFileSync(values['password-file'], 'utf-8').trim()
        : process.env['BUNDLE_ATPROTO_PASSWORD'];
    const ATPROTO = await import('./atproto.ts');
    const OAUTH = await import('./oauth.ts');
    // One sign-in for everything named, and nothing kept afterwards.
    const session = password
        ? await ATPROTO.login(identifier, password)
        : await OAUTH.oauthLogin(identifier, { log: io.err, open: io.open });
    io.err(`* signed in as ${session.did} at ${session.pds}, through ${session.how}`);
    try {
        for (const { archive, hashAlg, hash } of checked) {
            if (values.revoke) {
                await ATPROTO.revoke(session, hash);
                io.out(`withdrew ${session.did}'s attestation of ${archive} (${hashAlg}:${hash})`);
                continue;
            }
            const written = await ATPROTO.attest(session, { hashAlg, hex: hash, kind: values.kind, verdict, note: values.note });
            io.out(`${verdict === 'bad' ? 'marked bad' : 'attested'} ${archive} (${hashAlg}:${hash}) as ${session.did}${values.kind ? ` (${values.kind})` : ''}`);
            io.out(`  ${written.uri}`);
        }
    } finally {
        await session.end?.();
    }
    return 0;
}

/** The flags every command that takes an attestation policy accepts. */
const POLICY_OPTIONS = {
    attester:  { type: 'string', multiple: true },
    quorum:    { type: 'string' },
    'max-age': { type: 'string' },
    block:     { type: 'string', multiple: true },
} as const;

interface PolicyValues {
    attester?: string[] | undefined;
    quorum?: string | undefined;
    'max-age'?: string | undefined;
    block?: string[] | undefined;
}

// Turn the policy flags into a policy: handles into DIDs — which takes the
// network, and is why it happens here rather than in the verifier — the quorum
// into a count, and the age into milliseconds.
async function policy(values: PolicyValues): Promise<{
    attesters: Attester[]; quorum?: number | undefined; maxAge?: number | undefined; block: Attester[];
}> {
    const specs = values.attester ?? [];
    let attesters: Attester[] = [];
    let block: Attester[] = [];
    if (specs.length || values.block?.length) {
        const ATPROTO = await import('./atproto.ts');
        attesters = await Promise.all(specs.map((spec) => ATPROTO.resolveAttester(spec)));
        block = await Promise.all((values.block ?? []).map(async (spec) => ({ did: (await ATPROTO.resolveAttester(spec)).did })));
    }
    let quorum: number | undefined;
    if (values.quorum !== undefined) {
        quorum = Number(values.quorum);
        if (!attesters.length) throw new Error('--quorum needs --attester');
        if (!Number.isInteger(quorum) || quorum < 1 || quorum > attesters.length) {
            throw new Error(`--quorum must be between 1 and the number of attesters (${attesters.length})`);
        }
    }
    const maxAge = values['max-age'] !== undefined ? parseDuration(values['max-age']) : undefined;
    return { attesters, quorum, maxAge, block };
}

// Fetch the attesters' proofs for this one archive, so the verification that
// follows sees the current answer. If that fails, the cache is what there is,
// and the policy's freshness window decides whether it is good enough.
async function fetchAttestations(archive: string, attesters: Attester[], io: Console): Promise<void> {
    if (!attesters.length) return;
    const hashed = wholeFileHash(archive);
    if (!hashed) return;
    const { refreshFor } = await import('./atproto.ts');
    for (const problem of await refreshFor(attesters, hashed.hashAlg, hashed.hash)) {
        io.err(`! could not fetch an attestation, using the cache: ${problem}`);
    }
}

/** Print a verification result, as text or as the JSON `--json` produces. */
export function report(res: VerificationResult, json: boolean, io: Console): void {
    const state = STATES[res.state];
    if (json) {
        io.out(JSON.stringify({
            state: res.state, reason: res.reason, subject: res.subject,
            signed: res.signed, trusted: res.trusted, sigstore: Boolean(res.sigstore),
            identity: res.identity, issuer: res.issuer,
            signedAt: res.signedAt ? res.signedAt.toISOString() : undefined,
            hash: res.hash ? `${res.hashAlg}:${res.hash}` : undefined,
            attestations: res.attestations?.map((each) => ({
                did: each.did, handle: each.handle, required: each.kind, kind: each.attested,
                ok: each.ok, reason: each.reason, uri: each.uri, createdAt: each.createdAt,
                checkedAt: each.checkedAt?.toISOString(),
            })),
            members: res.digests ? [...res.digests.keys()] : undefined,
            code: state.code,
        }, null, 2));
        return;
    }
    io.out(`${state.label} — ${res.reason ?? state.note}`);
    // For a sigstore signature the identity is the answer to "who signed this";
    // the certificate subject is an ephemeral Fulcio artifact and says nothing
    // useful.
    if (res.identity) io.out(`  identity: ${res.identity}`);
    if (res.issuer) io.out(`  issuer: ${res.issuer}`);
    if (res.signedAt) io.out(`  signed: ${res.signedAt.toISOString()}`);
    if (res.subject && !res.identity) io.out(`  certificate: ${res.subject.replace(/\n/g, ', ')}`);
    if (res.attestations) {
        if (res.hash) io.out(`  hash: ${res.hashAlg}:${res.hash}`);
        for (const each of res.attestations) {
            const who = each.handle ? `${each.handle} (${each.did})` : each.did;
            const kind = each.attested ?? each.kind;
            io.out(each.ok
                ? `  attested: ${who}${kind ? ` as ${kind}` : ''}${each.createdAt ? `, ${each.createdAt}` : ''}`
                : `  missing:  ${who}${each.kind ? ` as ${each.kind}` : ''} — ${each.reason}`);
        }
    }
}

const RUN_OPTIONS = {
    root:      { type: 'string',  short: 'r', multiple: true },
    identity:  { type: 'string' },
    issuer:    { type: 'string' },
    untrusted: { type: 'boolean' },
    attester:  { type: 'string', multiple: true },
    quorum:    { type: 'string' },
    'max-age': { type: 'string' },
    block:     { type: 'string', multiple: true },
} as const;

/**
 * Split `run`'s own arguments from the application's.
 *
 * This command is the one that forwards, so it stops as soon as it reaches
 * something that is not its own: options up to the archive belong to `run`, and
 * **everything after the archive belongs to the program**, flags included. That
 * is what makes
 *
 *     bundle run ./app verify ./app
 *
 * mean what it looks like, rather than quietly handing `verify` to a positional
 * that nothing reads. `--` is still accepted, and still ends the discussion —
 * it is only no longer required.
 */
export function splitRunArgs(args: string[]): { mine: string[]; archive?: string | undefined; theirs: string[] } {
    const takesValue = new Set(['--root', '-r', '--identity', '--issuer', '--attester', '--quorum', '--max-age', '--block']);
    const mine: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--') return { mine, archive: args[i + 1], theirs: args.slice(i + 2) };
        // A `--name=value` carries its own value; a bare `--name` eats the next
        // argument, and must, or the archive would be read out of it.
        if (arg.startsWith('-') && arg !== '-') {
            mine.push(arg);
            if (takesValue.has(arg) && !arg.includes('=')) {
                const value = args[++i];
                if (value !== undefined) mine.push(value);
            }
            continue;
        }
        // The first thing that is not an option is the archive, and the program
        // owns everything after it — including a leading `--`, which people
        // write out of habit.
        const rest = args.slice(i + 1);
        return { mine, archive: arg, theirs: rest[0] === '--' ? rest.slice(1) : rest };
    }
    return { mine, theirs: [] };
}

// Check an archive, mount it, and run what is inside — in this process, the way
// a verifying runtime does. Everything after the archive is the application's
// own argv.
async function run(args: string[], io: Console): Promise<number> {
    const { mine, archive, theirs } = splitRunArgs(args);
    const { values } = parseArgs({ args: mine, allowPositionals: false, options: RUN_OPTIONS });
    if (!archive) throw new Error('run: an archive path is required');
    const { attesters, quorum, maxAge, block } = await policy(values);
    await fetchAttestations(archive, [...attesters, ...block], io);

    try {
        return await runBundle(archive, {
            roots: values.root ?? [], identity: values.identity, issuer: values.issuer,
            attesters: attesters.map(formatAttester), quorum, maxAge, block: block.map(({ did }) => did),
            allowUntrusted: values.untrusted, args: theirs,
        });
    } catch (err) {
        if ((err as { code?: string }).code !== 'ERR_BUNDLE_UNTRUSTED') throw err;
        const state = (err as { state?: VerificationState }).state;
        io.err(`error: ${message(err)}`);
        return state ? STATES[state].code : 2;
    }
}

// Fetch a signed archive and put it on the PATH — `curl | sh` with the parts
// that make that dangerous taken out: nothing runs to install it, nothing lands
// anywhere until it verifies, and whoever vouches for it is shown to the person
// installing it, who decides.
async function install(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        allowNegative: true,
        options: {
            ...INSTALL_OPTIONS,
            name:      { type: 'string', short: 'n' },
            dir:       { type: 'string', short: 'd' },
        },
    });
    const INSTALL = await import('./install.ts');
    const demands = await policy(values);

    // With no URL, this package installs itself: the published release, signed
    // by the workflow that publishes it. `npx @pipobscure/bundle install` is
    // then the whole bootstrap — npm fetches it once, and what stays behind is
    // a signed archive that updates itself from its own releases.
    const target = positionals[0] ?? INSTALL.self().url;
    if (!positionals[0]) io.err(`* installing this package itself from ${target}`);

    try {
        const record = await INSTALL.install(target, {
            roots: values.root ?? [], name: values.name, dir: values.dir,
            identity: values.identity, issuer: values.issuer,
            attesters: demands.attesters, quorum: demands.quorum, block: demands.block,
            discover: values.discover,
            onReview: (review, about) => showReview(review, about, io),
            decide: decider(Boolean(values.yes), io),
            log: (line) => io.err(line),
        });
        io.out(`${record.name} installed in ${record.dir}`);
        return 0;
    } catch (err) {
        return refused(err, io);
    }
}

/** What `install` and `update` both take. */
const INSTALL_OPTIONS = {
    root:      { type: 'string', short: 'r', multiple: true },
    identity:  { type: 'string' },
    issuer:    { type: 'string' },
    attester:  { type: 'string', multiple: true },
    quorum:    { type: 'string' },
    block:     { type: 'string', multiple: true },
    discover:  { type: 'boolean', default: true },
    yes:       { type: 'boolean', short: 'y' },
} as const;

// The exit code for an install that did not happen, and the line that says why.
function refused(err: unknown, io: Console): number {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_BUNDLE_UNCONFIRMED') {
        io.err(`error: ${message(err)}`);
        io.err('  nobody accepted for it before vouches for it, so it is up to you: run this on a terminal to choose, or pass --yes to accept what is shown above');
        return UNDECIDED;
    }
    if (code === 'ERR_BUNDLE_DECLINED') {
        io.err(message(err));
        return UNDECIDED;
    }
    if (code !== 'ERR_BUNDLE_UNTRUSTED') throw err;
    const state = (err as { state?: VerificationState }).state;
    io.err(`error: ${message(err)}`);
    return state ? STATES[state].code : 2;
}

/** Show everything a review found, numbered where it can be chosen. */
export function showReview(review: REVIEW.Review, about: { name: string; url: string }, io: Console): void {
    io.err(`* ${about.name}: ${review.hashAlg}:${review.hash} (${review.signed ? 'signed' : 'unsigned'})`);
    let n = 0;
    for (const item of review.items) {
        const label = item.evidence.type === 'signature' ? 'signed by'
            : item.evidence.type === 'certificate' ? 'certificate'
            : item.evidence.verdict === 'bad' ? 'WARNING' : 'attested by';
        const when = item.evidence.type === 'attestation' && item.evidence.createdAt ? `, ${item.evidence.createdAt}` : '';
        const what = `${label.padEnd(11)} ${REVIEW.describe(item.evidence)}${when}`;
        if (item.excluded) {
            const why = item.evidence.type === 'attestation' && item.evidence.verdict === 'bad' ? 'marked it bad' : item.excluded;
            io.err(`     ${what} — ${why}`);
        } else {
            io.err(`  ${String(++n).padStart(2)} ${what} — ${item.known ?? 'new'}`);
        }
    }
    if (!review.items.length) io.err('     nothing vouches for it');
    for (const note of review.notes) io.err(`  ! ${note}`);
}

// How an install that needs a decision gets one: everything, with --yes; the
// person at the terminal, if there is one; otherwise nobody, and it stops.
function decider(yes: boolean, io: Console) {
    if (yes) return async (review: REVIEW.Review) => REVIEW.selectable(review);
    const ask = io.ask;
    if (!ask) return undefined;
    return async (review: REVIEW.Review, about: { name: string }) => {
        const choices = REVIEW.selectable(review);
        io.err(`* ${about.name}: ${review.reason}`);
        for (;;) {
            const answer = (await ask(`  accept which? numbers (${choices.length > 1 ? '1,2' : '1'}), 'all', or Enter to decline: `)).trim().toLowerCase();
            if (!answer || answer === 'n' || answer === 'no' || answer === 'none') return [];
            if (answer === 'all' || answer === 'a' || answer === 'y' || answer === 'yes') return choices;
            const picked = answer.split(/[\s,]+/).map(Number);
            if (picked.every((index) => Number.isInteger(index) && index >= 1 && index <= choices.length)) {
                return [...new Set(picked)].map((index) => choices[index - 1]!);
            }
            io.err(`  '${answer}' is not one of 1–${choices.length}`);
        }
    };
}

// Re-ask the URL an install came from, and replace what is there if the answer
// changed and is accepted — by what was accepted before, or by the person.
async function update(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        allowNegative: true,
        options: INSTALL_OPTIONS,
    });

    const INSTALL = await import('./install.ts');
    const demands = await policy(values);
    const results = await INSTALL.update(positionals[0], {
        roots: values.root ?? [], identity: values.identity, issuer: values.issuer,
        attesters: demands.attesters.length ? demands.attesters : undefined,
        quorum: demands.quorum, block: demands.block,
        discover: values.discover,
        onReview: (review, about) => showReview(review, about, io),
        decide: decider(Boolean(values.yes), io),
        log: (line) => io.err(line),
    });

    const changed = results.filter((result) => result.state === 'updated');
    const stuck = results.filter((result) => result.state !== 'updated' && result.state !== 'unchanged');
    io.out(changed.length
        ? `${changed.length} of ${results.length} updated: ${changed.map((result) => result.record.name).join(', ')}`
        : `${results.length} checked, nothing changed`);
    for (const result of stuck) io.out(`  ${result.record.name}: ${result.state} — ${result.reason ?? ''}`);
    if (stuck.some((result) => result.state === 'unconfirmed')) {
        io.err('  run on a terminal to decide, or pass --yes to accept what was shown');
    }

    // The worst outcome decides the exit code.
    return stuck.reduce((code, result) => Math.max(code,
        result.state === 'refused' ? STATES[result.review?.state ?? 'invalid'].code
        : result.state === 'failed' ? 70
        : UNDECIDED), 0);
}

// What is installed, and whether it is still what was installed. The record
// says what the bytes were; this is where that claim gets checked rather than
// merely printed.
async function installed(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({
        args,
        options: { root: { type: 'string', short: 'r', multiple: true }, json: { type: 'boolean' } },
    });

    const INSTALL = await import('./install.ts');
    // Withdrawn attestations and new warnings only show up if they are asked
    // about; asking is cheap, and a failure leaves the cache to answer.
    for (const problem of await INSTALL.refreshInstalled()) io.err(`! could not fetch an attestation, using the cache: ${problem}`);
    const checks = INSTALL.installed({ roots: values.root ?? [] });

    if (values.json) {
        io.out(JSON.stringify(checks.map(({ record, path, state, sha256, reason, review }) => ({
            name: record.name, path, state, sha256, reason,
            url: record.url, identity: record.identity, issuer: record.issuer,
            attestedBy: record.attestedBy, accepted: INSTALL.acceptedOf(record),
            warnings: review ? INSTALL.warningsOf(review) : [], at: record.at,
        })), null, 2));
    } else if (!checks.length) {
        io.out('nothing installed');
    } else {
        for (const { record, path, state, reason, review } of checks) {
            io.out(`${record.name}  ${state === 'ok' ? 'OK' : state.toUpperCase()}`);
            io.out(`  at:     ${path}`);
            io.out(`  from:   ${record.url}`);
            if (record.identity) io.out(`  signer: ${record.identity}${record.issuer ? ` via ${record.issuer}` : ''}`);
            else if (record.subject) io.out(`  signer: ${record.subject.replace(/\n/g, ', ')}`);
            if (record.attestedBy?.length) io.out(`  attested by: ${record.attestedBy.join(', ')}`);
            io.out(`  sha256: ${record.sha256}`);
            io.out(`  since:  ${record.at}`);
            if (state !== 'ok') io.out(`  ${reason}`);
            for (const warning of review ? INSTALL.warningsOf(review) : []) io.out(`  ${warning}`);
        }
    }

    // The worst thing found decides the exit code, so a script can gate on it:
    // anything but `ok` is something a person should look at.
    const worst = checks.reduce((code, { state }) => Math.max(code, state === 'ok' ? 0
        : state === 'missing' || state === 'changed' ? 2
        : STATES[state].code), 0);
    return worst;
}

// The lexicons attestations are written in: which there are, where each should
// be published, whether it is, and publishing them.
async function lexicon(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            as:              { type: 'string' },
            'dry-run':       { type: 'boolean' },
            force:           { type: 'boolean' },
            'password-file': { type: 'string' },
        },
    });
    const LEXICON = await import('./lexicon.ts');
    const docs = LEXICON.lexicons();
    const [sub] = positionals;

    if (sub === undefined) {
        for (const doc of docs) {
            io.out(doc.id);
            io.out(`  dns:    TXT _lexicon.${LEXICON.authorityOf(doc.id)}  "did=<the publishing account's DID>"`);
            io.out(`  record: at://<that DID>/${LEXICON.SCHEMA_COLLECTION}/${doc.id}`);
        }
        return 0;
    }

    if (sub === 'check') {
        let worst = 0;
        for (const status of await LEXICON.checkLexicons()) {
            const what = status.state === 'current' ? 'published, and current'
                : status.state === 'different' ? 'published, but not this version'
                : status.state === 'unpublished' ? `not published by ${status.authority}`
                : `no authority — ${status.dns} has no 'did=' TXT record`;
            io.out(`${status.nsid}: ${what}`);
            if (status.uri) io.out(`  ${status.uri}`);
            if (status.state !== 'current') worst = 1;
        }
        return worst;
    }

    if (sub !== 'publish') throw new Error(`lexicon: unknown subcommand '${sub}' (check or publish)`);
    const identifier = values.as ?? process.env['BUNDLE_ATPROTO_IDENTIFIER'];
    if (!identifier) throw new Error('lexicon: say which account with --as <handle or did>, or BUNDLE_ATPROTO_IDENTIFIER');

    if (values['dry-run']) {
        const ATPROTO = await import('./atproto.ts');
        const { did } = await ATPROTO.resolveAttester(identifier);
        for (const doc of docs) {
            const authority = await LEXICON.authorityDid(doc.id);
            const dns = `_lexicon.${LEXICON.authorityOf(doc.id)}`;
            io.out(`${doc.id}`);
            io.out(`  would write at://${did}/${LEXICON.SCHEMA_COLLECTION}/${doc.id}`);
            io.out(authority === did ? `  ${dns} names ${did}: good`
                : authority ? `  ${dns} names ${authority}, not ${did}: publish would refuse`
                : `  ${dns} has no 'did=' record: add TXT "did=${did}" first`);
        }
        return 0;
    }

    const password = values['password-file']
        ? FS.readFileSync(values['password-file'], 'utf-8').trim()
        : process.env['BUNDLE_ATPROTO_PASSWORD'];
    const ATPROTO = await import('./atproto.ts');
    const OAUTH = await import('./oauth.ts');
    const session = password
        ? await ATPROTO.login(identifier, password)
        : await OAUTH.oauthLogin(identifier, { log: io.err, open: io.open, scope: `atproto repo:${LEXICON.SCHEMA_COLLECTION}` });
    io.err(`* signed in as ${session.did} at ${session.pds}, through ${session.how}`);
    try {
        for (const each of await LEXICON.publishLexicons(session, { force: values.force })) {
            io.out(`published ${each.nsid}`);
            io.out(`  ${each.uri}`);
            if (each.authority !== session.did) io.err(`  ! ${each.dns} does not name ${session.did} yet, so nothing can resolve it until it does`);
        }
    } finally {
        await session.end?.();
    }
    return 0;
}

// The rules this machine installs by: what is in force, the files themselves,
// a file to start from, and a check of one.
async function policyCommand(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            app:    { type: 'string', short: 'a' },
            json:   { type: 'boolean' },
            system: { type: 'boolean' },
            user:   { type: 'boolean' },
            force:  { type: 'boolean', short: 'f' },
        },
    });
    const POLICY = await import('./policy.ts');
    const [sub, file] = positionals;
    const which = values.system ? POLICY.systemPolicyPath() : POLICY.userPolicyPath();

    if (sub === 'init') {
        if (FS.existsSync(which) && !values.force) throw new Error(`policy: ${which} is already there (--force to replace it)`);
        FS.mkdirSync(PATH.dirname(which), { recursive: true });
        FS.writeFileSync(which, POLICY.formatPolicyFile(POLICY.starterPolicy(), version()));
        io.out(`wrote ${which}`);
        io.err(`  its "$schema" is ${POLICY.schemaUrl(version())}`);
        return 0;
    }
    if (sub === 'check') {
        if (!file) throw new Error('policy: check needs a file');
        // `readPolicyFile` is what installs read policies with; null is a file
        // that is not there, which is worth saying differently from a bad one.
        if (!POLICY.readPolicyFile(PATH.resolve(file))) throw new Error(`policy: ${file} does not exist`);
        io.out(`${file}: a valid policy file`);
        return 0;
    }
    if (sub === 'show') {
        const paths = [
            ...(values.system || !values.user ? [POLICY.systemPolicyPath()] : []),
            ...(values.user || !values.system ? [POLICY.userPolicyPath()] : []),
        ];
        let shown = 0;
        for (const path of paths) {
            const read = POLICY.readPolicyFile(path);
            if (!read) {
                io.err(`* ${path}: none`);
                continue;
            }
            io.err(`* ${path}`);
            io.out(POLICY.formatPolicyFile(read, version()).trimEnd());
            shown++;
        }
        if (!shown) io.err("  no policy files — 'bundle policy init' writes one");
        return 0;
    }
    if (sub !== undefined) throw new Error(`policy: unknown subcommand '${sub}' (show, init or check)`);

    const effective = POLICY.loadPolicy(values.app);
    if (values.json) {
        io.out(JSON.stringify({
            ...effective,
            systemFile: POLICY.systemPolicyPath(), userFile: POLICY.userPolicyPath(),
        }, null, 2));
        return 0;
    }
    io.out(`machine policy: ${POLICY.systemPolicyPath()}${effective.files.includes(POLICY.systemPolicyPath()) ? '' : ' (none)'}`);
    io.out(`user policy:    ${POLICY.userPolicyPath()}${effective.files.includes(POLICY.userPolicyPath()) ? '' : ' (none)'}`);
    io.out(`schema:         ${POLICY.schemaUrl(version())}`);
    const list = (items: string[]) => (items.length ? items.join(', ') : 'none');
    io.out(`required:`);
    io.out(`  signature:   ${effective.signature.length ? `yes (${list(effective.signature)})` : 'no'}`);
    io.out(`  same issuer: ${effective.sameIssuer.length ? `yes (${list(effective.sameIssuer)})` : 'no'}`);
    for (const { attesters, quorum, source } of effective.attesters) {
        io.out(`  attesters:   ${quorum ? `${quorum} of ` : ''}${attesters.map(formatAttester).join(', ')} (${source})`);
    }
    for (const { list: issuers, source } of effective.issuers) io.out(`issuers:       ${issuers.join(', ')} (${source})`);
    io.out(`trusted signers:   ${list(effective.trust.signers.map((signer) => `${signer.identity} via ${signer.issuer}`))}`);
    io.out(`trusted attesters: ${list(effective.trust.attesters.map(formatAttester))}`);
    if (effective.trust.certificates.length) io.out(`trusted roots:     ${list(effective.trust.certificates)}`);
    io.out(`blocks on:         ${list(effective.block.map(({ did }) => did))}`);
    io.out(`ignores:           ${list(effective.ignore)}`);
    io.out(`discovery:         ${effective.discovery || 'off'}`);
    if (effective.maxAge !== undefined) io.out(`max age:           ${Math.round(effective.maxAge / 1000)}s`);
    return 0;
}

// Remove an install: the file, and the record of where it came from. With no
// argument it is this package's own, which is what somebody who typed
// `bundle uninstall` means.
async function uninstall(args: string[], io: Console): Promise<number> {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    const INSTALL = await import('./install.ts');
    const record = INSTALL.uninstall(positionals[0]);
    io.out(`removed ${record.name} from ${record.dir}`);
    io.err(`  it came from ${record.url}`);
    return 0;
}

// The audit gate. The review itself needs judgement, so this command does the
// two mechanical halves around it: say what is about to be reviewed, and refuse
// to let signing proceed without a clean verdict over exactly these bytes.
function audit(args: string[], io: Console): number {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            baseline: { type: 'string',  short: 'b' },
            verdict:  { type: 'string',  short: 'v' },
            note:     { type: 'string',  short: 'n' },
            check:    { type: 'boolean' },
            approve:  { type: 'boolean' },
        },
    });
    const bundle = positionals[0];
    if (!bundle) throw new Error('audit: an archive path is required');
    if (values.check && values.approve) throw new Error('audit: --check and --approve are alternatives');
    const options = { bundle, verdict: values.verdict, baseline: values.baseline };

    if (values.check) {
        const verdict = AUDIT.check(options);
        const notes = (verdict.findings ?? []).length;
        io.err(`* audited: ${verdict.summary ?? 'pass'}`);
        io.err(`  ${verdict.reviewed ?? '?'} of ${verdict.members ?? '?'} members reviewed, ` +
            `${notes} finding${notes === 1 ? '' : 's'}`);
        if (verdict.baselineSha256) io.err(`  as a diff against ${verdict.baselineSha256.slice(0, 16)}…`);
        return 0;
    }

    if (values.approve) {
        const verdict = AUDIT.approve({ ...options, note: values.note });
        io.err(`* recorded a pass over ${verdict.sha256!.slice(0, 16)}… in ${AUDIT.verdictPath(bundle, values.verdict)}`);
        return 0;
    }

    const found = AUDIT.prepare(options);
    io.out(`${found.bundle}: ${STATES[found.state as VerificationState]?.label ?? found.state}, ${found.members.length} members`);
    io.out(`  sha256: ${found.sha256}`);
    if (found.state === 'unsigned') {
        io.out('  unsigned, as an archive that has not been signed yet should be');
    }
    if (found.baseline) {
        io.out(`  against ${found.baseline.path} (${found.baseline.sha256.slice(0, 16)}…)`);
        io.out(`  ${found.baseline.added.length} added, ${found.baseline.removed.length} removed, ` +
            `${found.baseline.carried} carried over`);
        for (const name of found.baseline.added.slice(0, 10)) io.out(`    + ${name}`);
        for (const name of found.baseline.removed.slice(0, 10)) io.out(`    - ${name}`);
    } else {
        io.out('  no baseline — the review is of everything, not a diff');
    }

    io.err('');
    io.err('* review it, then record the verdict:');
    io.err(`    BUNDLE_AUDIT_VERDICT=${found.verdict} \\`);
    io.err(found.baseline
        ? `      claude "/audit-bundle ${bundle} against ${found.baseline.path}"`
        : `      claude "/audit-bundle ${bundle}"`);
    io.err('  or, having read it yourself:');
    io.err(`    bundle audit --approve --note '<what you checked>' ${bundle}`);
    io.err("* then gate signing on it: bundle audit --check ... && bundle sign ...");
    return 0;
}

// Wrap an archive in a node runtime that verifies itself before running it.
// The signing half is the same as `sign` — the finished executable is one
// signed file whose hash covers the runtime, the verifier and the application
// alike, which is what lets it check itself with something inside itself.
async function sea(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        // `--no-sigstore` is spelled as the negation of `sigstore`.
        allowNegative: true,
        options: {
            output:    { type: 'string',  short: 'o' },
            node:      { type: 'string' },
            base:      { type: 'string' },
            sigstore:  { type: 'boolean', default: true },
            untrusted: { type: 'boolean' },
            root:      { type: 'string',  short: 'r', multiple: true },
            identity:  { type: 'string' },
            issuer:    { type: 'string' },
            key:       { type: 'string',  short: 'k' },
            chain:     { type: 'string',  short: 'c' },
            hash:      { type: 'string',  default: 'sha256' },
            sign:      { type: 'string',  default: 'sha256' },
            flow:      { type: 'string',  default: 'auto' },
            token:     { type: 'string' },
            'oidc-issuer': { type: 'string' },
            connector: { type: 'string' },
            fulcio:    { type: 'string' },
            rekor:     { type: 'string' },
            tsa:       { type: 'string' },
            ...POLICY_OPTIONS,
        },
    });
    const app = positionals[0];
    if (!values.output) throw new Error('sea: --output is required');
    if (Boolean(values.key) !== Boolean(values.chain)) throw new Error('sea: --key and --chain must be given together');

    const SEA = await import('./sea.ts');
    // A policy baked into a runtime is the last word: it would be no policy at
    // all if the command line could drop it. Nothing baked, nothing to seal —
    // that runtime takes its policy from flags and the environment, the way
    // `bundle run` does.
    const { attesters, quorum, maxAge, block } = await policy(values);
    const bootstrap = {
        roots: values.root,
        identity: values.identity,
        issuer: values.issuer,
        attesters: attesters.length ? attesters.map(formatAttester) : undefined,
        quorum,
        maxAge,
        block: block.length ? block.map(({ did }) => did) : undefined,
        allowUntrusted: values.untrusted,
        sealed: Boolean(values.root?.length || values.identity || values.issuer || attesters.length),
    };

    if (!app) {
        if (values.key || values.chain) {
            throw new Error('sea: signing options need an archive to sign — a verifying node carries none');
        }
        if (values.base) throw new Error('sea: --base reuses a runtime; without an archive there is nothing to add to it');
        io.err('* building a verifying node (node runtime + verifier, no application)');
        const built = await SEA.createSeaBase({
            output: values.output,
            node: values.node,
            sigstore: values.sigstore,
            bootstrap,
        });
        io.err(`* wrote ${built.output} (${built.size} bytes, ${built.verifier.length} verifier members)`);
        io.err(`* run an archive with it: ${built.output} <archive> [args...]`);
        return 0;
    }

    const signer = await chooseSigner(values, io);
    const res = await SEA.buildSea({
        app,
        output: values.output,
        node: values.node,
        base: values.base,
        sigstore: values.sigstore,
        signer,
        hashAlg: values.hash,
        signAlg: values.sign,
        bootstrap,
        log: io.err,
    });
    if (res.output) io.err(`* wrote ${res.output} (${res.size} bytes)`);
    return 0;
}

// Refresh the trust material. Verification is deliberately offline — it will
// not reach for the network to decide whether to mount something — so what it
// checks against has to be fetched by an explicit step like this one: the
// sigstore trust root, over TUF, which is signed metadata with its own root of
// trust rather than a plain download; and the attestations of every attester
// this machine knows about, each proof verified before it is kept.
async function trust(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({
        args,
        allowNegative: true,
        options: {
            mirror:   { type: 'string' },
            attester: { type: 'string', multiple: true },
            sigstore: { type: 'boolean', default: true },
        },
    });
    let failed = false;

    if (values.sigstore) {
        const SIGSTORE = await import('./sigstore.ts');
        const path = await SIGSTORE.refreshTrustedRoot(values.mirror ? { mirror: values.mirror } : {});
        io.out(`sigstore trust root refreshed: ${path}`);
    }

    // Everyone whose attestations something on this machine may ask about:
    // named here, named in the environment the preload reads, pinned by an
    // install, or already cached because a verification once needed them.
    const ATPROTO = await import('./atproto.ts');
    const INSTALL = await import('./install.ts');
    const dids = new Set<string>();
    for (const spec of values.attester ?? []) dids.add((await ATPROTO.resolveAttester(spec)).did);
    const POLICY = await import('./policy.ts');
    const environment = policyFromEnvironment();
    for (const { did } of [...environment.attesters, ...(environment.block ?? [])]) dids.add(did);
    const policies = [POLICY.loadPolicy(), ...Object.keys(INSTALL.records()).map((name) => POLICY.loadPolicy(name))];
    for (const each of policies) {
        for (const { attesters } of each.attesters) for (const { did } of attesters) dids.add(did);
        for (const { did } of [...each.trust.attesters, ...each.block]) dids.add(did);
    }
    for (const record of Object.values(INSTALL.records())) for (const did of INSTALL.acceptedOf(record).attesters) dids.add(did);
    for (const did of cachedDids()) dids.add(did);
    for (const each of policies) for (const did of each.ignore) dids.delete(did);

    for (const did of [...dids].sort()) {
        try {
            const { present, fetched, removed } = await ATPROTO.refreshAttester(did);
            io.out(`${did}: ${present} attestation${present === 1 ? '' : 's'}` +
                `${fetched ? `, ${fetched} new` : ''}${removed ? `, ${removed} withdrawn` : ''}`);
        } catch (err) {
            io.err(`error: ${did}: ${message(err)}`);
            failed = true;
        }
    }
    return failed ? 1 : 0;
}

// Install the auditing skill into a project, so whoever is about to run an
// archive has the review procedure to hand rather than having to find it here.
function skill(args: string[], io: Console): number {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            dir:   { type: 'string',  short: 'd' },
            force: { type: 'boolean', short: 'f' },
            list:  { type: 'boolean', short: 'l' },
        },
    });

    const available = SKILLS.skills();
    if (values.list) {
        if (!available.length) io.out('this package carries no skills');
        for (const entry of available) io.out(`${entry.name}\n  ${entry.description}`);
        return 0;
    }

    const names = positionals.length ? positionals : available.map((entry) => entry.name);
    if (!names.length) throw new Error('skill: this package carries no skills to install');

    for (const name of names) {
        const res = SKILLS.install(name, { dir: values.dir, force: values.force });
        for (const file of res.written) io.err(`+ ${PATH.relative(process.cwd(), file)}`);
        for (const file of res.skipped) io.err(`= ${PATH.relative(process.cwd(), file)} (already there; --force to overwrite)`);
        io.out(`installed skill '${res.name}' into ${PATH.relative(process.cwd(), res.path) || res.path}`);
    }
    return 0;
}

/** What `sign` and `sea` both accept to decide how the signature is made. */
interface SignerChoice {
    key?: string | undefined;
    chain?: string | undefined;
    sign?: string | undefined;
    flow?: string | undefined;
    token?: string | undefined;
    'oidc-issuer'?: string | undefined;
    connector?: string | undefined;
    fulcio?: string | undefined;
    rekor?: string | undefined;
    tsa?: string | undefined;
}

// Two signers, one interface. Either way the certificate has to be in hand
// before the archive is built, because AUTHORITY.PEM carries it and
// AUTHORITY.PEM is inside the region the hash covers — so this runs first and
// the signature itself is made later, over the finished bytes.
async function chooseSigner(values: SignerChoice, io: Console) {
    if (values.key && values.chain) {
        io.err('* signing against the supplied certificate chain');
        return fileSigner({ key: values.key, chain: values.chain, signAlg: values.sign });
    }
    const SIGSTORE = await import('./sigstore.ts');
    io.err('* signing through sigstore');
    return await SIGSTORE.signer({
        signAlg: values.sign,
        flow: values.flow as 'auto' | 'ci' | 'browser' | 'device' | undefined,
        token: values.token,
        issuer: values['oidc-issuer'],
        connector: values.connector,
        fulcioURL: values.fulcio,
        rekorURL: values.rekor,
        tsaURL: values.tsa,
        log: io.err,
    });
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk: string) => { data += chunk; })
            .on('end', () => resolve(data))
            .on('error', reject);
    });
}
