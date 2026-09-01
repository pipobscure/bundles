import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import {
    createBundle, signBundle, verifyBundle, verifyBundleSync, inspectBundle,
    runBundle, fileSigner, mountArgv, registerPath,
} from '../src/api.ts';
import { APP, CHAIN_PEM, LEAF_KEY, ROOT_PEM, SHELL_BASE, scratch, testSigner, tree } from './helpers.ts';

// The programmatic drive — the export an embedder uses instead of the CLI. What
// it has to get right is that it does the same thing the CLI does, with the
// file plumbing handled.

const tmp = scratch('api');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const roots = [ROOT_PEM];

test('createBundle writes an unsigned archive and reports its members', async () => {
    const output = PATH.join(tmp, 'created.bundle');
    const res = await createBundle({ base: source, files: Object.keys(APP), output });
    assert.equal(res.output, output);
    assert.equal(res.signed, false);
    assert.equal(res.hash, null);
    assert.deepEqual(res.members.sort(), Object.keys(APP).sort());
    assert.equal(res.size, FS.statSync(output).size);
    assert.equal((await verifyBundle(output)).state, 'unsigned');
});

test('createBundle signs in one step when handed a key and chain', async () => {
    const output = PATH.join(tmp, 'created-signed.bundle');
    const res = await createBundle({
        base: source, files: Object.keys(APP), output,
        key: FS.readFileSync(LEAF_KEY), chain: FS.readFileSync(CHAIN_PEM, 'utf-8'),
    });
    assert.equal(res.signed, true);
    assert.equal((await verifyBundle(output, { roots })).state, 'valid');
});

test('createBundle refuses a half-given credential and an empty list', async () => {
    await assert.rejects(() => createBundle({
        base: source, files: Object.keys(APP), output: PATH.join(tmp, 'x.bundle'),
        key: FS.readFileSync(LEAF_KEY),
    }), /key and chain must be given together/);
    await assert.rejects(() => createBundle({ base: source, files: [], output: PATH.join(tmp, 'y.bundle') }),
        /file list is empty/);
});

test('signBundle turns an unsigned archive into a valid one', async () => {
    const unsigned = PATH.join(tmp, 'plain.bundle');
    const signed = PATH.join(tmp, 'plain.signed.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    const res = await signBundle({ source: unsigned, output: signed, signer: testSigner() });
    assert.equal(res.signed, true);
    assert.match(res.hash!, /^[0-9a-f]{64}$/);
    assert.equal(verifyBundleSync(signed, { roots }).state, 'valid');
});

test('signBundle refuses to write over the archive it is signing', async () => {
    const unsigned = PATH.join(tmp, 'inplace.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await assert.rejects(() => signBundle({ source: unsigned, output: unsigned, signer: testSigner() }),
        /must differ from the input/);
});

test('a prefixed archive is made executable and keeps its prefix intact', async () => {
    const unsigned = PATH.join(tmp, 'prefixed.bundle');
    const output = PATH.join(tmp, 'prefixed.run');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await signBundle({ source: unsigned, output, prefix: SHELL_BASE, signer: testSigner() });

    assert.ok(FS.statSync(output).mode & 0o111, 'the output should be executable');
    assert.deepEqual(
        FS.readFileSync(output).subarray(0, FS.statSync(SHELL_BASE).size),
        FS.readFileSync(SHELL_BASE),
    );
    assert.equal(verifyBundleSync(output, { roots }).state, 'valid');
});

test('roots are accepted as PEM text as well as as file paths', async () => {
    const output = PATH.join(tmp, 'roots.bundle');
    const signed = `${output}.signed`;
    await createBundle({ base: source, files: Object.keys(APP), output });
    await signBundle({ source: output, output: signed, signer: testSigner() });
    const byPath = verifyBundleSync(signed, { roots: [ROOT_PEM] });
    const byText = verifyBundleSync(signed, { roots: [FS.readFileSync(ROOT_PEM, 'utf-8')] });
    assert.equal(byPath.state, 'valid');
    assert.equal(byText.state, 'valid');
});

test('inspectBundle reports what an archive claims, before any of it is believed', async () => {
    const unsigned = PATH.join(tmp, 'inspect.bundle');
    const signed = PATH.join(tmp, 'inspect.signed.bundle');
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

test('runBundle mounts a valid archive and runs it', async () => {
    const unsigned = PATH.join(tmp, 'run.bundle');
    const signed = PATH.join(tmp, 'run.signed.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await signBundle({ source: unsigned, output: signed, signer: testSigner() });

    const res = runBundle(signed, { roots, args: ['a', 'b'], stdio: 'pipe' });
    assert.equal(res.status, 0, res.stderr ?? '');
    assert.match(res.stdout!, /hello from a signed bundle \[sub\] a,b/);
});

test('runBundle refuses an archive it will not vouch for', async () => {
    const unsigned = PATH.join(tmp, 'norun.bundle');
    const signed = PATH.join(tmp, 'norun.signed.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    await signBundle({ source: unsigned, output: signed, signer: testSigner() });

    assert.throws(() => runBundle(signed, { roots: [], stdio: 'pipe' }), { code: 'ERR_BUNDLE_UNTRUSTED' });
    // ...unless told that an unanchored chain is acceptable.
    const res = runBundle(signed, { roots: [], allowUntrusted: true, stdio: 'pipe' });
    assert.equal(res.status, 0, res.stderr ?? '');
});

test('mountArgv names a register preload that is really there', () => {
    const argv = mountArgv('/tmp/example.bundle');
    assert.ok(argv.includes('--experimental-vfs'));
    assert.ok(argv.includes('--vfs-load'));
    assert.equal(argv[argv.length - 2], '/tmp/example.bundle');
    assert.equal(argv[argv.length - 1], '--', 'app arguments must not be parsed as node flags');
    assert.ok(FS.existsSync(registerPath()), registerPath());
});

test('fileSigner reads the credential off disk and signs with it', async () => {
    const unsigned = PATH.join(tmp, 'filesigner.bundle');
    const signed = PATH.join(tmp, 'filesigner.signed.bundle');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned });
    const signer = fileSigner({ key: LEAF_KEY, chain: CHAIN_PEM });
    assert.equal(signer.kind, 'key');
    assert.match(signer.chain, /BEGIN CERTIFICATE/);
    await signBundle({ source: unsigned, output: signed, signer });
    assert.equal(verifyBundleSync(signed, { roots }).state, 'valid');
});
