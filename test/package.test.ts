import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import * as CRYPTO from 'node:crypto';
import { createBundle, signBundle, verifyBundleSync } from '../src/api.ts';
import { moduleFiles, packageRoot } from '../src/files.ts';
import { ROOT_PEM, scratch, testSigner } from './helpers.ts';

// The package as it is published: the exports map, and the `bundle` command npm
// installs — which is a launcher for this package's own signed CLI rather than
// the CLI itself.

const ROOT = packageRoot();
const manifest = JSON.parse(FS.readFileSync(PATH.join(ROOT, 'package.json'), 'utf-8')) as {
    main: string; types: string; bin: Record<string, string>;
    exports: Record<string, string>; files: string[];
};

const tmp = scratch('package');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

test('every entry in the exports map points at a file that is there', () => {
    for (const [name, target] of Object.entries(manifest.exports)) {
        assert.ok(FS.existsSync(PATH.join(ROOT, target)), `${name} -> ${target}`);
    }
    assert.ok(FS.existsSync(PATH.join(ROOT, manifest.main)), manifest.main);
    assert.ok(FS.existsSync(PATH.join(ROOT, manifest.types)), manifest.types);
    assert.ok(FS.existsSync(PATH.join(ROOT, manifest.bin['bundle']!)), manifest.bin['bundle']!);
});

test('the four things the package is for each have an entry point', async () => {
    // 1. Driving everything from code.
    const api = await import(PATH.join(ROOT, manifest.exports['.']!));
    for (const name of ['createBundle', 'signBundle', 'verifyBundle', 'runBundle', 'inspectBundle']) {
        assert.equal(typeof api[name], 'function', name);
    }
    // 2. A hook that records what a run reads, to build a manifest from.
    const recorder = await import(PATH.join(ROOT, manifest.exports['./recorder']!));
    assert.equal(typeof recorder.register, 'function');
    assert.equal(typeof recorder.recording, 'function');
    // 3. A hook that validates an archive when it is mounted.
    const provider = await import(PATH.join(ROOT, manifest.exports['./provider']!));
    assert.equal(typeof provider.register, 'function');
    assert.equal(typeof provider.open, 'function');
    // 4. Building a self-validating executable.
    const sea = await import(PATH.join(ROOT, manifest.exports['./sea']!));
    assert.equal(typeof sea.bootstrap, 'function');
    assert.equal(typeof sea.buildSea, 'function');
});

test('the preloads register a provider and nothing else', () => {
    for (const name of ['./register', './record'] as const) {
        const preload = PATH.join(ROOT, manifest.exports[name]!);
        const res = spawnSync(process.execPath,
            ['--no-warnings', '--experimental-vfs', '-r', preload, '-e', 'console.log("ok")'],
            { encoding: 'utf-8', env: { ...process.env, BUNDLE_MANIFEST: PATH.join(tmp, 'preload.manifest') } });
        assert.equal(res.status, 0, `${name}: ${res.stderr}`);
        assert.match(res.stdout, /^ok$/m);
    }
});

test('a preload says what is missing when node:vfs is not there', () => {
    const preload = PATH.join(ROOT, manifest.exports['./register']!);
    const res = spawnSync(process.execPath, ['--no-warnings', '-r', preload, '-e', ''], { encoding: 'utf-8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--experimental-vfs/);
});

test('the package root export does not need --experimental-vfs to import', () => {
    // Creating and verifying an archive is not a mount, and must not drag the
    // flag in — which is why the two providers have their own entry points.
    const res = spawnSync(process.execPath, [
        '--no-warnings', '--input-type=module',
        '-e', `import * as B from ${JSON.stringify(PATH.join(ROOT, manifest.exports['.']!))};
               console.log(typeof B.createBundle);`,
    ], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^function$/m);
});

test('the published file list carries everything the exports map points at', () => {
    for (const target of [...Object.values(manifest.exports), manifest.main, manifest.bin['bundle']!]) {
        const top = target.replace(/^\.\//, '').split('/')[0]!;
        // npm always ships package.json; everything else has to be asked for.
        if (top === 'package.json') continue;
        assert.ok(
            manifest.files.some((entry) => entry.replace(/\/$/, '') === top),
            `${target} is not covered by "files": ${manifest.files.join(', ')}`,
        );
    }
});

// --------------------------------------------------------------- the launcher ---

// A copy of the package with a signed CLI archive beside it, which is the shape
// npm installs. `node_modules` is linked rather than copied: the launcher only
// has to find it, and 60 MB of dependency tree per test is not worth the disk.
const INSTALLED = PATH.join(tmp, 'installed');
FS.mkdirSync(INSTALLED, { recursive: true });
FS.cpSync(PATH.join(ROOT, 'dist'), PATH.join(INSTALLED, 'dist'), { recursive: true });
FS.cpSync(PATH.join(ROOT, 'skills'), PATH.join(INSTALLED, 'skills'), { recursive: true });
FS.copyFileSync(PATH.join(ROOT, 'package.json'), PATH.join(INSTALLED, 'package.json'));
FS.symlinkSync(PATH.join(ROOT, 'node_modules'), PATH.join(INSTALLED, 'node_modules'));

const LAUNCHER = PATH.join(INSTALLED, 'dist', 'bin.js');
const ARCHIVE = PATH.join(INSTALLED, 'bundle.bundle');

function launch(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ['--no-warnings', '--experimental-vfs', LAUNCHER, ...args],
        { encoding: 'utf-8', env: { ...process.env, ...env } });
}

test('with no signed CLI beside it, the launcher runs the CLI in place', () => {
    assert.ok(!FS.existsSync(ARCHIVE));
    const res = launch(['--help']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /usage: bundle <command>/);
});

test('with a signed CLI beside it, the launcher verifies and mounts that instead', async () => {
    const unsigned = PATH.join(tmp, 'cli.bundle');
    await createBundle({
        base: ROOT,
        files: moduleFiles({
            base: ROOT,
            files: ['package.json'],
            dirs: ['dist', 'skills'],
            dependencies: ['@sigstore/bundle', '@sigstore/sign', '@sigstore/verify', '@sigstore/protobuf-specs', '@sigstore/tuf'],
            filter: (name) => !name.endsWith('.map') && !name.endsWith('.d.ts') && !name.endsWith('.d.cts'),
        }),
        output: unsigned,
    });
    await signBundle({ source: unsigned, output: ARCHIVE, signer: testSigner() });
    assert.equal(verifyBundleSync(ARCHIVE, { roots: [ROOT_PEM] }).state, 'valid');

    const res = launch(['--help'], { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /usage: bundle <command>/);

    // The mounted CLI is a working CLI, not just a help string.
    const verified = launch(['verify', '--root', ROOT_PEM, '--json', ARCHIVE], { BUNDLE_ROOTS: ROOT_PEM });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal((JSON.parse(verified.stdout) as { state: string }).state, 'valid');
});

test('an unanchored signature warns and runs, or refuses under BUNDLE_STRICT', () => {
    const lenient = launch(['--help'], { BUNDLE_ROOTS: '', BUNDLE_STRICT: '' });
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stderr, /warning:/);
    assert.match(lenient.stdout, /usage: bundle <command>/);

    const strict = launch(['--help'], { BUNDLE_ROOTS: '', BUNDLE_STRICT: '1' });
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /refusing to run its own CLI/);
});

test('a tampered signed CLI is refused outright, however it is configured', () => {
    // Members are compressed, so the readable thing to change is a member's
    // recorded digest: plain ASCII hex in the central directory, structurally
    // harmless, and inside the region the whole-file hash covers.
    const bytes = FS.readFileSync(ARCHIVE);
    const digest = CRYPTO.createHash('sha256').update(FS.readFileSync(PATH.join(ROOT, 'package.json'))).digest('hex');
    const at = bytes.indexOf(digest, 0, 'ascii');
    assert.notEqual(at, -1, 'expected the member digest in the central directory');
    bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61; // 'a' <-> 'b'
    FS.writeFileSync(ARCHIVE, bytes);

    for (const env of [{ BUNDLE_ROOTS: ROOT_PEM }, { BUNDLE_ROOTS: '' }, { BUNDLE_STRICT: '1' }]) {
        const res = launch(['--help'], env);
        assert.notEqual(res.status, 0, JSON.stringify(env));
        assert.match(res.stderr, /refusing to run its own CLI/);
    }
});
