#!/usr/bin/env -S node --no-warnings
import * as SEA from 'node:sea';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, parseManifest, signatureOf, verify, verifySync } from './manifest.js';
import { createArchive, bundle } from './archive.js';

// The package root doubles as the library the loader (and any embedder)
// consumes: manifest building/parsing, verification, and archive creation. The
// VFS provider lives in './provider.js' and is deliberately not re-exported
// here — importing it needs `node:vfs`, which only exists under
// `--experimental-vfs`, and creating or verifying an archive does not.
export { buildManifest, parseManifest, signatureOf, verify, verifySync, createArchive, bundle };

const USAGE = `usage: <command> [options]

commands:
  create    build a (optionally signed) archive from a list of files
  verify    verify an archive and report its trust state
  run       mount a signed .napp and run it

create options:
  -b, --base <dir>      base directory the file list is relative to (default: .)
  -p, --prefix <file>   prefix prepended before the archive (launcher or binary);
                        omit it for a plain .napp meant to be run from a mount
  -f, --files <file>    read the newline-separated file list from here (default: stdin)
  -o, --output <file>   write the archive here (default: stdout)
  -k, --key <file>      leaf private key (PEM); enables signing with --chain
  -c, --chain <file>    full certificate chain (PEM, leaf first); enables signing
      --hash <alg>      digest for the whole-file hash and member digests (default: sha256)
      --sign <alg>      digest the signature over that hash uses (default: sha256)

verify options:
  -a, --archive <file>  archive to verify (or pass it as a positional argument)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --json            print the result as JSON

run options:
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --untrusted       run an archive whose signature is good but untrusted
  usage: run [options] <archive> [-- <arguments for the application>]

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
    const key = values.key ? FS.readFileSync(values.key) : undefined;
    const chain = values.chain ? FS.readFileSync(values.chain, 'utf-8') : undefined;

    for (const file of files) console.error(`+ ${file}`);
    console.error(key && chain
        ? `* signed archive (${files.length} members, ${values.hash} digests, ${values.sign} signature)`
        : `* unsigned archive (${files.length} members, ${values.hash} digests)`);

    const out = values.output ? FS.createWriteStream(values.output) : process.stdout;
    await bundle({ base: values.base, files, prefix: values.prefix, hashAlg: values.hash, signAlg: values.sign, key, chain, out });
    await end(out);
}

async function check(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            archive: { type: 'string', short: 'a' },
            root:    { type: 'string', short: 'r', multiple: true },
            json:    { type: 'boolean' },
        },
    });
    const archive = values.archive ?? positionals[0];
    if (!archive) throw new Error('verify: an archive path is required');
    const extraRoots = (values.root ?? []).map((file) => FS.readFileSync(file, 'utf-8'));

    const res = await verify(archive, { extraRoots });
    const state = STATES[res.state] ?? { code: 2, label: res.state, note: '' };
    if (values.json) {
        console.log(JSON.stringify({ state: res.state, reason: res.reason, subject: res.subject, signed: res.signed, trusted: res.trusted, code: state.code }));
    } else {
        console.log(`${state.label} — ${res.reason ?? state.note}`);
        if (res.subject) console.log(`  certificate: ${res.subject.replace(/\n/g, ', ')}`);
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
            untrusted: { type: 'boolean' },
        },
    });
    const archive = positionals[0];
    if (!archive) throw new Error('run: an archive path is required');

    // The child's own bootstrap is what really gates the mount; checking here
    // first only buys a legible refusal instead of an uncaught error thrown
    // from inside node's startup.
    const extraRoots = (values.root ?? []).map((file) => FS.readFileSync(file, 'utf-8'));
    const res = verifySync(archive, { extraRoots, deep: false });
    if (!(res.state === 'valid' || (values.untrusted && res.state === 'valid-untrusted'))) {
        const state = STATES[res.state] ?? { code: 2, label: res.state };
        console.error(`error: refusing to run '${archive}': ${state.label} — ${res.reason}`);
        process.exitCode = state.code;
        return;
    }

    const env = { ...process.env };
    if (values.root?.length) env.NAPP_ROOTS = values.root.join(PATH.delimiter);
    if (values.untrusted) env.NAPP_ALLOW_UNTRUSTED = '1';

    const child = spawnSync(process.execPath,
        ['--no-warnings', '--experimental-vfs', '-r', REGISTER, ...MOUNT(archive), ...theirs],
        { stdio: 'inherit', env });
    if (child.error) throw child.error;
    if (child.signal) process.kill(process.pid, child.signal);
    process.exitCode = child.status ?? 70;
}

async function main() {
    // In every launch mode — `node app.js …`, the `--vfs-mount` shebang launcher, and
    // this fork's SEA — process.argv is [runtime, entrypath, ...userArgs], so the
    // user arguments always start at index 2.
    const argv = process.argv.slice(2);
    const [cmd, ...rest] = argv;
    try {
        if (cmd === 'create') return await create(rest);
        if (cmd === 'verify') return await check(rest);
        if (cmd === 'run') return run(rest);
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
