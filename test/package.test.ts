import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import * as CRYPTO from 'node:crypto';
import { createBundle, signBundle, verifyBundleSync, inspectBundle } from '../src/api.ts';
import { moduleFiles, packageRoot } from '../src/files.ts';
import { ROOT_PEM, SHELL_BASE, scratch, testSigner } from './helpers.ts';

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
});

test('the bin is the signed archive, not a script that runs one', () => {
    // The one entry that is a *release* artifact rather than a build output:
    // it exists after `sign:cli`, not after `build`, so this checks its shape
    // rather than its presence. `prepublishOnly` is what refuses to publish
    // without it.
    const bin = manifest.bin['bundle']!;
    assert.match(bin, /\.run$/, 'the bin should be the archive itself');
    assert.ok(!bin.startsWith('./dist/'), 'the bin should not be a compiled shim');
    assert.ok(manifest.files.includes(bin.replace(/^\.\//, '')),
        `${bin} must be in "files" or the published package has no bin`);
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

// ------------------------------------------------------------------ the bin ---

// `bin` points straight at the signed archive. There is no wrapper: the file
// npm links is the artifact, it carries a `#!` prefix that mounts itself, and
// `head -c 100` on it tells you exactly what it will do. A JavaScript shim in
// front would only be unsigned code, installed beside the thing it claimed to
// vouch for, obscuring the one file anybody should be looking at.

// A copy of the package with the signed archive beside it, which is the shape
// npm installs. `node_modules` is linked rather than copied: nothing under test
// needs it duplicated, and 60 MB of dependency tree per run is not worth it.
const INSTALLED = PATH.join(tmp, 'installed');
FS.mkdirSync(INSTALLED, { recursive: true });
FS.cpSync(PATH.join(ROOT, 'dist'), PATH.join(INSTALLED, 'dist'), { recursive: true });
FS.cpSync(PATH.join(ROOT, 'skills'), PATH.join(INSTALLED, 'skills'), { recursive: true });
FS.copyFileSync(PATH.join(ROOT, 'package.json'), PATH.join(INSTALLED, 'package.json'));
FS.symlinkSync(PATH.join(ROOT, 'node_modules'), PATH.join(INSTALLED, 'node_modules'));

const BIN = PATH.join(INSTALLED, manifest.bin['bundle']!.replace(/^\.\//, ''));

// Built on first use rather than at module scope: this file has tests
// registered before this point, and node:test starts running them while a
// top-level await is still pending — so the cleanup hook would fire while the
// archive was still being written.
let building: Promise<void> | null = null;
function bin(): Promise<void> {
    building ??= (async () => {
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
        await signBundle({ source: unsigned, output: BIN, prefix: SHELL_BASE, signer: testSigner() });
    })();
    return building;
}

test('the bin is the signed archive, and it runs itself', async () => {
    await bin();
    // Executable, because `sign --prefix` made it so — npm links it directly
    // and the kernel runs the shebang.
    assert.ok(FS.statSync(BIN).mode & 0o111, 'the bin must be executable');

    const res = spawnSync(BIN, ['--help'], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /usage: bundle <command>/);
});

test('the bin is inspectable without running it', async () => {
    await bin();
    // The whole argument for having no wrapper: what it does is legible from
    // the first hundred bytes, and the rest is a zip anybody can open.
    const head = FS.readFileSync(BIN).subarray(0, 100).toString('ascii');
    assert.match(head, /^#!/);
    assert.match(head, /--vfs-mount/);

    assert.equal(verifyBundleSync(BIN, { roots: [ROOT_PEM] }).state, 'valid');
    assert.ok(inspectBundle(BIN).members.includes('package.json'));
});

test('the CLI it runs comes out of the archive, not from the files beside it', async () => {
    await bin();
    // With the loose CLI gone, anything that still answers was served by the
    // mount — so the bin really is the archive running itself.
    const moved: [string, string][] = [];
    for (const name of ['cli.js', 'skill.js', 'main.js']) {
        const from = PATH.join(INSTALLED, 'dist', name);
        const to = PATH.join(tmp, `moved-${name}`);
        FS.renameSync(from, to);
        moved.push([to, from]);
    }
    try {
        const res = spawnSync(BIN, ['skill', '--list'], { encoding: 'utf-8' });
        assert.equal(res.status, 0, res.stderr);
        assert.match(res.stdout, /audit-bundle/);
    } finally {
        for (const [to, from] of moved) FS.renameSync(to, from);
    }
});

test('the signed bin can be verified, and run verified, by a copy you trust', async () => {
    await bin();
    // Running it by name does not check it — the kernel gives a shebang no
    // preload to carry a provider, and this package says so rather than
    // pretending otherwise. Checking it is a separate act, done with a `bundle`
    // you already trust, which is the whole chain-of-custody story.
    const checked = spawnSync(process.execPath,
        ['--no-warnings', '--experimental-vfs', PATH.join(ROOT, 'dist', 'main.js'),
            'verify', '--root', ROOT_PEM, '--json', BIN],
        { encoding: 'utf-8' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal((JSON.parse(checked.stdout) as { state: string }).state, 'valid');

    // ...and `run` mounts it through the verifying provider, which is how you
    // execute it with the check actually applied.
    const ran = spawnSync(process.execPath,
        ['--no-warnings', '--experimental-vfs', PATH.join(ROOT, 'dist', 'main.js'),
            'run', '--root', ROOT_PEM, BIN, '--', '--help'],
        { encoding: 'utf-8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /usage: bundle <command>/);
});

test('a tampered bin is refused by the verifying mount', async () => {
    await bin();
    const kept = FS.readFileSync(BIN);
    try {
        const bytes = Buffer.from(kept);
        const digest = CRYPTO.createHash('sha256').update(FS.readFileSync(PATH.join(ROOT, 'package.json'))).digest('hex');
        const at = bytes.indexOf(digest, 0, 'ascii');
        assert.notEqual(at, -1, 'expected the member digest in the central directory');
        bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61;
        FS.writeFileSync(BIN, bytes);

        assert.equal(verifyBundleSync(BIN, { roots: [ROOT_PEM] }).state, 'invalid');
        const ran = spawnSync(process.execPath,
            ['--no-warnings', '--experimental-vfs', PATH.join(ROOT, 'dist', 'main.js'),
                'run', '--root', ROOT_PEM, BIN],
            { encoding: 'utf-8' });
        assert.notEqual(ran.status, 0);
        assert.match(ran.stderr, /refusing to run/);
    } finally {
        FS.writeFileSync(BIN, kept);
        FS.chmodSync(BIN, 0o755);
    }
});
