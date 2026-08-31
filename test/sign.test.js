import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { bundle, rebundle, keySigner, members } from '../lib/archive.js';
import { verifySync, parseSignature, formatSignature, AUTHORITY } from '../lib/manifest.js';

// Signing as a separate step from building. The point of the split is that one
// unsigned archive is the source for every shipped shape, so most of what is
// checked here is that re-emitting behind a different prefix produces a
// correctly offset archive that still verifies over its own finished bytes.

const ROOT = PATH.resolve(import.meta.dirname, '..');
const CERTS = PATH.join(ROOT, 'certs');
const APP_JS = PATH.join(ROOT, 'lib', 'app.js');
const ROOT_PEM = PATH.join(CERTS, 'root.pem');

const key = FS.readFileSync(PATH.join(CERTS, 'leaf.key'));
const chain = FS.readFileSync(PATH.join(CERTS, 'chain.pem'), 'utf-8');
const roots = [FS.readFileSync(ROOT_PEM, 'utf-8')];

const APP = {
    'package.json': '{ "name": "demo", "type": "module", "main": "index.js" }',
    'index.js': "import { tag } from './sub/tag.js';\nconsole.log(`signed ${tag}`);\n",
    'sub/tag.js': "export const tag = '[sub]';",
};

const tmp = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'bundle-sign-'));
const source = PATH.join(tmp, 'app');
for (const [name, content] of Object.entries(APP)) {
    const file = PATH.join(source, name);
    FS.mkdirSync(PATH.dirname(file), { recursive: true });
    FS.writeFileSync(file, content);
}

// An unsigned archive of APP — the artifact `sign` consumes.
const UNSIGNED = await (async () => {
    const output = PATH.join(tmp, 'app.bundle');
    const out = FS.createWriteStream(output);
    await bundle({ base: source, files: Object.keys(APP), out });
    await new Promise((resolve, reject) => out.on('error', reject).on('finish', resolve).end());
    return output;
})();

async function sign(output, options = {}) {
    const out = FS.createWriteStream(output);
    const res = await rebundle({
        source: UNSIGNED, signer: keySigner({ key, chain }), out, ...options,
    });
    await new Promise((resolve, reject) => out.on('error', reject).on('finish', resolve).end());
    return res;
}

test('the archive `sign` consumes is itself unsigned', () => {
    assert.equal(verifySync(UNSIGNED, { extraRoots: roots }).state, 'unsigned');
});

test('signing an unsigned archive produces a valid one', async () => {
    const output = PATH.join(tmp, 'plain.bundle');
    const res = await sign(output);
    assert.equal(res.signed, true);
    assert.match(res.hash, /^[0-9a-f]{64}$/);

    const check = verifySync(output, { extraRoots: roots });
    assert.equal(check.state, 'valid');
    assert.match(check.subject, /Bundle Test Signer/);
    assert.equal(check.digests.size, Object.keys(APP).length);
});

test('signing leaves the input archive untouched', async () => {
    const before = FS.readFileSync(UNSIGNED);
    await sign(PATH.join(tmp, 'untouched.bundle'));
    assert.deepEqual(FS.readFileSync(UNSIGNED), before);
    assert.equal(verifySync(UNSIGNED).state, 'unsigned');
});

test('one unsigned archive yields every prefixed shape, each valid', async () => {
    // Two prefixes of different lengths: the central directory's offsets are
    // absolute, so if they were not recomputed per prefix the longer one would
    // produce an archive that does not parse at all.
    const short = PATH.join(tmp, 'short-prefix');
    const long = PATH.join(tmp, 'long-prefix');
    FS.writeFileSync(short, '#!/bin/false\n');
    FS.writeFileSync(long, `#!/bin/false\n${'/* padding */\n'.repeat(500)}`);

    const bare = PATH.join(tmp, 'bare.bundle');
    const withShort = PATH.join(tmp, 'short.run');
    const withLong = PATH.join(tmp, 'long.run');
    await sign(bare);
    await sign(withShort, { prefix: short });
    await sign(withLong, { prefix: long });

    for (const [label, file] of [['bare', bare], ['short', withShort], ['long', withLong]]) {
        assert.equal(verifySync(file, { extraRoots: roots }).state, 'valid', label);
        assert.deepEqual(members(file).sort(), Object.keys(APP).sort(), label);
    }

    // Each is signed over its own bytes, so no two share a hash.
    const hashes = [bare, withShort, withLong].map((f) => parseSignature(comment(f)).hash);
    assert.equal(new Set(hashes).size, 3);

    // The prefix survives byte-for-byte, which is what makes it runnable.
    assert.deepEqual(FS.readFileSync(withLong).subarray(0, FS.statSync(long).size), FS.readFileSync(long));
});

test('a signed archive can be re-signed behind a new prefix', async () => {
    const first = PATH.join(tmp, 'first.bundle');
    const second = PATH.join(tmp, 'second.run');
    const prefix = PATH.join(tmp, 'reprefix');
    FS.writeFileSync(prefix, '#!/bin/false\n');
    await sign(first);

    const out = FS.createWriteStream(second);
    await rebundle({ source: first, prefix, signer: keySigner({ key, chain }), out });
    await new Promise((resolve, reject) => out.on('error', reject).on('finish', resolve).end());

    assert.equal(verifySync(second, { extraRoots: roots }).state, 'valid');
    // The old AUTHORITY.PEM described the archive it came from; a re-emitted
    // archive gets exactly one, freshly built.
    const zip = ZLIB.ZipFile.openSync(second);
    try {
        const names = [...zip.entriesSync()].map(([name]) => name);
        assert.equal(names.filter((n) => n === AUTHORITY).length, 1);
    } finally {
        zip.closeSync();
    }
});

test('an archive signed through the CLI verifies and runs', () => {
    const output = PATH.join(tmp, 'cli.run');
    const prefix = PATH.join(ROOT, 'shell-base');
    const signed = spawnSync(process.execPath, [
        APP_JS, 'sign', '--key', PATH.join(CERTS, 'leaf.key'), '--chain', PATH.join(CERTS, 'chain.pem'),
        '--prefix', prefix, '--output', output, UNSIGNED,
    ], { encoding: 'utf-8' });
    assert.equal(signed.status, 0, signed.stderr);

    const checked = spawnSync(process.execPath,
        [APP_JS, 'verify', '--root', ROOT_PEM, output], { encoding: 'utf-8' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /^VALID/);

    // A prefixed output is made executable, and the prefix is a working shebang.
    assert.ok(FS.statSync(output).mode & 0o111);
    const ran = spawnSync(output, [], { encoding: 'utf-8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /signed \[sub\]/);
});

test('the CLI refuses to write over the archive it is signing', () => {
    const res = spawnSync(process.execPath, [
        APP_JS, 'sign', '--key', PATH.join(CERTS, 'leaf.key'), '--chain', PATH.join(CERTS, 'chain.pem'),
        '--output', UNSIGNED, UNSIGNED,
    ], { encoding: 'utf-8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /must differ from the input/);
});

test('the signature marker round-trips, and old two-field markers still parse', () => {
    const hash = 'ab'.repeat(32);
    const sig = 'cd'.repeat(35);

    // The form every archive written before the field grammar existed carries.
    const plain = parseSignature(`SIGNED:${hash}:${sig}`);
    assert.equal(plain.hash, hash);
    assert.equal(plain.sig, sig);
    assert.equal(plain.fields.size, 0);

    // Base64 is safe in a field value: it has no ':'.
    const payload = Buffer.from('{"a":1}').toString('base64');
    const marker = formatSignature({ hash, sig, fields: { SIGSTORE: payload } });
    assert.equal(marker, `SIGNED:${hash}:${sig}:SIGSTORE=${payload}`);

    const parsed = parseSignature(marker);
    assert.equal(parsed.hash, hash);
    assert.equal(parsed.fields.get('SIGSTORE'), payload);

    // Empty and absent fields are simply left out.
    assert.equal(formatSignature({ hash, sig, fields: { A: '', B: undefined } }), `SIGNED:${hash}:${sig}`);
    // A value carrying the delimiter would make the marker ambiguous.
    assert.throws(() => formatSignature({ hash, sig, fields: { A: 'x:y' } }), /may not contain/);
    // Anything that is not a marker at all is not a signature.
    assert.equal(parseSignature('hello'), null);
    assert.equal(parseSignature(''), null);
});

test('an unverifiable sigstore field is never reported as valid', async () => {
    const output = PATH.join(tmp, 'faked.bundle');
    await sign(output);

    // Graft a bogus sigstore bundle onto an otherwise perfectly good archive.
    // The signature and every digest still check out; only the claim about
    // *who* signed it is fabricated, and that must not pass.
    const bytes = FS.readFileSync(output);
    const marker = parseSignature(comment(output));
    const forged = Buffer.from(formatSignature({
        hash: marker.hash,
        sig: marker.sig,
        fields: { SIGSTORE: Buffer.from('{"not":"a bundle"}').toString('base64') },
    }), 'ascii');

    const head = bytes.subarray(0, bytes.length - commentLength(bytes) - 2);
    const length = Buffer.alloc(2);
    length.writeUInt16LE(forged.length, 0);
    FS.writeFileSync(output, Buffer.concat([head, length, forged]));

    const res = verifySync(output, { extraRoots: roots });
    assert.notEqual(res.state, 'valid');
    assert.ok(res.sigstore, 'the sigstore path should have been taken');
});

// The EOCD comment of `file`. The record is the last thing in the file, and its
// comment runs to EOF, so both are a fixed offset from the end.
function comment(file) {
    const bytes = FS.readFileSync(file);
    return bytes.subarray(bytes.length - commentLength(bytes)).toString('ascii');
}

function commentLength(bytes) {
    for (let pos = bytes.length - 22; pos >= 0; pos--) {
        if (bytes.readUInt32LE(pos) !== 0x06054b50) continue;
        if (pos + 22 + bytes.readUInt16LE(pos + 20) !== bytes.length) continue;
        return bytes.readUInt16LE(pos + 20);
    }
    throw new Error('no end of central directory record found');
}

test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));
