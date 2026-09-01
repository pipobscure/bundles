import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { bundle, rebundle, keySigner, members, fromDirectory, createArchive } from '../src/archive.ts';
import { AUTHORITY, parseSignature, verifySync } from '../src/manifest.ts';
import { APP, chain, comment, key, rootPem, scratch, tree } from './helpers.ts';

// Signing as a separate step from building. The point of the split is that one
// unsigned archive is the source for every shipped shape, so most of what is
// checked here is that re-emitting behind a different prefix produces a
// correctly offset archive that still verifies over its own finished bytes.

const tmp = scratch('archive');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const roots = [rootPem];

async function write(output: string, run: (out: FS.WriteStream) => Promise<unknown>) {
    const out = FS.createWriteStream(output);
    const res = await run(out);
    await new Promise<void>((resolve, reject) => { out.on('error', reject).on('finish', () => resolve()).end(); });
    return res;
}

// The unsigned archive every signing test consumes.
const UNSIGNED = PATH.join(tmp, 'app.bundle');
await write(UNSIGNED, (out) => bundle({ base: source, files: Object.keys(APP), out }));

function sign(output: string, options: Record<string, unknown> = {}) {
    return write(output, (out) => rebundle({
        source: UNSIGNED, signer: keySigner({ key, chain }), out, ...options,
    })) as Promise<{ hash: string | null; signed: boolean }>;
}

test('the archive `sign` consumes is itself unsigned', () => {
    assert.equal(verifySync(UNSIGNED, { extraRoots: roots }).state, 'unsigned');
});

test('signing an unsigned archive produces a valid one', async () => {
    const output = PATH.join(tmp, 'plain.bundle');
    const res = await sign(output);
    assert.equal(res.signed, true);
    assert.match(res.hash!, /^[0-9a-f]{64}$/);

    const check = verifySync(output, { extraRoots: roots });
    assert.equal(check.state, 'valid');
    assert.match(check.subject!, /Bundle Test Signer/);
    assert.equal(check.digests?.size, Object.keys(APP).length);
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

    for (const [label, file] of [['bare', bare], ['short', withShort], ['long', withLong]] as const) {
        assert.equal(verifySync(file, { extraRoots: roots }).state, 'valid', label);
        assert.deepEqual(members(file).sort(), Object.keys(APP).sort(), label);
    }

    // Each is signed over its own bytes, so no two share a hash.
    const hashes = [bare, withShort, withLong].map((f) => parseSignature(comment(f))!.hash);
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

    await write(second, (out) => rebundle({ source: first, prefix, signer: keySigner({ key, chain }), out }));

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

test('member digests are recorded in the entry comments, one per member', async () => {
    const output = PATH.join(tmp, 'digests.bundle');
    await sign(output);
    const zip = ZLIB.ZipFile.openSync(output);
    try {
        for (const [name, entry] of zip.entriesSync()) {
            if (name === AUTHORITY) {
                assert.equal(entry.comment, '', 'the manifest carries no digest of its own');
                continue;
            }
            assert.match(entry.comment, /^[0-9a-f]{64}$/, name);
        }
    } finally {
        zip.closeSync();
    }
});

test('a different hash algorithm is honoured end to end', async () => {
    const output = PATH.join(tmp, 'sha512.bundle');
    await sign(output, { hashAlg: 'sha512', signAlg: 'sha512', signer: keySigner({ key, chain, signAlg: 'sha512' }) });
    const res = verifySync(output, { extraRoots: roots });
    assert.equal(res.state, 'valid');
    assert.equal(res.hashAlg, 'sha512');
    assert.equal(parseSignature(comment(output))!.hash.length, 128);
});

test('an archive with no members is refused rather than signed', async () => {
    const empty = PATH.join(tmp, 'empty.bundle');
    await write(empty, (out) => bundle({ base: source, files: [], out }));
    await assert.rejects(() => sign(PATH.join(tmp, 'nope.bundle'), { source: empty }), /no members to sign/);
});

test('createArchive can be driven from members that never touched a disk', async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of createArchive({
        members: [{ name: 'a.txt', data: Buffer.from('hello'), mode: 0o444 }],
    })) chunks.push(chunk);
    const zip = new ZLIB.ZipBuffer(Buffer.concat(chunks));
    assert.deepEqual([...zip.keys()].sort(), ['AUTHORITY.PEM', 'a.txt']);
    assert.equal(zip.get('a.txt').contentSync().toString(), 'hello');
});

test('fromDirectory reads exactly the files it was given, in order', async () => {
    const seen: string[] = [];
    for await (const member of fromDirectory(source, ['index.js', 'greet.js'])) seen.push(member.name);
    assert.deepEqual(seen, ['index.js', 'greet.js']);
});
