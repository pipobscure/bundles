import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createBundle, signBundle } from '../src/api.ts';
import { packageRoot } from '../src/files.ts';
import { APP, scratch, testSigner, tree } from './helpers.ts';

// The audit gate — step 3 of building a bundle, and the one step a script cannot
// perform. What it can do is refuse to let step 4 happen without a clean verdict
// over exactly these bytes, and that refusal is what these tests pin down.

const ROOT = packageRoot();
const MAIN = PATH.join(ROOT, 'src', 'main.ts');

const tmp = scratch('audit');
const source = tree(tmp);
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const BUNDLE = PATH.join(tmp, 'audited.bundle');
await createBundle({ base: source, files: Object.keys(APP), output: BUNDLE });
const SHA = CRYPTO.createHash('sha256').update(FS.readFileSync(BUNDLE)).digest('hex');

let counter = 0;
function verdictPath(): string {
    return PATH.join(tmp, `verdict-${counter++}.json`);
}

function audit(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ['--no-warnings', '--experimental-vfs', MAIN, 'audit', ...args],
        { encoding: 'utf-8', env: { ...process.env, ...env } });
}

function write(path: string, verdict: Record<string, unknown>): string {
    FS.writeFileSync(path, JSON.stringify(verdict, null, 2));
    return path;
}

test('preparing reports what is about to be audited, and how', () => {
    const res = audit([BUNDLE, '--verdict', verdictPath()]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(SHA));
    assert.match(res.stdout, /4 members/);
    // An unsigned archive is the expected input here and must not read as a problem.
    assert.match(res.stdout, /unsigned, as an archive that has not been signed yet should be/);
    assert.match(res.stderr, /\/audit-bundle/);
});

test('preparing refuses a signed archive that does not hold together', async () => {
    // Only a *signed* archive can be shown to have changed — that is what the
    // signature is for. An unsigned one has nothing to check it against, which
    // is the honest reason step 3 comes before step 4 rather than after.
    const signed = PATH.join(tmp, 'signed.bundle');
    await signBundle({ source: BUNDLE, output: signed, signer: testSigner() });
    const bytes = FS.readFileSync(signed);
    const at = bytes.indexOf(Buffer.from(CRYPTO.createHash('sha256').update(APP['greet.js']!).digest('hex'), 'ascii'));
    assert.notEqual(at, -1);
    bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61;
    FS.writeFileSync(signed, bytes);

    const res = audit([signed, '--verdict', verdictPath()]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /rebuild it rather than reviewing it/);
});

test('preparing refuses something that is not an archive at all', () => {
    const junk = PATH.join(tmp, 'junk.bundle');
    FS.writeFileSync(junk, 'this is not a zip file');
    const res = audit([junk, '--verdict', verdictPath()]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /could not be read as an archive/);
});

test('the gate refuses when nothing has been audited', () => {
    const res = audit(['--check', BUNDLE, '--verdict', PATH.join(tmp, 'absent.json')]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /has not been audited/);
});

test('the gate refuses a verdict that approves different bytes', () => {
    // The whole point of the pin: an approval that can be carried to a later
    // build is not an approval of anything.
    const verdict = write(verdictPath(), {
        sha256: 'ff'.repeat(32), verdict: 'pass', summary: 'looked fine at the time',
    });
    const res = audit(['--check', BUNDLE, '--verdict', verdict]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /it is stale/);
    assert.match(res.stderr, new RegExp(SHA));
});

test('the gate refuses a verdict that did not pass, and says why', () => {
    const verdict = write(verdictPath(), {
        sha256: SHA,
        verdict: 'fail',
        summary: 'reads the environment and posts it somewhere',
        findings: [
            { severity: 'high', file: 'greet.js', line: 3, what: 'exfiltrates process.env' },
            { severity: 'note', file: 'index.js', what: 'unreferenced member' },
        ],
    });
    const res = audit(['--check', BUNDLE, '--verdict', verdict]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /did not pass/);
    assert.match(res.stderr, /\[high\] greet\.js:3 — exfiltrates process\.env/);
    // A note is not a reason on its own, so it is not paraded as one.
    assert.doesNotMatch(res.stderr, /unreferenced member/);
});

test('the gate refuses a verdict it cannot read', () => {
    const verdict = PATH.join(tmp, 'garbage.json');
    FS.writeFileSync(verdict, 'not json at all');
    const res = audit(['--check', BUNDLE, '--verdict', verdict]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /not readable JSON/);
});

test('the gate passes a clean verdict over these bytes', () => {
    const verdict = write(verdictPath(), {
        sha256: SHA, verdict: 'pass', members: 4, reviewed: 4,
        summary: 'every member read; nothing to report', findings: [],
    });
    const res = audit(['--check', BUNDLE, '--verdict', verdict]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /every member read/);
    assert.match(res.stderr, /4 of 4 members reviewed/);
});

test('the gate is a command, so skipping it is simply not running it', () => {
    // There is deliberately no environment variable that turns the gate off. A
    // switch like that gets set in CI once and never unset, and this is the
    // publisher's own gate: if you do not want it, do not put it in the chain.
    const res = audit(['--check', BUNDLE, '--verdict', PATH.join(tmp, 'absent.json')],
        { BUNDLE_SKIP_AUDIT: '1' });
    assert.notEqual(res.status, 0, 'no env var may bypass the gate');
    assert.match(res.stderr, /has not been audited/);
});

test('approving by hand writes a verdict the gate accepts, pinned to the bytes', () => {
    const verdict = verdictPath();
    const approved = audit(['--approve', BUNDLE, '--verdict', verdict, '--note', 'read it myself']);
    assert.equal(approved.status, 0, approved.stderr);

    const written = JSON.parse(FS.readFileSync(verdict, 'utf-8')) as Record<string, unknown>;
    assert.equal(written['sha256'], SHA);
    assert.equal(written['verdict'], 'pass');
    assert.equal(written['summary'], 'read it myself');
    // The record says a person did this, not the skill — the gate treats them the
    // same, but what happened should still be legible afterwards.
    assert.equal(written['by'], 'human');
    assert.match(String(written['at']), /^\d{4}-\d{2}-\d{2}T/);

    const res = audit(['--check', BUNDLE, '--verdict', verdict]);
    assert.equal(res.status, 0, res.stderr);
});

test('an approval does not survive the archive changing under it', () => {
    const verdict = verdictPath();
    audit(['--approve', BUNDLE, '--verdict', verdict, '--note', 'fine']);

    const rebuilt = PATH.join(tmp, 'rebuilt.bundle');
    FS.copyFileSync(BUNDLE, rebuilt);
    const bytes = FS.readFileSync(rebuilt);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0x01, bytes.length - 1);
    FS.writeFileSync(rebuilt, bytes);

    const res = audit(['--check', rebuilt, '--verdict', verdict]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /stale/);
});

test('there is nothing to audit when the archive is not there', () => {
    const res = audit([PATH.join(tmp, 'nope.bundle'), '--verdict', verdictPath()]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /there is no archive at/);
});

// --------------------------------------------------------------- baselines ---

// Reviewing against the last release rather than from scratch is the realistic
// repeat-use case, and it introduces a way to be fooled honestly: a verdict that
// claims a diff it did not do, or did against something else.

test('a baseline on disk is reported, with what changed', async () => {
    const dir = PATH.join(tmp, 'baseline-case');
    FS.mkdirSync(dir, { recursive: true });
    const baseline = PATH.join(dir, 'baseline.bundle');
    await createBundle({ base: source, files: ['package.json', 'index.js'], output: baseline });

    const res = audit([BUNDLE, '--baseline', baseline, '--verdict', verdictPath()]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /2 added, 0 removed/);
    assert.match(res.stdout, /\+ greet\.js/);
    assert.match(res.stdout, /against .*baseline\.bundle/);
});

test('with no baseline the review is of everything, and says so', () => {
    const res = audit([BUNDLE, '--baseline', PATH.join(tmp, 'absent.bundle'), '--verdict', verdictPath()]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no baseline — the review is of everything, not a diff/);
});

test('the gate refuses a verdict reached against a different baseline', async () => {
    const dir = PATH.join(tmp, 'baseline-stale');
    FS.mkdirSync(dir, { recursive: true });
    const baseline = PATH.join(dir, 'baseline.bundle');
    await createBundle({ base: source, files: ['package.json'], output: baseline });

    const verdict = write(verdictPath(), {
        sha256: SHA, baselineSha256: 'ab'.repeat(32), verdict: 'pass', summary: 'diffed against something else',
    });
    const res = audit(['--check', BUNDLE, '--baseline', baseline, '--verdict', verdict]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /reached against a different baseline/);
});

test('a verdict that records no baseline is accepted as a full review, with a note', async () => {
    const dir = PATH.join(tmp, 'baseline-full');
    FS.mkdirSync(dir, { recursive: true });
    const baseline = PATH.join(dir, 'baseline.bundle');
    await createBundle({ base: source, files: ['package.json'], output: baseline });

    const verdict = write(verdictPath(), {
        sha256: SHA, verdict: 'pass', summary: 'read all of it', findings: [],
    });
    const res = audit(['--check', BUNDLE, '--baseline', baseline, '--verdict', verdict]);
    assert.equal(res.status, 0, res.stderr);
});

test('the gate accepts a diff verdict pinned to the baseline that is there', async () => {
    const dir = PATH.join(tmp, 'baseline-ok');
    FS.mkdirSync(dir, { recursive: true });
    const baseline = PATH.join(dir, 'baseline.bundle');
    await createBundle({ base: source, files: ['package.json'], output: baseline });
    const baselineSha = CRYPTO.createHash('sha256').update(FS.readFileSync(baseline)).digest('hex');

    const verdict = write(verdictPath(), {
        sha256: SHA, baselineSha256: baselineSha, verdict: 'pass',
        members: 4, reviewed: 3, summary: 'three members changed; nothing to report', findings: [],
    });
    const res = audit(['--check', BUNDLE, '--baseline', baseline, '--verdict', verdict]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /3 of 4 members reviewed/);
    assert.match(res.stderr, new RegExp(`as a diff against ${baselineSha.slice(0, 16)}`));
});

test('approving by hand records the baseline it was approved against', async () => {
    const dir = PATH.join(tmp, 'baseline-approve');
    FS.mkdirSync(dir, { recursive: true });
    const baseline = PATH.join(dir, 'baseline.bundle');
    await createBundle({ base: source, files: ['package.json'], output: baseline });

    const verdict = verdictPath();
    const res = audit(['--approve', BUNDLE, '--baseline', baseline, '--verdict', verdict, '--note', 'ok']);
    assert.equal(res.status, 0, res.stderr);
    const written = JSON.parse(FS.readFileSync(verdict, 'utf-8')) as Record<string, unknown>;
    assert.equal(written['baselineSha256'],
        CRYPTO.createHash('sha256').update(FS.readFileSync(baseline)).digest('hex'));
});
