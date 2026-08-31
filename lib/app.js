#!/usr/bin/env -S node --no-warnings
import * as SEA from 'node:sea';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, parseManifest, parseSignature, formatSignature, signatureOf, verify, verifySync } from './manifest.js';
import { createArchive, bundle, rebundle, keySigner, members } from './archive.js';

// The package root doubles as the library the loader (and any embedder)
// consumes: manifest building/parsing, verification, and archive creation. The
// VFS provider lives in './provider.js' and is deliberately not re-exported
// here — importing it needs `node:vfs`, which only exists under
// `--experimental-vfs`, and creating or verifying an archive does not.
export {
    buildManifest, parseManifest, parseSignature, formatSignature, signatureOf,
    verify, verifySync, createArchive, bundle, rebundle, keySigner, members,
};

const USAGE = `usage: bundle <command> [options]

commands:
  create    build an archive from a list of files
  sign      sign an archive into a new file, optionally behind a prefix
  verify    verify an archive and report its trust state
  run       mount a signed archive and run it
  trust     refresh the sigstore trust root used to check sigstore signatures

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

trust options:
      --mirror <url>    TUF repository to refresh from (default: sigstore's)

  -h, --help            show this help`;

const STATES = {
    'unsigned':        { code: 3, label: 'UNSIGNED',          note: 'archive carries no signature' },
    'invalid':         { code: 2, label: 'INVALID',           note: 'manifest is wrong or does not cover the whole archive' },
    'valid-untrusted': { code: 1, label: 'VALID (UNTRUSTED)', note: 'signature is good but the certificate is not trusted' },
    'valid':           { code: 0, label: 'VALID',             note: 'signature is good and the certificate is trusted' },
};

// The preload that registers the signed-archive provider with `node:vfs`, as a
// real path `node -r` can resolve.
const REGISTER = fileURLToPath(new URL('./register.cjs', import.meta.url));

// Mounting an archive and running its entry point out of it: `--vfs-mount`
// makes it the filesystem, `--vfs-load` makes it the program.
const MOUNT = (target) => ['--vfs-load', '--vfs-mount', target];

async function create(args) {
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
    const key = values.key ? FS.readFileSync(values.key) : undefined;
    const chain = values.chain ? FS.readFileSync(values.chain, 'utf-8') : undefined;

    for (const file of files) console.error(`+ ${file}`);
    console.error(key && chain
        ? `* signed archive (${files.length} members, ${values.hash} digests, ${values.sign} signature)`
        : `* unsigned archive (${files.length} members, ${values.hash} digests)`);

    const out = values.output ? FS.createWriteStream(values.output) : process.stdout;
    await bundle({ base: values.base, files, prefix: values.prefix, hashAlg: values.hash, signAlg: values.sign, key, chain, out });
    await end(out);
    if (values.output && values.prefix) FS.chmodSync(values.output, 0o755);
}

// Sign an existing archive into a new file. The input is never modified: its
// members are read out, laid down again behind whatever prefix was asked for,
// and the finished bytes are hashed and signed as a whole. One unsigned archive
// therefore yields every shape — a '#!' launcher, a self-contained binary, or a
// plain mountable archive — each correctly offset and each signed over itself.
async function sign(args) {
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
    if (values.output && PATH.resolve(values.output) === PATH.resolve(source)) {
        throw new Error('sign: --output must differ from the input archive');
    }

    for (const name of members(source)) console.error(`+ ${name}`);
    if (values.prefix) console.error(`* prefix ${values.prefix} (${FS.statSync(values.prefix).size} bytes)`);

    // Two signers, one interface. The certificate has to be in hand before the
    // archive is built, because AUTHORITY.PEM carries it and AUTHORITY.PEM is
    // inside the region the hash covers.
    let signer;
    if (values.key) {
        console.error('* signing against the supplied certificate chain');
        signer = keySigner({
            key: FS.readFileSync(values.key),
            chain: FS.readFileSync(values.chain, 'utf-8'),
            signAlg: values.sign,
        });
    } else {
        const SIGSTORE = await import('./sigstore.js');
        console.error('* signing through sigstore');
        signer = await SIGSTORE.signer({
            signAlg: values.sign,
            flow: values.flow,
            token: values.token,
            issuer: values['oidc-issuer'],
            connector: values.connector,
            fulcioURL: values.fulcio,
            rekorURL: values.rekor,
            tsaURL: values.tsa,
        });
    }

    const out = values.output ? FS.createWriteStream(values.output) : process.stdout;
    const res = await rebundle({
        source, prefix: values.prefix, hashAlg: values.hash, signAlg: values.sign, signer, out,
    });
    await end(out);

    if (values.output && (values.executable || values.prefix)) FS.chmodSync(values.output, 0o755);
    console.error(`* signed: ${res.hash}`);
    if (values.output) console.error(`* wrote ${values.output} (${FS.statSync(values.output).size} bytes)`);
}

async function check(args) {
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
    const extraRoots = (values.root ?? []).map((file) => FS.readFileSync(file, 'utf-8'));

    const res = await verify(archive, {
        extraRoots,
        identity: values.identity,
        issuer: values.issuer,
        trustedRoot: values['sigstore-root'],
    });
    const state = STATES[res.state] ?? { code: 2, label: res.state, note: '' };
    if (values.json) {
        console.log(JSON.stringify({
            state: res.state, reason: res.reason, subject: res.subject,
            signed: res.signed, trusted: res.trusted, sigstore: Boolean(res.sigstore),
            identity: res.identity, issuer: res.issuer,
            signedAt: res.signedAt ? res.signedAt.toISOString() : undefined,
            members: res.digests ? [...res.digests.keys()] : undefined,
            code: state.code,
        }, null, 2));
    } else {
        console.log(`${state.label} — ${res.reason ?? state.note}`);
        // For a sigstore signature the identity is the answer to "who signed
        // this"; the certificate subject is an ephemeral Fulcio artifact and
        // says nothing useful.
        if (res.identity) console.log(`  identity: ${res.identity}`);
        if (res.issuer) console.log(`  issuer: ${res.issuer}`);
        if (res.signedAt) console.log(`  signed: ${res.signedAt.toISOString()}`);
        if (res.subject && !res.identity) console.log(`  certificate: ${res.subject.replace(/\n/g, ', ')}`);
    }
    process.exitCode = state.code;
}

// Run an archive the way a mount does, with the verifying provider preloaded:
// the archive is checked and mounted by the child's own bootstrap, so what runs
// is what was verified. Everything after `--` is the application's own argv.
function run(args) {
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

    // The child's own bootstrap is what really gates the mount; checking here
    // first only buys a legible refusal instead of an uncaught error thrown
    // from inside node's startup.
    const extraRoots = (values.root ?? []).map((file) => FS.readFileSync(file, 'utf-8'));
    const res = verifySync(archive, {
        extraRoots, deep: false, identity: values.identity, issuer: values.issuer,
    });
    if (!(res.state === 'valid' || (values.untrusted && res.state === 'valid-untrusted'))) {
        const state = STATES[res.state] ?? { code: 2, label: res.state };
        console.error(`error: refusing to run '${archive}': ${state.label} — ${res.reason}`);
        process.exitCode = state.code;
        return;
    }

    const env = { ...process.env };
    if (values.root?.length) env.BUNDLE_ROOTS = values.root.join(PATH.delimiter);
    if (values.identity) env.BUNDLE_IDENTITY = values.identity;
    if (values.issuer) env.BUNDLE_ISSUER = values.issuer;
    if (values.untrusted) env.BUNDLE_ALLOW_UNTRUSTED = '1';

    const child = spawnSync(process.execPath,
        ['--no-warnings', '--experimental-vfs', '-r', REGISTER, ...MOUNT(archive), ...theirs],
        { stdio: 'inherit', env });
    if (child.error) throw child.error;
    if (child.signal) process.kill(process.pid, child.signal);
    process.exitCode = child.status ?? 70;
}

// Refresh the sigstore trust root. Verification is deliberately offline — it
// will not reach for the network to decide whether to mount something — so the
// trust material has to be fetched by an explicit step like this one. It comes
// over TUF, which is signed metadata with its own root of trust rather than a
// plain download.
async function trust(args) {
    const { values } = parseArgs({ args, options: { mirror: { type: 'string' } } });
    const SIGSTORE = await import('./sigstore.js');
    const path = await SIGSTORE.refreshTrustedRoot(values.mirror ? { mirror: values.mirror } : {});
    console.log(`sigstore trust root refreshed: ${path}`);
}

async function main() {
    // In every launch mode — `node app.js …`, the `--vfs-mount` shebang launcher, and
    // this fork's SEA — process.argv is [runtime, entrypath, ...userArgs], so the
    // user arguments always start at index 2.
    const argv = process.argv.slice(2);
    const [cmd, ...rest] = argv;
    try {
        if (cmd === 'create') return await create(rest);
        if (cmd === 'sign') return await sign(rest);
        if (cmd === 'verify') return await check(rest);
        if (cmd === 'run') return run(rest);
        if (cmd === 'trust') return await trust(rest);
        if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
            console.log(USAGE);
            process.exitCode = cmd ? 0 : 64;
            return;
        }
        throw new Error(`unknown command: ${cmd}`);
    } catch (err) {
        console.error(`error: ${err.message}`);
        process.exitCode = 70;
    }
}

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { data += chunk; })
            .on('end', () => resolve(data))
            .on('error', reject);
    });
}

// Close `out` and wait for it to flush. stdout must be ended (so a redirect
// sees EOF) but not awaited for 'finish', which never fires for a TTY/pipe.
function end(out) {
    return new Promise((resolve, reject) => {
        if (out === process.stdout) return out.end(resolve);
        out.on('error', reject).on('finish', resolve).end();
    });
}

// Run as a CLI when invoked directly, and as the SEA application entry point.
if (import.meta.main || (SEA.isSea && SEA.isSea())) main();
