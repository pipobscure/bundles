import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { bundle, rebundle, reprefix, keySigner, members, prefixLength, fromDirectory, createArchive } from '../src/archive.ts';
import { AUTHORITY, parseSignature, parseUnsigned, verifySync, wholeFileHash } from '../src/manifest.ts';
import { APP, chain, comment, key, rootPem, scratch, tree } from './helpers.ts';

// Building and signing as separate steps. Building decides the archive's
// shape — the prefix in front of it — because the prefix runs, and so is part
// of what gets reviewed; signing re-emits the archive behind that same prefix,
// correctly offset, and signs its finished bytes.

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
const UNSIGNED = PATH.join(tmp, 'app.run');
await write(UNSIGNED, (out) => bundle({ base: source, files: Object.keys(APP), out }));

function sign(output: string, options: Record<string, unknown> = {}) {
    return write(output, (out) => rebundle({
        source: UNSIGNED, signer: keySigner({ key, chain }), out, ...options,
    })) as Promise<{ hash: string | null; signed: boolean }>;
}

test('the archive `sign` consumes is unsigned, and records its whole-file hash', () => {
    assert.equal(verifySync(UNSIGNED, { extraRoots: roots }).state, 'unsigned');
    assert.equal(parseUnsigned(comment(UNSIGNED)), wholeFileHash(UNSIGNED)!.hash);
    assert.equal(verifySync(UNSIGNED, { extraRoots: roots, integrity: true }).state, 'unsigned');

    // A changed byte shows, signed or not.
    const damaged = PATH.join(tmp, 'damaged.run');
    const bytes = FS.readFileSync(UNSIGNED);
    bytes[40]! ^= 1;
    FS.writeFileSync(damaged, bytes);
    const res = verifySync(damaged, { extraRoots: roots, integrity: true });
    assert.equal(res.state, 'invalid');
    assert.match(res.reason, /does not match the recorded hash/);
});

test('each shape is created with its prefix, and signing keeps it', async () => {
    // Two prefixes of different lengths: the central directory's offsets are
    // absolute, so if they were not computed for the prefix the longer one
    // would produce an archive that does not parse at all.
    const short = PATH.join(tmp, 'short-prefix');
    const long = PATH.join(tmp, 'long-prefix');
    FS.writeFileSync(short, '#!/bin/false\n');
    FS.writeFileSync(long, `#!/bin/false\n${'/* padding */\n'.repeat(500)}`);

    const shapes: [string, string | undefined][] = [['bare', undefined], ['short', short], ['long', long]];
    const signed: string[] = [];
    for (const [label, prefix] of shapes) {
        const created = PATH.join(tmp, `${label}.run`);
        await write(created, (out) => bundle({ base: source, files: Object.keys(APP), prefix, out }));
        assert.equal(prefixLength(created), prefix ? FS.statSync(prefix).size : 0, label);
        const output = PATH.join(tmp, `${label}.nzip`);
        await write(output, (out) => rebundle({ source: created, signer: keySigner({ key, chain }), out }));
        assert.equal(verifySync(output, { extraRoots: roots }).state, 'valid', label);
        assert.deepEqual(members(output).sort(), Object.keys(APP).sort(), label);
        if (prefix) assert.deepEqual(FS.readFileSync(output).subarray(0, FS.statSync(prefix).size), FS.readFileSync(prefix), label);
        signed.push(output);
    }

    // Each is signed over its own bytes, so no two share a hash.
    assert.equal(new Set(signed.map((f) => parseSignature(comment(f))!.hash)).size, 3);
});

test('a signed archive re-signs behind its own prefix, with one fresh manifest', async () => {
    const prefix = PATH.join(tmp, 'kept-prefix');
    FS.writeFileSync(prefix, '#!/bin/false\n');
    const created = PATH.join(tmp, 'kept.run');
    const first = PATH.join(tmp, 'kept.nzip');
    const second = PATH.join(tmp, 'kept.again.nzip');
    await write(created, (out) => bundle({ base: source, files: Object.keys(APP), prefix, out }));
    await write(first, (out) => rebundle({ source: created, signer: keySigner({ key, chain }), out }));
    await write(second, (out) => rebundle({ source: first, signer: keySigner({ key, chain }), out }));

    assert.equal(verifySync(second, { extraRoots: roots }).state, 'valid');
    assert.deepEqual(FS.readFileSync(second).subarray(0, FS.statSync(prefix).size), FS.readFileSync(prefix));
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

test('a prefix is found whether its offsets are absolute or relative, and can be swapped for another', async () => {
    // `cat prefix plain.zip` leaves offsets relative to the archive's start.
    const prefix = Buffer.from('#!/bin/sh\necho hi\n');
    const catted = PATH.join(tmp, 'catted.run');
    FS.writeFileSync(catted, Buffer.concat([prefix, FS.readFileSync(UNSIGNED)]));
    assert.equal(prefixLength(catted), prefix.length);
    assert.equal(prefixLength(UNSIGNED), 0);

    // Another prefix entirely: what building an executable does.
    const other = PATH.join(tmp, 'other-prefix');
    FS.writeFileSync(other, '#!/bin/false\n');
    const swapped = PATH.join(tmp, 'swapped.run');
    await write(swapped, (out) => reprefix({ source: catted, prefix: other, out }));
    assert.equal(prefixLength(swapped), FS.statSync(other).size);
    assert.equal(verifySync(swapped, { extraRoots: roots, integrity: true }).state, 'unsigned');
});

test('member digests are recorded in the entry comments, one per member', async () => {
    const output = PATH.join(tmp, 'digests.run');
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
    const output = PATH.join(tmp, 'sha512.run');
    await sign(output, { hashAlg: 'sha512', signAlg: 'sha512', signer: keySigner({ key, chain, signAlg: 'sha512' }) });
    const res = verifySync(output, { extraRoots: roots });
    assert.equal(res.state, 'valid');
    assert.equal(res.hashAlg, 'sha512');
    assert.equal(parseSignature(comment(output))!.hash.length, 128);
});

test('an archive with no members is refused rather than signed', async () => {
    const empty = PATH.join(tmp, 'empty.run');
    await write(empty, (out) => bundle({ base: source, files: [], out }));
    await assert.rejects(() => sign(PATH.join(tmp, 'nope.run'), { source: empty }), /no members to sign/);
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

test('the same files make the same archive: each member carries its file\'s time, and signing keeps them', async () => {
    const dir = tree(tmp, APP, 'reproducible');
    const files = Object.keys(APP);
    // An odd second and a fraction: more than the DOS fields hold, so the
    // extended timestamp has to carry it too.
    const times = files.map((_, i) => new Date(Date.UTC(2024, 4, 1, 12, 0, 1 + i * 2, 250)));
    files.forEach((name, i) => FS.utimesSync(PATH.join(dir, name), times[i]!, times[i]!));

    const first = PATH.join(tmp, 'reproducible-1.nzip');
    const second = PATH.join(tmp, 'reproducible-2.nzip');
    await write(first, (out) => bundle({ base: dir, files, out }));
    // Long enough that an archive dated by the clock would differ.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await write(second, (out) => bundle({ base: dir, files, out }));
    assert.deepEqual(FS.readFileSync(second), FS.readFileSync(first), 'byte for byte');

    const dated = (file: string) => {
        const zip = ZLIB.ZipFile.openSync(file);
        try {
            return Object.fromEntries([...zip.entriesSync()].map(([name, entry]) => [name, entry.modified.getTime()]));
        } finally {
            zip.closeSync();
        }
    };
    const whole = (date: Date) => Math.floor(date.getTime() / 1000) * 1000;
    const expected = Object.fromEntries(files.map((name, i) => [name, whole(times[i]!)]));
    const latest = Math.max(...Object.values(expected));
    assert.deepEqual(dated(first), { ...expected, [AUTHORITY]: latest }, 'the manifest is as new as the newest member');

    const signed = PATH.join(tmp, 'reproducible.signed.nzip');
    await write(signed, (out) => rebundle({ source: first, signer: keySigner({ key, chain }), out }));
    assert.deepEqual(dated(signed), dated(first), 'signing keeps every time');

    // A checkout dates every file now; SOURCE_DATE_EPOCH says when the source is from.
    const now = new Date();
    files.forEach((name) => FS.utimesSync(PATH.join(dir, name), now, now));
    const epoch = Date.UTC(2025, 0, 1) / 1000;
    process.env['SOURCE_DATE_EPOCH'] = String(epoch);
    try {
        const clamped = PATH.join(tmp, 'reproducible-clamped.nzip');
        await write(clamped, (out) => bundle({ base: dir, files, out }));
        assert.ok(Object.values(dated(clamped)).every((time) => time === epoch * 1000), 'no member later than SOURCE_DATE_EPOCH');
        process.env['SOURCE_DATE_EPOCH'] = 'yesterday';
        await assert.rejects(write(PATH.join(tmp, 'never.nzip'), (out) => bundle({ base: dir, files, out })), /SOURCE_DATE_EPOCH is 'yesterday', not a number of seconds/);
    } finally {
        delete process.env['SOURCE_DATE_EPOCH'];
    }
});
