import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    createBundle, signBundle, signedName, verifyBundle, verifyBundleSync, inspectBundle,
    runBundle, fileSigner, mountArgv, registerPath,
} from '../src/api.ts';
import { APP, CHAIN_PEM, LEAF_KEY, ROOT, ROOT_PEM, SHELL_BASE, WINDOWS, scratch, testSigner, tree } from './helpers.ts';

// The programmatic drive — the export an embedder uses instead of the CLI. What
// it has to get right is that it does the same thing the CLI does, with the
// file plumbing handled.

const tmp = scratch('api');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const roots = [ROOT_PEM];

test('createBundle writes an unsigned archive and reports its members', async () => {
    const output = PATH.join(tmp, 'created.run');
    const res = await createBundle({ base: source, files: Object.keys(APP), output });
    assert.equal(res.output, output);
    assert.equal(res.signed, false);
    // Unsigned, it still records what its bytes hash to.
    assert.match(res.hash!, /^[0-9a-f]{64}$/);
    assert.deepEqual(res.members.sort(), Object.keys(APP).sort());
    assert.equal(res.size, FS.statSync(output).size);
    assert.equal((await verifyBundle(output)).state, 'unsigned');
});

test('createBundle signs in one step when handed a key and chain', async () => {
    const output = PATH.join(tmp, 'created-signed.nzip');
    const res = await createBundle({
        base: source, files: Object.keys(APP), output,
        key: FS.readFileSync(LEAF_KEY), chain: FS.readFileSync(CHAIN_PEM, 'utf-8'),
    });
    assert.equal(res.signed, true);
    assert.equal((await verifyBundle(output, { roots })).state, 'valid');
});

test('createBundle refuses a half-given credential and an empty list', async () => {
    await assert.rejects(() => createBundle({
        base: source, files: Object.keys(APP), output: PATH.join(tmp, 'x.run'),
        key: FS.readFileSync(LEAF_KEY),
    }), /key and chain must be given together/);
    await assert.rejects(() => createBundle({ base: source, files: [], output: PATH.join(tmp, 'y.run') }),
        /file list is empty/);
});

test('signBundle turns an unsigned archive into a valid one', async () => {
    const unsigned = PATH.join(tmp, 'plain.run');
    const signed = PATH.join(tmp, 'plain.signed.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    const res = await signBundle({ source: unsigned, output: signed, signer: testSigner() });
    assert.equal(res.signed, true);
    assert.match(res.hash!, /^[0-9a-f]{64}$/);
    assert.equal(verifyBundleSync(signed, { roots }).state, 'valid');
});

test('signBundle signs in place, and a sign that fails leaves the archive as it was', async () => {
    const archive = PATH.join(tmp, 'inplace.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: archive, prefix: SHELL_BASE });
    const before = FS.readFileSync(archive);

    // A signer that fails part way: nothing replaces the archive.
    const failing = { ...testSigner(), sign: async () => { throw new Error('no signature today'); } };
    await assert.rejects(() => signBundle({ source: archive, output: archive, signer: failing }), /no signature today/);
    assert.deepEqual(FS.readFileSync(archive), before);
    assert.deepEqual(FS.readdirSync(tmp).filter((name) => name.includes('.incoming-')), [], 'no half-written file left behind');

    await signBundle({ source: archive, output: archive, signer: testSigner() });
    assert.equal(verifyBundleSync(archive, { roots }).state, 'valid');
    assert.deepEqual(FS.readFileSync(archive).subarray(0, FS.statSync(SHELL_BASE).size), FS.readFileSync(SHELL_BASE), 'the prefix is kept');
});

test('signing app.unsigned.nzip makes app.nzip, by name', () => {
    assert.equal(signedName('app.unsigned.nzip'), 'app.nzip');
    assert.equal(signedName('build/cli.unsigned.nzip'), 'build/cli.nzip');
    assert.equal(signedName('tool.unsigned'), 'tool');
    assert.equal(signedName('tool.unsigned.exe'), 'tool.exe');
    assert.equal(signedName('app.nzip'), 'app.nzip', 'otherwise, in place');
    assert.equal(signedName('dir.unsigned/app.nzip'), 'dir.unsigned/app.nzip');
});

test('a prefix is chosen when the archive is created, and signing keeps it and makes the result executable', async () => {
    const unsigned = PATH.join(tmp, 'prefixed.run');
    const output = PATH.join(tmp, 'prefixed.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned, prefix: SHELL_BASE });
    await signBundle({ source: unsigned, output, signer: testSigner() });

    // Windows has no executable bit; what makes a prefixed archive runnable
    // there is the .nzip association, which `bundle install` sets up.
    if (!WINDOWS) assert.ok(FS.statSync(output).mode & 0o111, 'the output should be executable');
    assert.deepEqual(
        FS.readFileSync(output).subarray(0, FS.statSync(SHELL_BASE).size),
        FS.readFileSync(SHELL_BASE),
    );
    assert.equal(verifyBundleSync(output, { roots }).state, 'valid');

    // Signing does not choose a shape.
    await assert.rejects(() => signBundle({ source: unsigned, output: PATH.join(tmp, 'x.nzip'), signer: testSigner(), prefix: SHELL_BASE } as never),
        /the prefix is chosen when the archive is created/);
});

test('roots are accepted as PEM text as well as as file paths', async () => {
    const output = PATH.join(tmp, 'roots.run');
    const signed = `${output}.signed`;
    await createBundle({ base: source, files: Object.keys(APP), output });
    await signBundle({ source: output, output: signed, signer: testSigner() });
    const byPath = verifyBundleSync(signed, { roots: [ROOT_PEM] });
    const byText = verifyBundleSync(signed, { roots: [FS.readFileSync(ROOT_PEM, 'utf-8')] });
    assert.equal(byPath.state, 'valid');
    assert.equal(byText.state, 'valid');
});

test('inspectBundle reports what an archive claims, before any of it is believed', async () => {
    const unsigned = PATH.join(tmp, 'inspect.run');
    const signed = PATH.join(tmp, 'inspect.signed.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });

    const before = inspectBundle(unsigned);
    assert.equal(before.signed, false);
    assert.equal(before.hash, undefined);
    assert.deepEqual(before.members.sort(), Object.keys(APP).sort());
    assert.equal(before.manifest?.hashAlg, 'sha256');
    assert.equal(before.manifest?.signAlg, undefined);

    await signBundle({ source: unsigned, output: signed, signer: testSigner() });
    const after = inspectBundle(signed);
    assert.equal(after.signed, true);
    assert.match(after.hash!, /^[0-9a-f]{64}$/);
    assert.deepEqual(after.fields, []);
    assert.equal(after.manifest?.chain.length, 2);
});

// The application runs in this process and writes to this stdout, so tests
// that care what it printed have to borrow the stream for the duration.
async function capture(run: () => Promise<number>): Promise<{ status: number; stdout: string }> {
    const write = process.stdout.write.bind(process.stdout);
    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    try {
        return { status: await run(), stdout };
    } finally {
        process.stdout.write = write;
    }
}

test('runBundle mounts a valid archive and runs it', async () => {
    const unsigned = PATH.join(tmp, 'run.run');
    const signed = PATH.join(tmp, 'run.signed.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await signBundle({ source: unsigned, output: signed, signer: testSigner() });

    const res = await capture(() => runBundle(signed, { roots, args: ['a', 'b'] }));
    assert.equal(res.status, 0);
    assert.match(res.stdout, /hello from a signed bundle \[sub\] a,b/);
});

test('a CLI running out of a mount still runs an archive, in its own process', async () => {
    // The published CLI *is* an archive, so its modules live at a mount point
    // no child process can see — and `node -r <preload>` there names a path
    // that does not exist. That is the ordinary way this tool is installed, so
    // it gets a test: a package whose main is this CLI, mounted with
    // --vfs-load, asked to run a signed archive.
    const unsigned = PATH.join(tmp, 'mounted.run');
    const signed = PATH.join(tmp, 'mounted.signed.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await signBundle({ source: unsigned, output: signed, signer: testSigner() });

    const cli = PATH.join(tmp, 'mounted-cli');
    FS.mkdirSync(cli, { recursive: true });
    FS.cpSync(PATH.join(ROOT, 'dist'), PATH.join(cli, 'dist'), { recursive: true });
    FS.writeFileSync(PATH.join(cli, 'package.json'),
        '{ "name": "mounted-cli", "type": "module", "main": "dist/main.js" }');

    const from = (args: string[]) => spawnSync(process.execPath,
        ['--no-warnings', '--experimental-vfs', `--vfs-load=${cli}`, '--', ...args],
        { encoding: 'utf-8' });

    const ran = from(['run', '--root', ROOT_PEM, signed, '--', 'a', 'b']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle \[sub\] a,b/);

    // ...and it refuses exactly as the child-process path refuses.
    const refused = from(['run', signed]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to run .*valid-untrusted/);
});

test('runBundle refuses an archive it will not vouch for', async () => {
    const unsigned = PATH.join(tmp, 'norun.run');
    const signed = PATH.join(tmp, 'norun.signed.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await signBundle({ source: unsigned, output: signed, signer: testSigner() });

    await assert.rejects(() => runBundle(signed, { roots: [] }), { code: 'ERR_BUNDLE_UNTRUSTED' });
    // ...unless told that an unanchored chain is acceptable.
    const res = await capture(() => runBundle(signed, { roots: [], allowUntrusted: true }));
    assert.equal(res.status, 0);
});

test('mountArgv names a register preload that is really there', () => {
    const argv = mountArgv('/tmp/example.run');
    assert.ok(argv.includes('--experimental-vfs'));
    assert.ok(argv.includes('--vfs-load'));
    assert.equal(argv[argv.length - 2], '/tmp/example.run');
    assert.equal(argv[argv.length - 1], '--', 'app arguments must not be parsed as node flags');
    assert.ok(FS.existsSync(registerPath()), registerPath());
});

test('fileSigner reads the credential off disk and signs with it', async () => {
    const unsigned = PATH.join(tmp, 'filesigner.run');
    const signed = PATH.join(tmp, 'filesigner.signed.nzip');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    const signer = fileSigner({ key: LEAF_KEY, chain: CHAIN_PEM });
    assert.equal(signer.kind, 'key');
    assert.match(signer.chain, /BEGIN CERTIFICATE/);
    await signBundle({ source: unsigned, output: signed, signer });
    assert.equal(verifyBundleSync(signed, { roots }).state, 'valid');
});
