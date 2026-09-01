#!/usr/bin/env node
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBundleSync, mountArgv } from './api.ts';
import { STATES } from './cli.ts';

// The `bundle` command, as npm installs it — a launcher rather than the CLI.
//
// What it launches is `bundle.bundle`: this package's own CLI, built and signed
// by whoever published it, sitting next to the code that runs it. The package
// therefore ships the tool the way the tool tells everyone else to ship —
// one signed archive — and running `npx @pipobscure/bundle` exercises the whole
// mechanism: the archive is verified, mounted through the verifying provider,
// and every file it serves is re-hashed against its signed digest as the CLI
// reads it.
//
// Two things this deliberately does not pretend:
//
//   * Verifying the signed CLI with the unsigned code beside it is circular.
//     It catches a corrupted or substituted archive, not a compromised install
//     — for that, verify `bundle.bundle` with a copy of `bundle` you already
//     trust, which is what `docs/design-notes.md` §3 is about.
//
//   * A signature that is good but unanchored is not a reason to refuse to
//     run. A sigstore-signed release needs a trust root that a fresh machine
//     has no reason to have yet, so that case warns and continues; set
//     BUNDLE_STRICT=1 to make it fatal. A *bad* signature always refuses.

const HERE = PATH.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = PATH.resolve(HERE, '..', 'bundle.bundle');

const argv = process.argv.slice(2);

if (!FS.existsSync(ARCHIVE)) {
    // A checkout, or an install that was never packed. Run the CLI in place;
    // there is no signed artifact to prefer and nothing to check it against.
    const { main } = await import('./cli.ts');
    process.exitCode = await main(argv);
} else {
    process.exitCode = launch();
}

function launch(): number {
    const roots = (process.env['BUNDLE_ROOTS'] ?? '').split(PATH.delimiter).filter(Boolean);
    const strict = Boolean(process.env['BUNDLE_STRICT']);

    // An archive damaged badly enough not to parse as a ZIP at all throws from
    // inside the reader rather than answering; that is still a refusal, and it
    // should read like one.
    let res;
    try {
        res = verifyBundleSync(ARCHIVE, {
            roots, deep: false,
            identity: process.env['BUNDLE_IDENTITY'] || undefined,
            issuer: process.env['BUNDLE_ISSUER'] || undefined,
        });
    } catch (err) {
        process.stderr.write(`bundle: refusing to run its own CLI: ${ARCHIVE} could not be read — ` +
            `${err instanceof Error ? err.message : String(err)}\n`);
        return STATES.invalid.code;
    }

    if (res.state === 'invalid' || res.state === 'unsigned') {
        process.stderr.write(`bundle: refusing to run its own CLI: ${STATES[res.state].label} — ${res.reason}\n`);
        process.stderr.write(`bundle: ${ARCHIVE}\n`);
        return STATES[res.state].code;
    }

    const env = { ...process.env };
    if (res.state === 'valid-untrusted') {
        if (strict) {
            process.stderr.write(`bundle: refusing to run its own CLI: ${STATES[res.state].label} — ${res.reason}\n`);
            return STATES[res.state].code;
        }
        process.stderr.write(`bundle: warning: ${res.reason}\n`);
        env['BUNDLE_ALLOW_UNTRUSTED'] = '1';
    }

    const child = spawnSync(process.execPath, [...mountArgv(ARCHIVE), ...argv], { stdio: 'inherit', env });
    if (child.error) throw child.error;
    if (child.signal) process.kill(process.pid, child.signal);
    return child.status ?? 70;
}
