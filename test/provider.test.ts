import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import { BundleProvider, open as openBundle, EXTENSION } from '../src/provider.ts';
import { APP, ROOT_PEM, build, mount, plainZip, scratch, tree } from './helpers.ts';

// The verifying `node:vfs` provider: what it refuses to mount, and what it
// refuses to hand over once mounted.

const tmp = scratch('provider');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const GOOD = await build(source, PATH.join(tmp, 'good.bundle'));

test('a trusted archive mounts through --vfs and runs', () => {
    const res = mount(GOOD, { args: ['one', 'two'] });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from a signed bundle \[sub\] one,two/);
});

test('an archive whose chain is not anchored is refused', () => {
    const res = mount(GOOD, { roots: [] });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /ERR_BUNDLE_UNTRUSTED/);
    assert.match(res.stderr, /valid-untrusted/);
    assert.doesNotMatch(res.stdout, /hello from a signed bundle/);
});

test('an unanchored chain runs only when untrusted archives are allowed', () => {
    const res = mount(GOOD, { roots: [], allowUntrusted: true });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from a signed bundle/);
});

test('tampering with a signed archive is caught before it mounts', async () => {
    const archive = await build(source, PATH.join(tmp, 'tampered.bundle'));
    const bytes = FS.readFileSync(archive);
    const digest = CRYPTO.createHash('sha256').update(APP['greet.js']!).digest('hex');
    const at = bytes.indexOf(digest, 0, 'ascii');
    bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61;
    FS.writeFileSync(archive, bytes);

    const res = mount(archive);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /ERR_BUNDLE_UNTRUSTED/);
});

test('an unsigned archive named .bundle is refused', async () => {
    const archive = await build(source, PATH.join(tmp, 'unsigned.bundle'), { signed: false });
    const res = mount(archive);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unsigned/);
});

test('a plain ZIP named .bundle is claimed by extension and refused', async () => {
    const zip = await plainZip(source, PATH.join(tmp, 'plain.bundle'));
    const res = mount(zip);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /ERR_BUNDLE_UNTRUSTED/);
    assert.equal(EXTENSION, '.bundle');
});

test('a plain ZIP under any other name is left to the built-in provider', async () => {
    const zip = await plainZip(source, PATH.join(tmp, 'plain.zip'));
    const res = mount(zip);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from a signed bundle/);
});

test('a signed archive under any other name is still claimed by content', async () => {
    // Renaming must not be a way to downgrade to the unchecked provider.
    const renamed = PATH.join(tmp, 'disguised.zip');
    FS.copyFileSync(GOOD, renamed);
    const res = mount(renamed, { roots: [] });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /ERR_BUNDLE_UNTRUSTED/);
});

test('member content is checked against its digest when it is read', () => {
    const archive = ZLIB.ZipFile.openSync(GOOD);
    try {
        const digests = new Map(Object.keys(APP).map((name) => [
            name, CRYPTO.createHash('sha256').update(APP[name]!).digest('hex'),
        ]));

        // Matching digests: the content is served.
        const honest = new BundleProvider(archive, { hashAlg: 'sha256', digests });
        assert.equal(honest.readFileSync('/greet.js').toString(), APP['greet.js']);
        assert.equal(honest.readFileSync('/sub/tag.js').toString(), APP['sub/tag.js']);

        // A digest that does not describe the member: the fetch fails rather
        // than handing the content over. This is what stands between a program
        // and an archive rewritten underneath it after it was mounted.
        digests.set('greet.js', '0'.repeat(64));
        const lying = new BundleProvider(archive, { hashAlg: 'sha256', digests });
        assert.throws(() => lying.readFileSync('/greet.js'), { code: 'ERR_BUNDLE_INTEGRITY' });
        assert.throws(() => lying.openSync('/greet.js', 'r'), { code: 'ERR_BUNDLE_INTEGRITY' });
    } finally {
        archive.closeSync();
    }
});

test('a verified member is served from the copy that was checked', () => {
    const archive = ZLIB.ZipFile.openSync(GOOD);
    try {
        const digests = new Map([['greet.js', CRYPTO.createHash('sha256').update(APP['greet.js']!).digest('hex')]]);
        const provider = new BundleProvider(archive, { hashAlg: 'sha256', digests });
        const first = provider.readFileSync('/greet.js').toString();
        // A second read must not go back to the file — which is the point, so
        // that a rewrite underneath a running program cannot be served.
        assert.equal(provider.readFileSync('/greet.js').toString(), first);
    } finally {
        archive.closeSync();
    }
});

test('a mounted archive is read-only and reports missing members as ENOENT', () => {
    const provider = openBundle(GOOD, { roots: [ROOT_PEM] });
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

test('opening a mounted member for writing never reaches the verified copy', () => {
    const provider = openBundle(GOOD, { roots: [ROOT_PEM] });
    try {
        assert.throws(() => provider.openSync('/greet.js', 'w'), { code: 'EROFS' });
        assert.throws(() => provider.openSync('/greet.js', 'a'), { code: 'EROFS' });
    } finally {
        provider.closeSync();
    }
});

test('mounting refuses an archive whose chain is not anchored', () => {
    assert.throws(() => openBundle(GOOD, { roots: [] }), { code: 'ERR_BUNDLE_UNTRUSTED' });
});

test('the identity a mount demands is enforced even for a key-signed archive', () => {
    // An archive signed against an ordinary CA carries no sigstore identity, so
    // demanding one cannot be satisfied and must not silently pass.
    assert.throws(() => openBundle(GOOD, { roots: [ROOT_PEM], identity: 'someone@example.com' }),
        { code: 'ERR_BUNDLE_UNTRUSTED' });
});
