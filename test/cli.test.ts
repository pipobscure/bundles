import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, USAGE, STATES, COMMANDS } from '../src/cli.ts';
import { createBundle } from '../src/api.ts';
import {
    APP, CERTS, CHAIN_PEM, LEAF_KEY, ROOT_PEM, SHELL_BASE,
    cli, collector, scratch, testSigner, tree,
} from './helpers.ts';

// The CLI. Most of it runs in-process — `main()` returns an exit code rather
// than exiting, which is what makes that possible — and only the cases that are
// genuinely about being a process go through a subprocess.

const tmp = scratch('cli');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const list = PATH.join(tmp, 'members.txt');
FS.writeFileSync(list, `${Object.keys(APP).join('\n')}\n`);

test('help is printed for --help, and for no command at all', async () => {
    const io = collector();
    assert.equal(await main(['--help'], io), 0);
    assert.equal(io.stdout.join('\n'), USAGE);

    const bare = collector();
    // Nothing to do is a usage error, so it prints the usage and says so.
    assert.equal(await main([], bare), 64);
    assert.equal(bare.stdout.join('\n'), USAGE);
});

test('the usage text lists exactly the commands the CLI dispatches', () => {
    const lines = USAGE.split('\n');
    const start = lines.indexOf('commands:') + 1;
    const listed = lines.slice(start, lines.indexOf('', start))
        .map((line) => line.trim().split(/\s+/)[0]!);
    assert.deepEqual(listed, Object.keys(COMMANDS));
});

test('an unknown command is reported rather than ignored', async () => {
    const io = collector();
    assert.equal(await main(['frobnicate'], io), 70);
    assert.match(io.stderr.join('\n'), /unknown command: frobnicate/);
});

test('create builds an archive from a file list and names its members', async () => {
    const output = PATH.join(tmp, 'created.bundle');
    const io = collector();
    assert.equal(await main(['create', '--base', source, '--files', list, '--output', output], io), 0);
    assert.ok(FS.existsSync(output));
    for (const name of Object.keys(APP)) assert.ok(io.stderr.includes(`+ ${name}`), name);
    assert.match(io.stderr.join('\n'), /unsigned archive \(4 members/);
});

test('create refuses a key without a chain', async () => {
    const io = collector();
    assert.equal(await main(['create', '--base', source, '--files', list, '--key', LEAF_KEY], io), 70);
    assert.match(io.stderr.join('\n'), /--key and --chain must be given together/);
});

test('sign, then verify, agree about an archive', async () => {
    const unsigned = PATH.join(tmp, 'plain.bundle');
    const signed = PATH.join(tmp, 'plain.signed.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });

    const signing = collector();
    assert.equal(await main(['sign', '--key', LEAF_KEY, '--chain', CHAIN_PEM, '--output', signed, unsigned], signing), 0);
    assert.match(signing.stderr.join('\n'), /signed: [0-9a-f]{64}/);

    const ok = collector();
    assert.equal(await main(['verify', '--root', ROOT_PEM, signed], ok), 0);
    assert.match(ok.stdout.join('\n'), /^VALID —/);
    assert.match(ok.stdout.join('\n'), /Bundle Test Signer/);

    // Without the root it is genuinely signed and genuinely not trusted, and
    // the exit code says which.
    const untrusted = collector();
    assert.equal(await main(['verify', signed], untrusted), STATES['valid-untrusted'].code);
    assert.match(untrusted.stdout.join('\n'), /VALID \(UNTRUSTED\)/);
});

test('verify --json reports the same conclusion in a form a script can read', async () => {
    const unsigned = PATH.join(tmp, 'json.bundle');
    const signed = PATH.join(tmp, 'json.signed.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await main(['sign', '--key', LEAF_KEY, '--chain', CHAIN_PEM, '--output', signed, unsigned], collector());

    const io = collector();
    assert.equal(await main(['verify', '--root', ROOT_PEM, '--json', signed], io), 0);
    const res = JSON.parse(io.stdout.join('\n')) as Record<string, unknown>;
    assert.equal(res['state'], 'valid');
    assert.equal(res['trusted'], true);
    assert.equal(res['sigstore'], false);
    assert.equal(res['code'], 0);
    assert.deepEqual((res['members'] as string[]).sort(), Object.keys(APP).sort());
});

test('verify reports an unsigned archive as unsigned, with its own exit code', async () => {
    const archive = PATH.join(tmp, 'bare.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: archive });
    const io = collector();
    assert.equal(await main(['verify', archive], io), STATES.unsigned.code);
    assert.match(io.stdout.join('\n'), /^UNSIGNED/);
});

test('verify takes the archive as an option as well as a positional', async () => {
    const archive = PATH.join(tmp, 'bare.bundle');
    const io = collector();
    assert.equal(await main(['verify', '--archive', archive], io), STATES.unsigned.code);
});

test('the CLI refuses to write over the archive it is signing', () => {
    const res = cli(['sign', '--key', LEAF_KEY, '--chain', CHAIN_PEM,
        '--output', PATH.join(tmp, 'bare.bundle'), PATH.join(tmp, 'bare.bundle')]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /must differ from the input/);
});

test('an archive signed through the CLI verifies and runs from its shebang', async () => {
    const unsigned = PATH.join(tmp, 'runnable.bundle');
    const output = PATH.join(tmp, 'runnable.run');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });

    const signed = cli(['sign', '--key', LEAF_KEY, '--chain', CHAIN_PEM,
        '--prefix', SHELL_BASE, '--output', output, unsigned]);
    assert.equal(signed.status, 0, signed.stderr);

    const checked = cli(['verify', '--root', ROOT_PEM, output]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /^VALID/);

    // A prefixed output is made executable, and the prefix is a working
    // shebang — so the archive runs by being run, with no flags to remember.
    assert.ok(FS.statSync(output).mode & 0o111);
    const ran = spawnSync(output, ['x'], { encoding: 'utf-8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle \[sub\] x/);
});

test('run mounts a valid archive, and refuses one it cannot vouch for', async () => {
    const unsigned = PATH.join(tmp, 'runme.bundle');
    const signed = PATH.join(tmp, 'runme.signed.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await main(['sign', '--key', LEAF_KEY, '--chain', CHAIN_PEM, '--output', signed, unsigned], collector());

    const ok = cli(['run', '--root', ROOT_PEM, signed, '--', 'x', 'y']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /hello from a signed bundle \[sub\] x,y/);

    const refused = cli(['run', signed]);
    assert.equal(refused.status, STATES['valid-untrusted'].code);
    assert.match(refused.stderr, /refusing to run/);

    const allowed = cli(['run', '--untrusted', signed]);
    assert.equal(allowed.status, 0, allowed.stderr);
});

test('run needs an archive, and says which argument is missing', async () => {
    const io = collector();
    assert.equal(await main(['run'], io), 70);
    assert.match(io.stderr.join('\n'), /an archive path is required/);
});

test('skill lists what the package carries and installs it where asked', async () => {
    const listing = collector();
    assert.equal(await main(['skill', '--list'], listing), 0);
    assert.match(listing.stdout.join('\n'), /audit-bundle/);

    const dir = PATH.join(tmp, 'project-skills');
    const io = collector();
    assert.equal(await main(['skill', '--dir', dir], io), 0);
    assert.ok(FS.existsSync(PATH.join(dir, 'audit-bundle', 'SKILL.md')));
    assert.match(io.stdout.join('\n'), /installed skill 'audit-bundle'/);

    // A second run reports what it left alone rather than overwriting it.
    const again = collector();
    assert.equal(await main(['skill', '--dir', dir], again), 0);
    assert.match(again.stderr.join('\n'), /already there; --force to overwrite/);
});

test('skill refuses a name the package does not carry', async () => {
    const io = collector();
    assert.equal(await main(['skill', '--dir', PATH.join(tmp, 'x'), 'nonesuch'], io), 70);
    assert.match(io.stderr.join('\n'), /unknown skill: nonesuch/);
});

test('sea needs both an archive and somewhere to put the result', async () => {
    const missingArchive = collector();
    assert.equal(await main(['sea', '--output', PATH.join(tmp, 'x.sea')], missingArchive), 70);
    assert.match(missingArchive.stderr.join('\n'), /an archive path is required/);

    const missingOutput = collector();
    assert.equal(await main(['sea', PATH.join(tmp, 'bare.bundle')], missingOutput), 70);
    assert.match(missingOutput.stderr.join('\n'), /--output is required/);
});

test('the certificate fixtures the suite signs with are the repository ones', () => {
    assert.equal(PATH.dirname(LEAF_KEY), CERTS);
    assert.ok(FS.existsSync(ROOT_PEM));
    assert.equal(testSigner().signAlg, 'sha256');
});
