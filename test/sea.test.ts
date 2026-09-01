import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSea, createSeaBase, verifierFiles, stubSource, VERIFIER_ASSET } from '../src/sea.ts';
import { createBundle, verifyBundleSync, inspectBundle } from '../src/api.ts';
import { APP, CHAIN_PEM, LEAF_KEY, ROOT_PEM, scratch, testSigner, tree } from './helpers.ts';

// The self-validating executable: a node runtime, this package as a mounted
// asset inside it, and the application appended as a signed archive. Building
// one costs a 150 MB copy of node and a couple of seconds, so a single base is
// built here and every case appends to it.

const tmp = scratch('sea');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const APP_BUNDLE = PATH.join(tmp, 'app.bundle');
await createBundle({ base: source, files: Object.keys(APP), output: APP_BUNDLE });

// The base is what takes the time; every executable below reuses it.
const BASE = PATH.join(tmp, 'sea-base');
const base = await createSeaBase({ output: BASE, sigstore: false, bootstrap: { roots: [ROOT_PEM] } });

function run(executable: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(executable, args, { encoding: 'utf-8', env: { ...process.env, ...env } });
}

test('the verifier file list is what the container needs to check itself', () => {
    const withSigstore = verifierFiles();
    const without = verifierFiles({ sigstore: false });

    // Its own compiled modules, always.
    for (const name of ['package.json', 'sea', 'manifest', 'provider', 'sigstore']) {
        assert.ok(withSigstore.some((file) => file.includes(name)), name);
    }
    // Nothing that is there to be read rather than run.
    assert.ok(!withSigstore.some((file) => file.endsWith('.map') || file.endsWith('.d.ts')));

    // The sigstore libraries are the difference, and they are lazily required —
    // so no observation run would ever have found them.
    assert.ok(withSigstore.some((file) => file.startsWith('node_modules/@sigstore/verify/')));
    assert.ok(!without.some((file) => file.startsWith('node_modules/')));
    assert.ok(withSigstore.length > without.length);
});

test('the generated stub mounts the blob and hands over to bootstrap', () => {
    const stub = stubSource({ roots: ['/etc/root.pem'], allowUntrusted: true });
    assert.match(stub, /getRawAsset\(/);
    assert.ok(stub.includes(VERIFIER_ASSET));
    assert.match(stub, /new VFS\.ZipProvider/);
    assert.match(stub, /\.bootstrap\(OPTIONS\)/);
    // Whatever the build was told is baked in, because a preload takes no
    // arguments and neither does an executable being run by its own name.
    assert.match(stub, /"\/etc\/root\.pem"/);
    assert.match(stub, /"allowUntrusted": true/);
});

test('the base is a runnable node binary with the verifier inside it', () => {
    assert.ok(base.size > 1_000_000, `${base.size} bytes`);
    assert.ok(FS.statSync(BASE).mode & 0o111);
    assert.ok(base.verifier.includes('package.json'));

    // On its own it has no archive at the end, so there is nothing to verify
    // and nothing to run — and it says so rather than doing something.
    const res = run(BASE);
    assert.notEqual(res.status, 0);
});

test('a signed container verifies itself and runs the application inside it', async () => {
    const output = PATH.join(tmp, 'app.sea');
    const res = await buildSea({
        app: APP_BUNDLE, output, base: BASE, signer: testSigner(),
        bootstrap: { roots: [ROOT_PEM] },
    });
    assert.equal(res.signed, true);
    assert.match(res.hash!, /^[0-9a-f]{64}$/);
    assert.ok(FS.statSync(output).mode & 0o111);

    // The whole file — runtime, verifier and application alike — is what the
    // signature covers, so the same verification the CLI does applies to it.
    assert.equal(verifyBundleSync(output, { roots: [ROOT_PEM] }).state, 'valid');
    assert.deepEqual(inspectBundle(output).members.sort(), Object.keys(APP).sort());

    const ran = run(output, ['one', 'two']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle \[sub\] one,two/);
    FS.rmSync(output);
});

test('the application inside runs from the mount, not from any real directory', async () => {
    const reporting = tree(tmp, {
        'package.json': '{ "name": "where", "type": "module", "main": "index.js" }',
        'index.js': 'console.log(JSON.stringify({ file: import.meta.filename, dir: import.meta.dirname }));',
    }, 'where');
    const archive = PATH.join(tmp, 'where.bundle');
    await createBundle({ base: reporting, files: ['package.json', 'index.js'], output: archive });

    const output = PATH.join(tmp, 'where.sea');
    await buildSea({ app: archive, output, base: BASE, signer: testSigner(), bootstrap: { roots: [ROOT_PEM] } });

    const ran = run(output);
    assert.equal(ran.status, 0, ran.stderr);
    const where = JSON.parse(ran.stdout) as { file: string; dir: string };
    // Whatever the mount point is, it is not where the executable lives — the
    // application cannot see, and cannot be confused by, the real filesystem
    // around it.
    assert.ok(!where.dir.startsWith(tmp), where.dir);
    assert.equal(where.file, PATH.join(where.dir, 'index.js'));
    FS.rmSync(output);
});

test('a CommonJS application is run as CommonJS', async () => {
    const commonjs = tree(tmp, {
        'package.json': '{ "name": "cjs", "main": "index.js" }',
        'index.js': 'console.log("commonjs ran", typeof require, __filename.endsWith("index.js"));',
    }, 'cjs');
    const archive = PATH.join(tmp, 'cjs.bundle');
    await createBundle({ base: commonjs, files: ['package.json', 'index.js'], output: archive });

    const output = PATH.join(tmp, 'cjs.sea');
    await buildSea({ app: archive, output, base: BASE, signer: testSigner(), bootstrap: { roots: [ROOT_PEM] } });
    const ran = run(output);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /commonjs ran function true/);
    FS.rmSync(output);
});

test('a container whose bytes changed refuses to run anything', async () => {
    const output = PATH.join(tmp, 'tampered.sea');
    await buildSea({ app: APP_BUNDLE, output, base: BASE, signer: testSigner(), bootstrap: { roots: [ROOT_PEM] } });

    // Change one byte of a member's content. It is inside the region the
    // whole-file hash covers, so the container's own check must catch it.
    const bytes = FS.readFileSync(output);
    const at = bytes.lastIndexOf(Buffer.from('hello from a signed bundle'));
    assert.notEqual(at, -1);
    bytes[at] = 0x48; // 'H'
    FS.writeFileSync(output, bytes);
    FS.chmodSync(output, 0o755);

    const ran = run(output);
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /refusing to run/);
    assert.doesNotMatch(ran.stdout, /hello from a signed bundle/);
    FS.rmSync(output);
});

test('an unsigned container refuses to run, however well formed it is', async () => {
    const output = PATH.join(tmp, 'unsigned.sea');
    const res = await buildSea({ app: APP_BUNDLE, output, base: BASE, bootstrap: { roots: [ROOT_PEM] } });
    assert.equal(res.signed, false);

    const ran = run(output);
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /refusing to run/);
    FS.rmSync(output);
});

test('a trust root baked in at build time needs nothing from the environment', async () => {
    // BASE was built with `bootstrap: { roots: [ROOT_PEM] }`, which is the
    // point of baking anything in: an executable that is run by its own name
    // has no flags and no preload to configure it.
    const output = PATH.join(tmp, 'baked.sea');
    await buildSea({ app: APP_BUNDLE, output, base: BASE, signer: testSigner() });
    const ran = run(output, [], { BUNDLE_ROOTS: '', BUNDLE_ALLOW_UNTRUSTED: '' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle/);
    FS.rmSync(output);
});

test('a container with nothing baked in takes its policy from the environment', async () => {
    // The other half: build once, decide where it is allowed to run later.
    const plainBase = PATH.join(tmp, 'plain-base');
    await createSeaBase({ output: plainBase, sigstore: false });
    const output = PATH.join(tmp, 'plain.sea');
    await buildSea({ app: APP_BUNDLE, output, base: plainBase, signer: testSigner() });
    FS.rmSync(plainBase);

    // Nothing to anchor the chain to: the signature is perfectly good and the
    // certificate means nothing here, which is `valid-untrusted`.
    const refused = run(output, [], { BUNDLE_ROOTS: '', BUNDLE_ALLOW_UNTRUSTED: '' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /valid-untrusted/);

    const trusted = run(output, [], { BUNDLE_ROOTS: ROOT_PEM, BUNDLE_ALLOW_UNTRUSTED: '' });
    assert.equal(trusted.status, 0, trusted.stderr);
    assert.match(trusted.stdout, /hello from a signed bundle/);

    const allowed = run(output, [], { BUNDLE_ROOTS: '', BUNDLE_ALLOW_UNTRUSTED: '1' });
    assert.equal(allowed.status, 0, allowed.stderr);
    FS.rmSync(output);
});

test('a container built through the CLI is the same self-validating thing', async () => {
    const output = PATH.join(tmp, 'cli.sea');
    const { main } = await import('../src/cli.ts');
    const { collector } = await import('./helpers.ts');
    const io = collector();
    const code = await main([
        'sea', '--output', output, '--base', BASE,
        '--key', LEAF_KEY, '--chain', CHAIN_PEM,
        '--root', ROOT_PEM, APP_BUNDLE,
    ], io);
    assert.equal(code, 0, io.stderr.join('\n'));

    const ran = run(output, ['cli']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle \[sub\] cli/);
    FS.rmSync(output);
});
