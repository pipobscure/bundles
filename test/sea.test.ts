import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSea, createSeaBase, executablePath, verifierFiles, stubSource, type SeaBaseResult } from '../src/sea.ts';
import { createBundle, signBundle, verifyBundleSync, inspectBundle } from '../src/api.ts';
import { APP, CHAIN_PEM, LEAF_KEY, ROOT_PEM, scratch, testSigner, tree } from './helpers.ts';

// The self-validating executable: a node runtime, this package as a mounted
// asset inside it, and the application appended as a signed archive. Building
// one costs a 150 MB copy of node and a couple of seconds, so a single base is
// built here and every case appends to it.

const tmp = scratch('sea');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

// An executable that has just run can stay locked on Windows for a moment
// after it exits; removing it there is retried rather than failed.
function discard(file: string): void {
    FS.rmSync(file, { maxRetries: 10, retryDelay: 100 });
}

const APP_BUNDLE = PATH.join(tmp, 'app.run');
await createBundle({ base: source, files: Object.keys(APP), output: APP_BUNDLE });

// The base is what takes the time; every executable below reuses it.
// Where it lands, which on Windows has `.exe` on the end: a file that is run
// can be named without it, but one that is read or appended to cannot.
const BASE = executablePath(PATH.join(tmp, 'sea-base'));

// Building one needs a node whose --build-sea understands "vfsArchive"
// (nodejs/node#65810). One without it builds a binary that cannot start, and
// createSeaBase's own self-test refuses it and says why. That is a capability
// the runtime lacks rather than a fault in this package, so every case that
// needs an executable is skipped with that reason — and runs again, unchanged,
// on the first node that has it. Any other failure is a failure.
let base: SeaBaseResult | undefined;
let SKIP: string | false = false;
try {
    base = await createSeaBase({ output: BASE, sigstore: false, bootstrap: { roots: [ROOT_PEM] } });
} catch (err) {
    if ((err as { code?: string }).code !== 'ERR_BUNDLE_NO_VFS_ARCHIVE') throw err;
    SKIP = `node ${process.versions.node} cannot build an executable: no "vfsArchive" (nodejs/node#65810)`;
}
const needsSea = { skip: SKIP };

// All the setup happens here, before any test is registered. A top-level await
// between two tests is a race with the runner: when the tests before it finish
// quickly — skipped, say — the runner reaches the end, its after-hook deletes
// the scratch directory, and the await is still writing into it.

const SIGNED_APP = PATH.join(tmp, 'app.signed.nzip');
await signBundle({ source: APP_BUNDLE, output: SIGNED_APP, signer: testSigner() });

// BASE has a root baked in, which is what most of these want. One more with no
// policy at all is what the environment-driven cases need: with a trusted root
// already inside the binary, nothing it is handed is ever untrusted.
const OPEN_BASE = executablePath(PATH.join(tmp, 'open-base'));
if (!SKIP) await createSeaBase({ output: OPEN_BASE, sigstore: false });


/**
 * Build an executable and sign it, as a user does: 'bundle sea', then 'bundle
 * sign'. Building leaves it unsigned, so what is signed is what was built.
 */
async function sealed(options: Omit<Parameters<typeof buildSea>[0], 'output'> & { output: string }) {
    const unsigned = `${options.output}.unsigned`;
    await buildSea({ ...options, output: unsigned });
    const res = await signBundle({ source: unsigned, output: options.output, signer: testSigner() });
    discard(unsigned);
    return res;
}

function run(executable: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
    const res = spawnSync(executable, args, { encoding: 'utf-8', env: { ...process.env, ...env } });
    // A spawn that never started has no output to report; say why instead.
    if (res.error) throw res.error;
    return res;
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

test('the generated stub requires the launcher and lets it decide the shape', () => {
    const stub = stubSource({ roots: ['/etc/root.pem'], allowUntrusted: true });
    // The blob is the file system now, so the stub is a relative require —
    // no asset to fetch, no ZipBuffer to mount by hand.
    // An ES module, like every other file in the bundle it is injected into.
    assert.match(stub, /import \* as launch from "\.\/(src|dist)\/launch\.(ts|js)"/);
    assert.ok(!stub.includes('require('), 'the stub is not CommonJS');
    assert.ok(!stub.includes('getRawAsset'), 'nothing unpacks an asset any more');
    assert.match(stub, /appended\(process\.execPath\)/);
    assert.match(stub, /\.runSelf\(OPTIONS\)/);
    assert.match(stub, /\.main\(process\.argv\.slice\(2\), OPTIONS\)/);
    // 'none' is the only launcher case: an unsigned archive at the tail is a
    // container to refuse, not a reason to print usage.
    assert.match(stub, /=== 'none'/);
    // Whatever the build was told is baked in, because an executable being run
    // by its own name takes no arguments for this.
    assert.match(stub, /"\/etc\/root\.pem"/);
    assert.match(stub, /"allowUntrusted": true/);
});

test('the base is a runnable node binary with the verifier inside it', needsSea, () => {
    assert.ok(base!.size > 1_000_000, `${base!.size} bytes`);
    // Windows has no executable bit; the extension is what makes it runnable.
    if (process.platform !== 'win32') assert.ok(FS.statSync(BASE).mode & 0o111);
    assert.ok(base!.verifier.includes('package.json'));

    // On its own it has no archive at the end, so there is nothing to verify
    // and nothing to run — and it says so rather than doing something.
    const res = run(BASE);
    assert.notEqual(res.status, 0);
});

test('a signed container verifies itself and runs the application inside it', needsSea, async () => {
    const output = PATH.join(tmp, 'app.sea');
    const res = await sealed({ app: APP_BUNDLE, output, base: BASE, bootstrap: { roots: [ROOT_PEM] } });
    assert.equal(res.signed, true);
    assert.match(res.hash!, /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.ok(FS.statSync(output).mode & 0o111);

    // The whole file — runtime, verifier and application alike — is what the
    // signature covers, so the same verification the CLI does applies to it.
    assert.equal(verifyBundleSync(output, { roots: [ROOT_PEM] }).state, 'valid');
    assert.deepEqual(inspectBundle(output).members.sort(), Object.keys(APP).sort());

    const ran = run(output, ['one', 'two']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle \[sub\] one,two/);
    discard(output);
});

test('the application inside runs from the mount, not from any real directory', needsSea, async () => {
    const reporting = tree(tmp, {
        'package.json': '{ "name": "where", "type": "module", "main": "index.js" }',
        'index.js': 'console.log(JSON.stringify({ file: import.meta.filename, dir: import.meta.dirname }));',
    }, 'where');
    const archive = PATH.join(tmp, 'where.run');
    await createBundle({ base: reporting, files: ['package.json', 'index.js'], output: archive });

    const output = PATH.join(tmp, 'where.sea');
    await sealed({ app: archive, output, base: BASE, bootstrap: { roots: [ROOT_PEM] } });

    const ran = run(output);
    assert.equal(ran.status, 0, ran.stderr);
    const where = JSON.parse(ran.stdout) as { file: string; dir: string };
    // Whatever the mount point is, it is not where the executable lives — the
    // application cannot see, and cannot be confused by, the real filesystem
    // around it.
    assert.ok(!where.dir.startsWith(tmp), where.dir);
    assert.equal(where.file, PATH.join(where.dir, 'index.js'));
    discard(output);
});

test('a CommonJS application is run as CommonJS', needsSea, async () => {
    const commonjs = tree(tmp, {
        'package.json': '{ "name": "cjs", "main": "index.js" }',
        'index.js': 'console.log("commonjs ran", typeof require, __filename.endsWith("index.js"));',
    }, 'cjs');
    const archive = PATH.join(tmp, 'cjs.run');
    await createBundle({ base: commonjs, files: ['package.json', 'index.js'], output: archive });

    const output = PATH.join(tmp, 'cjs.sea');
    await sealed({ app: archive, output, base: BASE, bootstrap: { roots: [ROOT_PEM] } });
    const ran = run(output);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /commonjs ran function true/);
    discard(output);
});

test('a container whose bytes changed refuses to run anything', needsSea, async () => {
    const output = PATH.join(tmp, 'tampered.sea');
    await sealed({ app: APP_BUNDLE, output, base: BASE, bootstrap: { roots: [ROOT_PEM] } });

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
    discard(output);
});

test('an unsigned container refuses to run, however well formed it is', needsSea, async () => {
    const output = PATH.join(tmp, 'unsigned.sea');
    const res = await buildSea({ app: APP_BUNDLE, output, base: BASE, bootstrap: { roots: [ROOT_PEM] } });
    assert.equal(res.signed, false);

    const ran = run(output);
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /refusing to run/);
    discard(output);
});

test('a trust root baked in at build time needs nothing from the environment', needsSea, async () => {
    // BASE was built with `bootstrap: { roots: [ROOT_PEM] }`, which is the
    // point of baking anything in: an executable that is run by its own name
    // has no flags and no preload to configure it.
    const output = PATH.join(tmp, 'baked.sea');
    await sealed({ app: APP_BUNDLE, output, base: BASE });
    const ran = run(output, [], { BUNDLE_ROOTS: '', BUNDLE_ALLOW_UNTRUSTED: '' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle/);
    discard(output);
});

test('a container with nothing baked in takes its policy from the environment', needsSea, async () => {
    // The other half: build once, decide where it is allowed to run later.
    const plainBase = executablePath(PATH.join(tmp, 'plain-base'));
    await createSeaBase({ output: plainBase, sigstore: false });
    const output = PATH.join(tmp, 'plain.sea');
    await sealed({ app: APP_BUNDLE, output, base: plainBase });
    discard(plainBase);

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
    discard(output);
});

test('a container built through the CLI is the same self-validating thing', needsSea, async () => {
    const output = PATH.join(tmp, 'cli.sea');
    const { main } = await import('../src/cli.ts');
    const { collector } = await import('./helpers.ts');
    const io = collector();
    const unsigned = PATH.join(tmp, 'cli.unsigned.sea');
    const code = await main(['sea', '--output', unsigned, '--base', BASE, '--root', ROOT_PEM, APP_BUNDLE], io);
    assert.equal(code, 0, io.stderr.join('\n'));
    assert.match(io.stderr.join('\n'), /unsigned\)\n\* review it, then sign it: bundle sign .*\.unsigned/);

    // Unsigned, it is reviewed as it will run — the runtime in front included —
    // and refuses to run.
    const audited = collector();
    assert.equal(await main(['audit', unsigned], audited), 0);
    assert.match(audited.stdout.join('\n'), /prefix: \d+ bytes of binary, which runs first/);
    assert.notEqual(run(unsigned, ['cli']).status, 0);

    const signed = collector();
    assert.equal(await main(['sign', '--key', LEAF_KEY, '--chain', CHAIN_PEM, '--output', output, unsigned], signed), 0, signed.stderr.join('\n'));
    discard(unsigned);

    const ran = run(output, ['cli']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle \[sub\] cli/);
    discard(output);
});

// ------------------------------------------------------- the verifying node ---

// The same base with nothing appended is a runtime that takes an archive on its
// command line. Every case below reuses BASE, so none of them pays for a second
// 150 MB copy of node.


test('the base runs an archive named on its command line', needsSea, () => {
    const ran = run(BASE, [SIGNED_APP, 'from', 'the', 'command', 'line'],
        { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle/);
    // The application's own arguments reach it, and argv[1] is the archive —
    // the same shape `--vfs-load` gives a program run out of a mount.
    assert.match(ran.stdout, /from,the,command,line/);
});

test('the verifying node refuses what it cannot vouch for, and runs nothing', needsSea, () => {
    // Unsigned: there is no signature to check, so there is nothing to trust.
    const unsigned = run(BASE, [APP_BUNDLE], { BUNDLE_ROOTS: ROOT_PEM });
    assert.notEqual(unsigned.status, 0);
    assert.match(unsigned.stderr, /unsigned/);
    assert.doesNotMatch(unsigned.stdout, /hello from a signed bundle/);

    // Signed, but by a chain this run has no reason to trust — so the runtime
    // with nothing baked into it, and nothing in the environment either.
    const untrusted = run(OPEN_BASE, [SIGNED_APP], { BUNDLE_ROOTS: '', BUNDLE_ALLOW_UNTRUSTED: '' });
    assert.notEqual(untrusted.status, 0);
    assert.match(untrusted.stderr, /valid-untrusted/);

    // Tampered with after signing: the bytes are not the signed bytes.
    const tampered = PATH.join(tmp, 'tampered.run');
    const bytes = FS.readFileSync(SIGNED_APP);
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle]! ^ 0xff) & 0xff;
    FS.writeFileSync(tampered, bytes);
    const refused = run(BASE, [tampered], { BUNDLE_ROOTS: ROOT_PEM });
    assert.notEqual(refused.status, 0);
    assert.doesNotMatch(refused.stdout, /hello from a signed bundle/);
});

test('a runtime with no policy of its own takes one from flags or the environment', needsSea, () => {
    const fromEnv = run(OPEN_BASE, [SIGNED_APP], { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);

    const fromFlag = run(OPEN_BASE, ['--root', ROOT_PEM, SIGNED_APP], { BUNDLE_ROOTS: '' });
    assert.equal(fromFlag.status, 0, fromFlag.stderr);

    // And the deliberate loosening, which is a choice the operator is allowed
    // to make when the binary was not built to forbid it.
    const allowed = run(OPEN_BASE, ['--untrusted', SIGNED_APP], { BUNDLE_ROOTS: '', BUNDLE_ALLOW_UNTRUSTED: '' });
    assert.equal(allowed.status, 0, allowed.stderr);
});

test('--verify reports on an archive without running it', needsSea, () => {
    const good = run(BASE, ['--verify', SIGNED_APP], { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /^VALID/m);
    assert.doesNotMatch(good.stdout, /hello from a signed bundle/);

    const bad = run(BASE, ['--verify', APP_BUNDLE], { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^UNSIGNED/m);
});

test('the runtime says what it is, and what it wants', needsSea, () => {
    const version = run(BASE, ['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /@pipobscure\/bundle/);

    const help = run(BASE, ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage: <runtime> \[options\] <archive>/);

    const nothing = run(BASE, []);
    assert.equal(nothing.status, 64);
    assert.match(nothing.stderr, /no archive to run/);

    const unknown = run(BASE, ['--frobnicate', SIGNED_APP]);
    assert.equal(unknown.status, 64);
    assert.match(unknown.stderr, /unknown option --frobnicate/);
});

test('a runtime built with a policy of its own takes none from its command line', needsSea, async () => {
    const sealed = executablePath(PATH.join(tmp, 'sealed-node'));
    // Deliberately relative: a policy is baked *here* and read *there*, so the
    // build has to anchor it. A binary carrying `build/certs/root.pem` would
    // refuse everything the moment it ran from anywhere else.
    await createSeaBase({
        output: sealed, sigstore: false,
        bootstrap: { roots: [PATH.relative(process.cwd(), ROOT_PEM)], sealed: true },
    });

    // The baked root is enough on its own: nothing in the environment, no flag,
    // and a working directory that knows nothing about where it was built.
    const ran = spawnSync(sealed, [SIGNED_APP],
        { encoding: 'utf-8', cwd: tmp, env: { ...process.env, BUNDLE_ROOTS: '' } });
    assert.equal(ran.status, 0, ran.stderr);

    // And the flags that would loosen it are refused rather than ignored, which
    // is the difference between a policy and a default.
    for (const flag of [['--untrusted'], ['--root', ROOT_PEM], ['--identity', 'someone']]) {
        const refused = run(sealed, [...flag, SIGNED_APP], { BUNDLE_ROOTS: '' });
        assert.equal(refused.status, 64, flag.join(' '));
        assert.match(refused.stderr, /built with a policy of its own/);
    }

    // What cannot loosen anything still works.
    const entry = run(sealed, ['--entry', 'index.js', SIGNED_APP], { BUNDLE_ROOTS: '' });
    assert.equal(entry.status, 0, entry.stderr);
    discard(sealed);
});

test('the same base becomes a self-validating executable by appending an app', needsSea, async () => {
    // The composition the two shapes share: `create --prefix` over the runtime
    // that was serving as a launcher a moment ago, then `sign`.
    const output = PATH.join(tmp, 'appended.sea');
    const unsigned = PATH.join(tmp, 'appended.run');
    await createBundle({ base: source, files: Object.keys(APP), output: unsigned, prefix: BASE });
    await signBundle({ source: unsigned, output, signer: testSigner() });

    const ran = run(output, ['appended'], { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /hello from a signed bundle/);

    // And it stops being a launcher: the archive it runs is its own.
    const ignored = run(output, [SIGNED_APP], { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.match(ignored.stdout, /hello from a signed bundle/);
    discard(output);
});

test('a worker thread runs from the application as its main thread does, verified the same way', needsSea, async () => {
    // A worker of a SEA starts with nothing mounted; the executable's preload
    // sets it up before the worker's own script — a path into the app — loads.
    const threaded = tree(tmp, {
        'package.json': '{ "name": "threaded", "type": "module", "main": "index.js" }',
        'index.js': [
            "import { Worker } from 'node:worker_threads';",
            "const worker = new Worker(new URL('./worker.js', import.meta.url));",
            "worker.on('message', (message) => console.log(JSON.stringify(message)));",
            "worker.on('error', (err) => { console.log(JSON.stringify({ error: err.message })); process.exitCode = 1; });",
        ].join('\n'),
        'worker.js': [
            "import { parentPort } from 'node:worker_threads';",
            "import { greeting } from './greet.js';",
            "const verifier = globalThis[Symbol.for('@pipobscure/bundle.plugins.verifier')];",
            "parentPort.postMessage({ greeting, from: import.meta.url, plugins: Boolean(verifier?.enforcing) });",
        ].join('\n'),
        'greet.js': "export const greeting = 'hello from a worker';",
    }, 'threaded');
    const files = ['package.json', 'index.js', 'worker.js', 'greet.js'];
    const archive = PATH.join(tmp, 'threaded.run');
    await createBundle({ base: threaded, files, output: archive });

    // A self-validating executable: the application is its own tail.
    const output = PATH.join(tmp, 'threaded.sea');
    await sealed({ app: archive, output, base: BASE, bootstrap: { roots: [ROOT_PEM] } });
    const ran = run(output);
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);
    const said = JSON.parse(ran.stdout) as { greeting: string; from: string; plugins: boolean };
    assert.equal(said.greeting, 'hello from a worker');
    assert.ok(said.from.endsWith('/worker.js') && !said.from.startsWith(pathToFileURL(tmp).href), said.from);
    assert.equal(said.plugins, true, 'plugins the worker loads are verified, as in the main thread');
    discard(output);

    // A verifying node: the application comes from its command line, which a
    // worker never sees — it gets what its main thread mounted.
    const signed = PATH.join(tmp, 'threaded.signed.nzip');
    await signBundle({ source: archive, output: signed, signer: testSigner() });
    const named = run(base!.output, [signed]);
    assert.equal(named.status, 0, named.stderr + named.stdout);
    assert.equal((JSON.parse(named.stdout) as { greeting: string }).greeting, 'hello from a worker');
});
