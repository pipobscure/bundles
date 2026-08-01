import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { bundle } from '../lib/archive.js';
import { verifySync } from '../lib/manifest.js';
import { NappProvider, open as openNapp } from '../lib/provider.js';

// These tests need `node:vfs`, so the suite runs under --experimental-vfs (see
// the `test` script). They sign with the repository's own test PKI in certs/.

const ROOT = PATH.resolve(import.meta.dirname, '..');
const CERTS = PATH.join(ROOT, 'certs');
const REGISTER = PATH.join(ROOT, 'lib', 'register.cjs');
const ROOT_PEM = PATH.join(CERTS, 'root.pem');

const key = FS.readFileSync(PATH.join(CERTS, 'leaf.key'));
const chain = FS.readFileSync(PATH.join(CERTS, 'chain.pem'), 'utf-8');

// A small multi-file application, so mounting has to resolve a bare entry
// point, a sibling import and one in a subdirectory through the provider.
const APP = {
    'package.json': '{ "name": "demo", "type": "module", "main": "index.js" }',
    'index.js': [
        "import { greeting } from './greet.js';",
        "import { tag } from './sub/tag.js';",
        'console.log(`${greeting} ${tag} ${process.argv.slice(2).join(",")}`);',
    ].join('\n'),
    'greet.js': "export const greeting = 'hello from a signed napp';",
    'sub/tag.js': "export const tag = '[sub]';",
};

const tmp = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'napp-test-'));
const source = PATH.join(tmp, 'app');
for (const [name, content] of Object.entries(APP)) {
    const file = PATH.join(source, name);
    FS.mkdirSync(PATH.dirname(file), { recursive: true });
    FS.writeFileSync(file, content);
}

// Writes an archive over APP's files. Signed unless `signed` is false.
async function build(output, { signed = true } = {}) {
    const out = FS.createWriteStream(output);
    await bundle({
        base: source,
        files: Object.keys(APP),
        key: signed ? key : undefined,
        chain: signed ? chain : undefined,
        out,
    });
    await new Promise((resolve, reject) => out.on('error', reject).on('finish', resolve).end());
    return output;
}

const MOUNT = (target) => ['--vfs-load', '--vfs-mount', target];

// Runs `target` the way a mount does, with the provider preloaded.
function run(target, { roots = [ROOT_PEM], args = [], allowUntrusted = false } = {}) {
    const env = { ...process.env };
    delete env.NAPP_ROOTS;
    delete env.NAPP_ALLOW_UNTRUSTED;
    if (roots.length) env.NAPP_ROOTS = roots.join(PATH.delimiter);
    if (allowUntrusted) env.NAPP_ALLOW_UNTRUSTED = '1';
    return spawnSync(process.execPath,
        ['--no-warnings', '--experimental-vfs', '-r', REGISTER, ...MOUNT(target), ...args],
        { encoding: 'utf-8', env });
}

// A plain ZIP carrying none of our metadata.
async function plainZip(output) {
    const entries = [];
    for (const [name, content] of Object.entries(APP)) {
        entries.push(await ZLIB.ZipEntry.create(name, Buffer.from(content)));
    }
    const chunks = [];
    for await (const chunk of ZLIB.createZipArchive(entries)) chunks.push(chunk);
    FS.writeFileSync(output, Buffer.concat(chunks));
    return output;
}

test('a signed archive verifies as valid and trusted against its root', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    const res = verifySync(napp, { extraRoots: [FS.readFileSync(ROOT_PEM, 'utf-8')] });
    assert.equal(res.state, 'valid');
    assert.equal(res.trusted, true);
    assert.match(res.subject, /SEA Test Signer/);
    assert.equal(res.digests.size, Object.keys(APP).length);
});

test('an untrusted root leaves a good signature valid but unanchored', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    const res = verifySync(napp, { extraRoots: [] });
    assert.equal(res.state, 'valid-untrusted');
    assert.equal(res.signed, true);
    assert.equal(res.trusted, false);
});

test('a trusted archive mounts through --vfs and runs', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    const res = run(napp, { args: ['one', 'two'] });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from a signed napp \[sub\] one,two/);
});

test('an archive whose chain is not anchored is refused', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    const res = run(napp, { roots: [] });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /ERR_NAPP_UNTRUSTED/);
    assert.match(res.stderr, /valid-untrusted/);
    assert.doesNotMatch(res.stdout, /hello from a signed napp/);
});

test('an unanchored chain runs only when untrusted archives are allowed', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    const res = run(napp, { roots: [], allowUntrusted: true });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from a signed napp/);
});

test('tampering with a signed archive is caught before it mounts', async () => {
    const napp = await build(PATH.join(tmp, 'tampered.napp'));

    // Flip one character of a member's recorded digest. It lives in the
    // central directory as plain ASCII hex, so the archive stays structurally
    // intact - but it is inside the region the whole-file hash covers.
    const bytes = FS.readFileSync(napp);
    const digest = CRYPTO.createHash('sha256').update(APP['greet.js']).digest('hex');
    const at = bytes.indexOf(digest, 0, 'ascii');
    assert.notEqual(at, -1, 'expected the member digest to appear in the central directory');
    bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61; // 'a' <-> 'b'
    FS.writeFileSync(napp, bytes);

    const res = verifySync(napp, { extraRoots: [FS.readFileSync(ROOT_PEM, 'utf-8')] });
    assert.equal(res.state, 'invalid');
    assert.match(res.reason, /hash does not match/);

    const run1 = run(napp);
    assert.notEqual(run1.status, 0);
    assert.match(run1.stderr, /ERR_NAPP_UNTRUSTED/);
});

test('an unsigned archive named .napp is refused', async () => {
    const napp = await build(PATH.join(tmp, 'unsigned.napp'), { signed: false });
    assert.equal(verifySync(napp).state, 'unsigned');

    const res = run(napp);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unsigned/);
});

test('a plain ZIP named .napp is claimed by extension and refused', async () => {
    const zip = await plainZip(PATH.join(tmp, 'plain.napp'));
    const res = run(zip);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /ERR_NAPP_UNTRUSTED/);
});

test('a plain ZIP under any other name is left to the built-in provider', async () => {
    const zip = await plainZip(PATH.join(tmp, 'plain.zip'));
    const res = run(zip);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from a signed napp/);
});

test('member content is checked against its digest when it is read', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    const archive = ZLIB.ZipFile.openSync(napp);
    try {
        const digests = new Map(Object.keys(APP).map((name) => [
            name, CRYPTO.createHash('sha256').update(APP[name]).digest('hex'),
        ]));

        // Matching digests: the content is served.
        const honest = new NappProvider(archive, { hashAlg: 'sha256', digests });
        assert.equal(honest.readFileSync('/greet.js').toString(), APP['greet.js']);
        assert.equal(honest.readFileSync('/sub/tag.js').toString(), APP['sub/tag.js']);

        // A digest that does not describe the member: the fetch fails rather
        // than handing the content over. This is what stands between a program
        // and an archive rewritten underneath it after it was mounted.
        digests.set('greet.js', '0'.repeat(64));
        const lying = new NappProvider(archive, { hashAlg: 'sha256', digests });
        assert.throws(() => lying.readFileSync('/greet.js'), { code: 'ERR_NAPP_INTEGRITY' });
        assert.throws(() => lying.openSync('/greet.js', 'r'), { code: 'ERR_NAPP_INTEGRITY' });
    } finally {
        archive.closeSync();
    }
});

test('a mounted archive is read-only and reports missing members as ENOENT', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    const provider = openNapp(napp, { roots: [ROOT_PEM] });
    try {
        assert.equal(provider.readonly, true);
        assert.throws(() => provider.writeFileSync('/greet.js', 'nope'), { code: 'EROFS' });
        assert.throws(() => provider.openSync('/nothing.js', 'r'), { code: 'ENOENT' });
        assert.deepEqual(provider.readdirSync('/sub'), ['tag.js']);
        assert.equal(provider.readFileSync('/greet.js').toString(), APP['greet.js']);
    } finally {
        provider.closeSync();
    }
});

test('mounting refuses an archive whose chain is not anchored', async () => {
    const napp = await build(PATH.join(tmp, 'good.napp'));
    assert.throws(() => openNapp(napp, { roots: [] }), { code: 'ERR_NAPP_UNTRUSTED' });
});

test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));
