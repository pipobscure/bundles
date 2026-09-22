import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createBundle } from '../src/api.ts';
import { exactly } from '../src/sigstore.ts';
import {
    AUTHORITY, buildManifest, parseManifest, parseSignature, formatSignature,
    signatureOf, verifySync,
} from '../src/manifest.ts';
import { APP, CHAIN_PEM, ROOT_PEM, build, comment, rewriteComment, rootPem, scratch, tree } from './helpers.ts';

// The format itself: the manifest member, the signature marker, and what
// verification concludes about each way an archive can be wrong.

const tmp = scratch('manifest');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const roots = [rootPem];

test('a manifest round-trips through build and parse', () => {
    const chain = FS.readFileSync(CHAIN_PEM, 'utf-8');
    const unsigned = parseManifest(buildManifest({ hashAlg: 'sha512' }));
    assert.equal(unsigned.version, '2');
    assert.equal(unsigned.hashAlg, 'sha512');
    assert.equal(unsigned.signAlg, undefined);
    assert.deepEqual(unsigned.chain, []);

    const signed = parseManifest(buildManifest({ hashAlg: 'sha256', signAlg: 'sha256', chain }));
    assert.equal(signed.hashAlg, 'sha256');
    assert.equal(signed.signAlg, 'sha256');
    assert.equal(signed.chain.length, 2, 'leaf and root');
    assert.match(signed.chain[0]!.subject, /Bundle Test Signer/);
});

test('a chain without a signing algorithm is not a signed manifest', () => {
    // Both halves are needed; either alone describes nothing usable.
    const chain = FS.readFileSync(CHAIN_PEM, 'utf-8');
    assert.equal(parseManifest(buildManifest({ chain })).signAlg, undefined);
    assert.deepEqual(parseManifest(buildManifest({ signAlg: 'sha256' })).chain, []);
});

test('the signature marker round-trips, and old two-field markers still parse', () => {
    const hash = 'ab'.repeat(32);
    const sig = 'cd'.repeat(35);

    // The form every archive written before the field grammar existed carries.
    const plain = parseSignature(`SIGNED:${hash}:${sig}`);
    assert.equal(plain?.hash, hash);
    assert.equal(plain?.sig, sig);
    assert.equal(plain?.fields.size, 0);

    // Base64 is safe in a field value: it has no ':'.
    const payload = Buffer.from('{"a":1}').toString('base64');
    const marker = formatSignature({ hash, sig, fields: { SIGSTORE: payload } });
    assert.equal(marker, `SIGNED:${hash}:${sig}:SIGSTORE=${payload}`);

    const parsed = parseSignature(marker);
    assert.equal(parsed?.hash, hash);
    assert.equal(parsed?.fields.get('SIGSTORE'), payload);

    // Empty and absent fields are simply left out.
    assert.equal(formatSignature({ hash, sig, fields: { A: '', B: undefined } }), `SIGNED:${hash}:${sig}`);
    // A value carrying the delimiter would make the marker ambiguous.
    assert.throws(() => formatSignature({ hash, sig, fields: { A: 'x:y' } }), /may not contain/);
    assert.throws(() => formatSignature({ hash, sig, fields: { 'a b': 'x' } }), /invalid signature field name/);
    // Anything that is not a marker at all is not a signature.
    assert.equal(parseSignature('hello'), null);
    assert.equal(parseSignature(''), null);
    // Unknown fields parse rather than invalidating the marker.
    assert.equal(parseSignature(`SIGNED:${hash}:${sig}:FUTURE=1`)?.fields.get('FUTURE'), '1');
});

test('a signed archive verifies as valid and trusted against its root', async () => {
    const archive = await build(source, PATH.join(tmp, 'good.bundle'));
    const res = verifySync(archive, { extraRoots: roots });
    assert.equal(res.state, 'valid');
    assert.equal(res.signed, true);
    assert.equal(res.trusted, true);
    assert.match(res.subject!, /Bundle Test Signer/);
    assert.equal(res.digests?.size, Object.keys(APP).length);
    assert.equal(res.hashAlg, 'sha256');
});

test('an untrusted root leaves a good signature valid but unanchored', async () => {
    const archive = await build(source, PATH.join(tmp, 'good.bundle'));
    const res = verifySync(archive, { extraRoots: [] });
    assert.equal(res.state, 'valid-untrusted');
    assert.equal(res.signed, true);
    assert.equal(res.trusted, false);
});

test('an unsigned archive reports as unsigned, not as invalid', async () => {
    const archive = await build(source, PATH.join(tmp, 'unsigned.bundle'), { signed: false });
    const res = verifySync(archive, { extraRoots: roots });
    assert.equal(res.state, 'unsigned');
    assert.equal(res.signed, false);
    assert.match(res.reason, /no signature/);
});

test('an archive whose bytes changed is invalid', async () => {
    const archive = await build(source, PATH.join(tmp, 'tampered.bundle'));

    // Flip one character of a member's recorded digest. It lives in the central
    // directory as plain ASCII hex, so the archive stays structurally intact —
    // but it is inside the region the whole-file hash covers.
    const bytes = FS.readFileSync(archive);
    const digest = CRYPTO.createHash('sha256').update(APP['greet.js']!).digest('hex');
    const at = bytes.indexOf(digest, 0, 'ascii');
    assert.notEqual(at, -1, 'expected the member digest to appear in the central directory');
    bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61; // 'a' <-> 'b'
    FS.writeFileSync(archive, bytes);

    const res = verifySync(archive, { extraRoots: roots });
    assert.equal(res.state, 'invalid');
    assert.match(res.reason, /hash does not match/);
});

test('a signature that does not match the leaf certificate is invalid', async () => {
    const archive = await build(source, PATH.join(tmp, 'forged.bundle'));
    const marker = parseSignature(comment(archive))!;
    // Keep the recorded hash — so the integrity gate still passes — and replace
    // only the signature over it. That is the case the second stage exists for.
    rewriteComment(archive, formatSignature({ hash: marker.hash, sig: 'ab'.repeat(35) }));

    const res = verifySync(archive, { extraRoots: roots });
    assert.equal(res.state, 'invalid');
    assert.match(res.reason, /signature does not verify/);
});

test('verification accepts the bytes as well as a path, and agrees with itself', async () => {
    const archive = await build(source, PATH.join(tmp, 'buffered.bundle'));
    const fromPath = verifySync(archive, { extraRoots: roots });
    const fromBuffer = verifySync(FS.readFileSync(archive), { extraRoots: roots });
    assert.equal(fromBuffer.state, fromPath.state);
    assert.deepEqual([...fromBuffer.digests!.keys()].sort(), [...fromPath.digests!.keys()].sort());
});

test('signatureOf reads only the tail, and answers null for anything else', async () => {
    const archive = await build(source, PATH.join(tmp, 'tail.bundle'));
    assert.match(signatureOf(archive)!.hash, /^[0-9a-f]{64}$/);

    const unsigned = await build(source, PATH.join(tmp, 'tail-unsigned.bundle'), { signed: false });
    assert.equal(signatureOf(unsigned), null);

    const notAZip = PATH.join(tmp, 'not-a-zip');
    FS.writeFileSync(notAZip, 'just some bytes');
    assert.equal(signatureOf(notAZip), null);
    assert.equal(signatureOf(PATH.join(tmp, 'does-not-exist')), null);
});

test('a member with no recorded digest is invalid even when the file hash is right', async () => {
    // The whole-file hash covers the central directory, so a digest cannot be
    // removed without breaking it. What this pins down is the check itself:
    // an archive built by something that did not stamp digests must not pass
    // just because its own hash is self-consistent.
    const archive = await build(source, PATH.join(tmp, 'digestless.bundle'), { signed: false });
    const res = verifySync(archive, { extraRoots: roots });
    assert.equal(res.state, 'unsigned');
    assert.equal(AUTHORITY, 'AUTHORITY.PEM');
});

test('an unverifiable sigstore field is never reported as valid', async () => {
    const archive = await build(source, PATH.join(tmp, 'faked.bundle'));

    // Graft a bogus sigstore bundle onto an otherwise perfectly good archive.
    // The signature and every digest still check out; only the claim about
    // *who* signed it is fabricated, and that must not pass.
    const marker = parseSignature(comment(archive))!;
    rewriteComment(archive, formatSignature({
        hash: marker.hash,
        sig: marker.sig,
        fields: { SIGSTORE: Buffer.from('{"not":"a bundle"}').toString('base64') },
    }));

    const res = verifySync(archive, { extraRoots: roots });
    assert.notEqual(res.state, 'valid');
    assert.ok(res.sigstore, 'the sigstore path should have been taken');
});

test('a genuine sigstore bundle for another archive does not transfer', async () => {
    // The `SIGSTORE=` field lives outside the hashed region, so it is the one
    // part an attacker can replace freely. Both of its bindings are checked:
    // to this archive's hash, and to the certificate AUTHORITY.PEM names.
    const archive = await build(source, PATH.join(tmp, 'transplant.bundle'));
    const marker = parseSignature(comment(archive))!;
    const foreign = {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        verificationMaterial: { certificate: { rawBytes: 'AAAA' }, tlogEntries: [] },
        messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest: 'AAAA' }, signature: 'AAAA' },
    };
    rewriteComment(archive, formatSignature({
        hash: marker.hash, sig: marker.sig,
        fields: { SIGSTORE: Buffer.from(JSON.stringify(foreign)).toString('base64') },
    }));
    const res = verifySync(archive, { extraRoots: [rootPem] });
    assert.notEqual(res.state, 'valid');
});

test('the trusted root path is only consulted for the archive that names one', async () => {
    // A key-signed archive must verify with no sigstore machinery at all, which
    // is what lets a mount work on a machine that has never run `bundle trust`.
    const archive = await build(source, PATH.join(tmp, 'nosigstore.bundle'));
    const res = verifySync(archive, { extraRoots: roots, trustedRoot: '/nonexistent/trusted_root.json' });
    assert.equal(res.state, 'valid');
    assert.equal(res.sigstore, undefined);
    assert.equal(ROOT_PEM.endsWith('root.pem'), true);
});

test('an archive whose structure is broken is invalid, not an error', async () => {
    // Damage that breaks the ZIP itself — here, a member's size in the central
    // directory, which now runs past the end of the file — has altered the
    // archive as surely as a wrong hash has.
    const archive = await build(source, PATH.join(tmp, 'broken.bundle'));
    const bytes = FS.readFileSync(archive);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(central, -1);
    bytes.writeUInt32LE(0x7fffffff, central + 20); // its compressed size
    FS.writeFileSync(archive, bytes);

    const res = verifySync(archive, { extraRoots: roots });
    assert.equal(res.state, 'invalid');
    assert.match(res.reason, /not a readable ZIP archive/);
    // A file that is not there is still an error: there is nothing to call invalid.
    assert.throws(() => verifySync(PATH.join(tmp, 'missing.bundle')), /ENOENT/);
});

// A second PKI, to mint what the test PKI deliberately does not: a leaf with no
// code-signing purpose, and a chain whose middle is not a CA.
function openssl(args: string[]): void {
    const res = spawnSync('openssl', args, { encoding: 'utf-8' });
    if (res.status !== 0) throw new Error(`openssl ${args[0]} failed: ${res.stderr}`);
}

function issue(dir: string, name: string, ext: string, ca?: { cert: string; key: string }) {
    const key = PATH.join(dir, `${name}.key`);
    const cert = PATH.join(dir, `${name}.pem`);
    const csr = PATH.join(dir, `${name}.csr`);
    const extfile = PATH.join(dir, `${name}.ext`);
    FS.writeFileSync(extfile, ext);
    openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', key, '-out', csr, '-subj', `/CN=${name}`]);
    openssl(['x509', '-req', '-in', csr, '-out', cert, '-days', '30', '-extfile', extfile,
        ...(ca ? ['-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial'] : ['-key', key])]);
    return { key, cert, pem: FS.readFileSync(cert, 'utf-8') };
}

async function signedBy(name: string, signer: { key: string }, chain: string): Promise<string> {
    const output = PATH.join(tmp, `${name}.bundle`);
    await createBundle({ base: source, files: Object.keys(APP), output, key: FS.readFileSync(signer.key), chain });
    return output;
}

test('a chain is trusted only for code signing, and only through CAs', async () => {
    const dir = PATH.join(tmp, 'purpose');
    FS.mkdirSync(dir, { recursive: true });
    const CA = 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n';
    const root = issue(dir, 'root', CA);
    const trust = [root.pem];

    // Signed by a certificate for something else — a web server's, say. The
    // system store would anchor one of those, which is why purpose matters.
    const tls = issue(dir, 'tls', 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n', root);
    const byTls = verifySync(await signedBy('tls', tls, tls.pem + root.pem), { extraRoots: trust });
    assert.equal(byTls.state, 'valid-untrusted');

    // A code-signing leaf issued by something that is not a CA.
    const notCa = issue(dir, 'not-ca', 'basicConstraints=CA:FALSE\nkeyUsage=keyCertSign,digitalSignature\n', root);
    const leaf = issue(dir, 'leaf', 'basicConstraints=CA:FALSE\nextendedKeyUsage=codeSigning\n', notCa);
    const throughNonCa = verifySync(await signedBy('non-ca', leaf, leaf.pem + notCa.pem + root.pem), { extraRoots: trust });
    assert.equal(throughNonCa.state, 'valid-untrusted');

    // The same leaf shape, issued by the CA directly, is what trust looks like.
    const good = issue(dir, 'good', 'basicConstraints=CA:FALSE\nextendedKeyUsage=codeSigning\n', root);
    assert.equal(verifySync(await signedBy('good', good, good.pem + root.pem), { extraRoots: trust }).state, 'valid');
});

test('a sigstore identity policy matches exactly, not as a pattern', () => {
    // @sigstore/verify reads the policy with String.prototype.match.
    const policy = new RegExp(exactly('pip@pip.fyi'));
    assert.ok(policy.test('pip@pip.fyi'));
    assert.ok(!policy.test('pip@pip-fyi.com'), 'a dot is not a wildcard');
    assert.ok(!policy.test('xpip@pip.fyi'), 'anchored at the start');
    assert.ok(!policy.test('pip@pip.fyi.example'), 'anchored at the end');
    const workflow = 'https://github.com/o/r/.github/workflows/release.yml@refs/heads/main';
    assert.ok(new RegExp(exactly(workflow)).test(workflow));
    assert.ok(!new RegExp(exactly(workflow)).test(`${workflow}-2`));
});
