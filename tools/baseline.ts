#!/usr/bin/env node
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { verifyBundleSync, inspectBundle } from '../src/api.ts';
import { packageRoot } from '../src/files.ts';
import { STATES } from '../src/cli.ts';

// Fetches the currently published bundle, to review the new one *against*.
//
// A release is rarely the first one, and reviewing 679 members from scratch
// every time is both expensive and worse: it is the same reading over the same
// unchanged dependency tree, which is exactly the kind of review that decays
// into a rubber stamp. What actually deserves attention is the difference —
// which members appeared, which vanished, and what changed inside the ones that
// stayed.
//
// The baseline has to be worth trusting for that to mean anything, so this
// verifies it before handing it over, and can require it to carry the signing
// identity a release is supposed to have. Version N is what version N+1 is read
// against, which is the same chain of custody HISTORY.md's implementation
// notes §3 describe, used here for review rather than for trust.
//
//   node tools/baseline.ts --identity <san> --issuer <url>
//
// The first release has no baseline. That is a real state, not an error: with
// `--allow-missing` this writes nothing, says so, and the audit falls back to
// reviewing everything.

const ROOT = packageRoot();

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        spec:     { type: 'string' },
        output:   { type: 'string', default: PATH.join('build', 'baseline.bundle') },
        member:   { type: 'string', default: 'bundle.bundle' },
        identity: { type: 'string' },
        issuer:   { type: 'string' },
        'allow-missing': { type: 'boolean' },
    },
});

const OUTPUT = PATH.resolve(ROOT, values.output!);
const manifest = JSON.parse(FS.readFileSync(PATH.join(ROOT, 'package.json'), 'utf-8')) as { name: string };
const SPEC = values.spec ?? `${manifest.name}@latest`;

const scratch = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'bundle-baseline-'));
try {
    main();
} finally {
    FS.rmSync(scratch, { recursive: true, force: true });
}

function main(): void {
    console.error(`* fetching ${SPEC}`);
    const packed = fetchTarball();
    if (!packed) return;

    const extracted = PATH.join(scratch, 'package', values.member!);
    if (!FS.existsSync(extracted)) {
        missing(`${SPEC} carries no ${values.member} — it predates the signed-CLI layout`);
        return;
    }

    // The baseline is only worth reviewing against if it is the artifact it
    // claims to be. A tampered or unsigned one would make the diff lie by
    // omission: everything it already contained would read as "unchanged".
    const res = verifyBundleSync(extracted, {
        identity: values.identity,
        issuer: values.issuer,
    });
    if (res.state === 'invalid' || res.state === 'unsigned') {
        fail(`the published ${values.member} is ${STATES[res.state].label} — ${res.reason}\n` +
            '  refusing to use it as a comparison basis; a baseline that cannot be placed makes the diff meaningless');
    }
    if (res.state === 'valid-untrusted' && (values.identity || values.issuer)) {
        // An identity was demanded and not met. On a fresh runner this is also
        // what a missing sigstore trust root looks like, so say which.
        console.error(`! the published ${values.member} did not meet the required identity: ${res.reason}`);
        console.error('  if this run has no sigstore trust root cached, that is the cause; otherwise the');
        console.error('  published artifact was not signed by the release workflow and should be investigated');
        fail('refusing to use an unplaceable baseline');
    }

    FS.mkdirSync(PATH.dirname(OUTPUT), { recursive: true });
    FS.copyFileSync(extracted, OUTPUT);

    const sha = CRYPTO.createHash('sha256').update(FS.readFileSync(OUTPUT)).digest('hex');
    const { members } = inspectBundle(OUTPUT);
    console.error(`* baseline: ${PATH.relative(ROOT, OUTPUT)} — ${STATES[res.state].label}, ${members.length} members`);
    console.error(`  sha256: ${sha}`);
    if (res.identity) console.error(`  identity: ${res.identity}`);
    if (res.signedAt) console.error(`  signed: ${res.signedAt.toISOString()}`);
}

// `npm pack <spec>` fetches without installing and without running anything —
// which matters here, since the whole point of the artifact is that installing
// it should not execute code.
function fetchTarball(): string | null {
    const packed = spawnSync('npm', ['pack', SPEC, '--pack-destination', scratch, '--silent'],
        { encoding: 'utf-8', cwd: scratch });
    if (packed.status !== 0) {
        missing(`could not fetch ${SPEC}: ${(packed.stderr || packed.stdout || '').trim().split('\n').pop()}`);
        return null;
    }
    const tarball = FS.readdirSync(scratch).find((name) => name.endsWith('.tgz'));
    if (!tarball) {
        missing(`npm pack produced no tarball for ${SPEC}`);
        return null;
    }
    const opened = spawnSync('tar', ['-xzf', PATH.join(scratch, tarball), '-C', scratch], { encoding: 'utf-8' });
    if (opened.status !== 0) fail(`could not unpack ${tarball}: ${opened.stderr}`);
    return PATH.join(scratch, tarball);
}

// No baseline is a legitimate state — the first release, or a package that
// predates this layout. Whether it is fatal is the caller's call.
function missing(reason: string): void {
    if (!values['allow-missing']) fail(`${reason}\n  pass --allow-missing if reviewing everything is intended`);
    console.error(`* no baseline: ${reason}`);
    console.error('  the audit will review every member rather than a diff');
    FS.rmSync(OUTPUT, { force: true });
}

function fail(reason: string): never {
    console.error(`error: ${reason}`);
    process.exit(1);
}
