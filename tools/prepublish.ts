#!/usr/bin/env node
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { verifyBundleSync, inspectBundle } from '../src/api.ts';
import { packageRoot } from '../src/files.ts';
import { STATES } from '../src/cli.ts';

// The gate on `npm publish`.
//
// The published package's `bundle` command *is* the signed archive: `bin`
// points straight at `bundle.run`, a shebang-prefixed container that mounts and
// runs itself. There is no wrapper in between, which is the point — nothing
// unsigned stands between somebody typing `npx @pipobscure/bundle` and the
// artifact this project asks them to check.
//
// It also means publishing must not ship a package whose artifact is missing,
// stale or unsigned: the bin entry would be a broken file, and the claim the
// whole project makes about how software should arrive would be false of the
// way this software arrived.
//
// What is checked:
//
//   1. `bundle.run` exists and carries a signature.
//   2. It verifies — integrity and the signature over it. Trust is reported but
//      not required: a sigstore-signed release is `valid-untrusted` on a
//      machine with no trust root yet, and that is a property of the machine.
//   3. Its members match what a build of the current tree would produce, so a
//      signed archive from two commits ago cannot ride along unnoticed.

const ROOT = packageRoot();
const ARCHIVE = PATH.join(ROOT, 'bundle.run');
const FRESH = PATH.join(ROOT, 'build', 'cli.bundle');

if (!FS.existsSync(ARCHIVE)) {
    fail(`there is no signed CLI at ${rel(ARCHIVE)}.\n` +
        "  build one with 'npm run pack:cli' and sign it with 'npm run sign:cli'");
}

const res = verifyBundleSync(ARCHIVE);
if (res.state === 'unsigned' || res.state === 'invalid') {
    fail(`${rel(ARCHIVE)} is ${STATES[res.state].label} — ${res.reason}`);
}
console.error(`* ${rel(ARCHIVE)}: ${STATES[res.state].label} — ${res.reason}`);
if (res.identity) console.error(`  identity: ${res.identity}`);
if (res.state === 'valid-untrusted') {
    console.error('  (untrusted here only means this machine has no trust root for it)');
}

if (!FS.existsSync(FRESH)) {
    fail(`there is no freshly packed ${rel(FRESH)} to compare against.\n` +
        "  run 'npm run pack:cli' so the signed archive can be checked for staleness");
}

const signed = inspectBundle(ARCHIVE).members;
const fresh = inspectBundle(FRESH).members;
const missing = fresh.filter((name) => !signed.includes(name));
const extra = signed.filter((name) => !fresh.includes(name));
if (missing.length || extra.length) {
    fail(`${rel(ARCHIVE)} does not match a build of this tree — it is stale.\n` +
        (missing.length ? `  missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''}\n` : '') +
        (extra.length ? `  extra: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ` (+${extra.length - 5})` : ''}\n` : '') +
        "  re-run 'npm run pack:cli' and 'npm run sign:cli'");
}
console.error(`* ${signed.length} members, matching a build of this tree`);

function rel(path: string): string {
    return PATH.relative(ROOT, path) || path;
}

function fail(reason: string): never {
    console.error(`error: refusing to publish — ${reason}`);
    process.exit(1);
}
