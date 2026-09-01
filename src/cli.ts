import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { parseArgs } from 'node:util';
import { createBundle, signBundle, verifyBundle, runBundle, fileSigner } from './api.ts';
import { members } from './archive.ts';
import { message, type VerificationResult, type VerificationState } from './manifest.ts';
import * as SKILLS from './skill.ts';

// Argument parsing and reporting, and nothing else. Every command below is a
// `parseArgs` call, a message or two, and one call into `api.ts` — which is
// deliberate: what the CLI can do is exactly what an embedder can do, because
// they are the same functions.

export const USAGE = `usage: bundle <command> [options]

commands:
  create    build an archive from a list of files
  sign      sign an archive into a new file, optionally behind a prefix
  verify    verify an archive and report its trust state
  run       mount a signed archive and run it
  sea       wrap an archive in a node runtime that verifies itself and runs it
  trust     refresh the sigstore trust root used to check sigstore signatures
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
  -p, --prefix <file>   prefix prepended before the archive: a '#!' launcher or a
                        node binary; omit for a plain mountable archive
  -x, --executable      make the output executable (implied by --prefix)
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

verify options:                     usage: verify [options] <archive>
  -a, --archive <file>  archive to verify (or pass it as a positional argument)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --sigstore-root <file>  sigstore trust root (default: the cache 'trust' fills)
      --json            print the result as JSON

run options:                        usage: run [options] <archive> [-- <app args>]
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --untrusted       run an archive whose signature is good but untrusted

sea options:                        usage: sea [options] <archive>
  -o, --output <file>   write the executable here (required)
      --node <file>     node binary to embed (default: the running one)
      --base <file>     reuse a SEA base built earlier instead of building one
      --no-sigstore     leave the sigstore libraries out of the embedded verifier
      --untrusted       let the finished executable run when its own signature
                        is good but unanchored
  -r, --root <file>     trusted root the executable checks itself against; repeatable
      --identity <san>  identity the executable requires of its own signature
      --issuer <url>    issuer the executable requires of its own signature

  the signing options are the same as 'sign': sigstore by default, or --key
  with --chain against a certificate authority of your own

trust options:
      --mirror <url>    TUF repository to refresh from (default: sigstore's)

skill options:                      usage: skill [options] [name]
  -d, --dir <dir>       where to install (default: .claude/skills)
  -f, --force           overwrite files that are already there
  -l, --list            list the skills this package carries and stop

  -h, --help            show this help`;

/** How each verification state is reported, and what it exits with. */
export const STATES: Record<VerificationState, { code: number; label: string; note: string }> = {
    'unsigned':        { code: 3, label: 'UNSIGNED',          note: 'archive carries no signature' },
    'invalid':         { code: 2, label: 'INVALID',           note: 'manifest is wrong or does not cover the whole archive' },
    'valid-untrusted': { code: 1, label: 'VALID (UNTRUSTED)', note: 'signature is good but the certificate is not trusted' },
    'valid':           { code: 0, label: 'VALID',             note: 'signature is good and the certificate is trusted' },
};

/** Where a command's output goes. Swappable so tests need no subprocess. */
export interface Console {
    out(line: string): void;
    err(line: string): void;
}

const CONSOLE: Console = {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
};

/**
 * The commands, in the order the usage text lists them. Keeping the dispatch
 * table and the help in one place is what stops the two drifting apart.
 */
export const COMMANDS: Record<string, (args: string[], io: Console) => number | Promise<number>> = {
    create, sign, verify: check, run, sea, trust, skill,
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
        const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
        if (!command) throw new Error(`unknown command: ${cmd}`);
        return await command(rest, io);
    } catch (err) {
        io.err(`error: ${message(err)}`);
        return 70;
    }
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

    for (const name of members(source)) io.err(`+ ${name}`);
    if (values.prefix) io.err(`* prefix ${values.prefix} (${FS.statSync(values.prefix).size} bytes)`);

    const signer = await chooseSigner(values, io);

    const res = await signBundle({
        source, output: values.output, prefix: values.prefix, executable: values.executable,
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
        },
    });
    const archive = values.archive ?? positionals[0];
    if (!archive) throw new Error('verify: an archive path is required');

    const res = await verifyBundle(archive, {
        roots: values.root ?? [],
        identity: values.identity,
        issuer: values.issuer,
        trustedRoot: values['sigstore-root'],
    });
    report(res, Boolean(values.json), io);
    return STATES[res.state].code;
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
}

// Run an archive the way a mount does. Everything after `--` is the
// application's own argv.
function run(args: string[], io: Console): number {
    const split = args.indexOf('--');
    const mine = split < 0 ? args : args.slice(0, split);
    const theirs = split < 0 ? [] : args.slice(split + 1);
    const { values, positionals } = parseArgs({
        args: mine,
        allowPositionals: true,
        options: {
            root:      { type: 'string', short: 'r', multiple: true },
            identity:  { type: 'string' },
            issuer:    { type: 'string' },
            untrusted: { type: 'boolean' },
        },
    });
    const archive = positionals[0];
    if (!archive) throw new Error('run: an archive path is required');

    let res;
    try {
        res = runBundle(archive, {
            roots: values.root ?? [], identity: values.identity, issuer: values.issuer,
            allowUntrusted: values.untrusted, args: theirs,
        });
    } catch (err) {
        if ((err as { code?: string }).code !== 'ERR_BUNDLE_UNTRUSTED') throw err;
        const state = (err as { state?: VerificationState }).state;
        io.err(`error: ${message(err)}`);
        return state ? STATES[state].code : 2;
    }
    if (res.signal) process.kill(process.pid, res.signal);
    return res.status ?? 70;
}

// Wrap an archive in a node runtime that verifies itself before running it.
// The signing half is the same as `sign` — the finished executable is one
// signed file whose hash covers the runtime, the verifier and the application
// alike, which is what lets it check itself with something inside itself.
async function sea(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
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
        },
    });
    const app = positionals[0];
    if (!app) throw new Error('sea: an archive path is required');
    if (!values.output) throw new Error('sea: --output is required');
    if (Boolean(values.key) !== Boolean(values.chain)) throw new Error('sea: --key and --chain must be given together');

    const SEA = await import('./sea.ts');
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
        bootstrap: {
            roots: values.root,
            identity: values.identity,
            issuer: values.issuer,
            allowUntrusted: values.untrusted,
        },
        log: io.err,
    });
    if (res.output) io.err(`* wrote ${res.output} (${res.size} bytes)`);
    return 0;
}

// Refresh the sigstore trust root. Verification is deliberately offline — it
// will not reach for the network to decide whether to mount something — so the
// trust material has to be fetched by an explicit step like this one. It comes
// over TUF, which is signed metadata with its own root of trust rather than a
// plain download.
async function trust(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({ args, options: { mirror: { type: 'string' } } });
    const SIGSTORE = await import('./sigstore.ts');
    const path = await SIGSTORE.refreshTrustedRoot(values.mirror ? { mirror: values.mirror } : {});
    io.out(`sigstore trust root refreshed: ${path}`);
    return 0;
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
