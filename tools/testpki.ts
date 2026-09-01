#!/usr/bin/env node
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../src/files.ts';

// A throwaway certificate authority, for tests and for the offline half of the
// build. Generated on demand into `build/certs/`, which is not in the
// repository and never will be.
//
// This used to be a committed `certs/` directory, which was a mistake worth
// naming: a private key in a repository is a private key people will sign
// with. It would have signed real artifacts that verified against a root
// anybody could regenerate — a signature that looks like provenance and carries
// none. The material is worth nothing, so it should be trivially reproducible
// and never durable, which is what this is.
//
//   node tools/testpki.ts            generate if missing
//   node tools/testpki.ts --force    regenerate
//
// Needs `openssl` on PATH. Node has no certificate *issuance* API — it can
// parse and verify X.509 but not mint it — so there is no way to do this in
// process without taking on a dependency, and a dependency to make test
// fixtures would be the wrong trade.

export interface TestPki {
    /** The self-signed root, the trust anchor a test points `--root` at. */
    root: string;
    /** The signing certificate the root issued. */
    leaf: string;
    /** Its private key. */
    key: string;
    /** Leaf then root, the chain that goes into `AUTHORITY.PEM`. */
    chain: string;
    /** The directory holding all four. */
    dir: string;
}

const SUBJECT_ROOT = '/CN=Bundle Test Root CA/O=bundle';
const SUBJECT_LEAF = '/CN=Bundle Test Signer/O=bundle';

/** Where the test PKI lives: alongside the other build outputs, and ignored. */
export function testPkiDir(): string {
    return PATH.join(packageRoot(), 'build', 'certs');
}

/** The paths, whether or not they exist yet. */
export function testPkiPaths(dir = testPkiDir()): TestPki {
    return {
        dir,
        root: PATH.join(dir, 'root.pem'),
        leaf: PATH.join(dir, 'leaf.pem'),
        key: PATH.join(dir, 'leaf.key'),
        chain: PATH.join(dir, 'chain.pem'),
    };
}

/**
 * The test PKI, generating it if it is not there. Cheap to call repeatedly; the
 * work happens once per checkout unless `force` is set.
 *
 * Generation is atomic, because `node --test` runs the test files in parallel
 * and every one of them calls this on import. Each caller builds a complete PKI
 * in a staging directory and then renames it into place; a rename onto a
 * directory that already has contents fails, so exactly one caller wins and the
 * rest use what the winner left. A reader therefore never sees a half-written
 * chain, and never mixes one generation's key with another's root.
 */
export function ensureTestPki({ dir = testPkiDir(), force = false }: {
    dir?: string | undefined;
    force?: boolean | undefined;
} = {}): TestPki {
    const pki = testPkiPaths(dir);
    if (force) FS.rmSync(dir, { recursive: true, force: true });
    else if (complete(pki)) return pki;

    FS.mkdirSync(PATH.dirname(dir), { recursive: true });
    const staging = FS.mkdtempSync(`${dir}.staging-`);
    try {
        generate(testPkiPaths(staging));
        FS.renameSync(staging, dir);
    } catch (err) {
        FS.rmSync(staging, { recursive: true, force: true });
        // Losing the race is the expected outcome for all but one caller.
        if (!complete(pki)) throw err;
    }

    if (!complete(pki)) throw new Error(`the test PKI in ${dir} is incomplete after generating it`);
    return pki;
}

function complete(pki: TestPki): boolean {
    return [pki.root, pki.leaf, pki.key, pki.chain].every((path) => FS.existsSync(path));
}

function generate(pki: TestPki): void {
    const rootKey = PATH.join(pki.dir, 'root.key');
    const csr = PATH.join(pki.dir, 'leaf.csr');
    const ext = PATH.join(pki.dir, 'leaf.ext');

    // A self-signed root, which nothing on earth trusts.
    openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', rootKey, '-out', pki.root, '-days', '3650', '-subj', SUBJECT_ROOT,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);

    // A leaf it issues, which is what actually signs.
    openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', pki.key, '-out', csr, '-subj', SUBJECT_LEAF]);
    FS.writeFileSync(ext, 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\n');
    openssl(['x509', '-req', '-in', csr, '-CA', pki.root, '-CAkey', rootKey, '-CAcreateserial',
        '-out', pki.leaf, '-days', '3650', '-extfile', ext]);

    // Leaf first, then the root — the order `AUTHORITY.PEM` expects.
    FS.writeFileSync(pki.chain, FS.readFileSync(pki.leaf, 'utf-8') + FS.readFileSync(pki.root, 'utf-8'));

    for (const leftover of [csr, ext, PATH.join(pki.dir, 'root.srl'), PATH.join(pki.dir, 'leaf.srl')]) {
        FS.rmSync(leftover, { force: true });
    }
}

function openssl(args: string[]): void {
    const res = spawnSync('openssl', args, { encoding: 'utf-8' });
    if (res.error) {
        throw Object.assign(new Error(
            `openssl is needed to generate the test PKI and could not be run: ${res.error.message}`),
            { cause: res.error });
    }
    if (res.status !== 0) {
        throw new Error(`openssl ${args[0]} failed (exit ${res.status}): ${(res.stderr || '').trim()}`);
    }
}

if (import.meta.main) {
    const force = process.argv.includes('--force');
    const pki = ensureTestPki({ force });
    console.error(`* test PKI ${force ? 'regenerated' : 'ready'} in ${PATH.relative(packageRoot(), pki.dir)}`);
    console.error('  it is signed by nothing and trusted by nothing; do not use it for anything real');
}
