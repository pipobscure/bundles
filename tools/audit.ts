#!/usr/bin/env node
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { parseArgs } from 'node:util';
import { verifyBundleSync, inspectBundle } from '../src/api.ts';
import { packageRoot } from '../src/files.ts';
import { STATES } from '../src/cli.ts';

// Step 3 of building a bundle: the audit gate.
//
//   observe → create → AUDIT → sign
//
// The review itself is `skills/audit-bundle` and needs judgement, so it is not
// something a script performs. What a script can do is the two mechanical
// halves around it: prepare the archive and say exactly what to run, and then
// refuse to let signing proceed on anything but a clean verdict over these
// bytes.
//
// The verdict is a JSON file the skill writes (see its "A verdict something
// else can gate on" section), pinned to the sha256 of the archive. That pin is
// the whole point: an approval that could be carried to a later build is not an
// approval of anything.
//
//   node tools/audit.ts                    prepare, and print what to run
//   node tools/audit.ts --check            gate: exit non-zero without a clean verdict
//   node tools/audit.ts --approve          record a clean verdict by hand
//
// `--approve` exists because a person who has read the archive themselves is a
// legitimate auditor; it writes the same file the skill would, marked as such,
// so the gate treats both the same way and the record says which it was.

const ROOT = packageRoot();

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        bundle:   { type: 'string', default: PATH.join('build', 'cli.bundle') },
        verdict:  { type: 'string', default: PATH.join('build', 'cli.audit.json') },
        baseline: { type: 'string', default: PATH.join('build', 'baseline.bundle') },
        check:    { type: 'boolean' },
        approve:  { type: 'boolean' },
        note:     { type: 'string' },
    },
});

const BUNDLE = PATH.resolve(ROOT, values.bundle!);
const VERDICT = PATH.resolve(ROOT, values.verdict!);

// A baseline is optional — the first release has none — but when one is on disk
// the review is expected to have been a diff against it, and the gate says so.
const BASELINE = PATH.resolve(ROOT, values.baseline!);
const baseline = FS.existsSync(BASELINE)
    ? { path: BASELINE, sha256: CRYPTO.createHash('sha256').update(FS.readFileSync(BASELINE)).digest('hex') }
    : null;

if (!FS.existsSync(BUNDLE)) {
    fail(`there is no archive at ${rel(BUNDLE)}.\n  run 'npm run manifest:cli' and 'npm run pack:cli' first`);
}

const sha256 = CRYPTO.createHash('sha256').update(FS.readFileSync(BUNDLE)).digest('hex');

if (values.check) check();
else if (values.approve) approve();
else prepare();

/** Report what is about to be audited, and how to audit it. */
function prepare(): void {
    // Damaged badly enough not to parse as a ZIP at all throws from inside the
    // reader rather than answering; that is still a refusal and should read as
    // one, not as a stack trace out of a build script.
    let res, members;
    try {
        res = verifyBundleSync(BUNDLE);
        ({ members } = inspectBundle(BUNDLE));
    } catch (err) {
        fail(`${rel(BUNDLE)} could not be read as an archive: ` +
            `${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.state === 'invalid') {
        fail(`${rel(BUNDLE)} is ${STATES.invalid.label} — ${res.reason}\n` +
            '  rebuild it rather than reviewing it; what you would review is not what it holds');
    }

    console.error(`* ${rel(BUNDLE)}: ${STATES[res.state].label}, ${members.length} members`);
    console.error(`  sha256: ${sha256}`);
    if (res.state === 'unsigned') {
        console.error('  unsigned, as an archive that has not been signed yet should be');
    }

    if (baseline) {
        const previous = inspectBundle(baseline.path);
        const added = members.filter((name) => !previous.members.includes(name));
        const removed = previous.members.filter((name) => !members.includes(name));
        console.error(`* baseline: ${rel(baseline.path)}, ${previous.members.length} members`);
        console.error(`  sha256: ${baseline.sha256}`);
        console.error(`  ${added.length} added, ${removed.length} removed, ` +
            `${members.length - added.length} carried over`);
        for (const name of added.slice(0, 10)) console.error(`    + ${name}`);
        for (const name of removed.slice(0, 10)) console.error(`    - ${name}`);
        if (added.length + removed.length > 20) console.error(`    … and ${added.length + removed.length - 20} more`);
    } else {
        console.error(`* no baseline at ${rel(BASELINE)} — the review is of everything, not a diff`);
    }

    console.error('\n* audit it, then record the verdict:\n');
    console.error(`    BUNDLE_AUDIT_VERDICT=${rel(VERDICT)} \\`);
    console.error(baseline
        ? `      claude "/audit-bundle ${rel(BUNDLE)} against ${rel(baseline.path)}"`
        : `      claude "/audit-bundle ${rel(BUNDLE)}"`);
    console.error('\n  or, having read it yourself:\n');
    console.error(`    npm run approve:cli -- --note '<what you checked>'`);
    console.error("\n* then 'npm run sign:cli', which will not proceed without one");
}

/** The gate. `sign:cli` runs this before it will sign anything. */
function check(): void {
    if (process.env['BUNDLE_SKIP_AUDIT']) {
        console.error(`! BUNDLE_SKIP_AUDIT is set — signing ${rel(BUNDLE)} without an audit`);
        console.error('  the signature will say you stand behind bytes nobody read');
        return;
    }
    if (!FS.existsSync(VERDICT)) {
        fail(`${rel(BUNDLE)} has not been audited — there is no verdict at ${rel(VERDICT)}.\n` +
            "  run 'npm run audit:cli' to see how, or BUNDLE_SKIP_AUDIT=1 to sign anyway");
    }

    let verdict: Verdict;
    try {
        verdict = JSON.parse(FS.readFileSync(VERDICT, 'utf-8')) as Verdict;
    } catch (err) {
        fail(`${rel(VERDICT)} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    // The pin. Without this the gate approves a build nobody looked at, as long
    // as some earlier build was approved once.
    if (verdict.sha256?.toLowerCase() !== sha256) {
        fail(`${rel(VERDICT)} approves different bytes — it is stale.\n` +
            `  approved: ${verdict.sha256 ?? '(none)'}\n` +
            `  on disk:  ${sha256}\n` +
            '  re-audit the archive this build actually produced');
    }
    // A baseline that was available but not used means the review was of the
    // whole archive when it could have been of the change — not wrong, but it
    // must not be *silently* the other thing, because a verdict that claims a
    // diff it did not do is the one way this gate can be fooled honestly.
    if (baseline && verdict.baselineSha256 && verdict.baselineSha256.toLowerCase() !== baseline.sha256) {
        fail(`${rel(VERDICT)} was reached against a different baseline.\n` +
            `  audited against: ${verdict.baselineSha256}\n` +
            `  on disk:         ${baseline.sha256}\n` +
            '  re-audit against the baseline this build fetched');
    }
    if (baseline && !verdict.baselineSha256) {
        console.error(`! ${rel(VERDICT)} records no baseline, though one was available —`);
        console.error('  treating it as a full review of every member');
    }

    if (verdict.verdict !== 'pass') {
        const findings = (verdict.findings ?? []).filter((f) => f.severity !== 'note');
        fail(`the audit of ${rel(BUNDLE)} did not pass: ${verdict.summary ?? '(no summary)'}` +
            findings.map((f) => `\n  [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.what}`).join(''));
    }

    const notes = (verdict.findings ?? []).length;
    console.error(`* audited: ${verdict.summary ?? 'pass'}`);
    console.error(`  ${verdict.reviewed ?? '?'} of ${verdict.members ?? '?'} members reviewed, ` +
        `${notes} finding${notes === 1 ? '' : 's'}, verdict pass over ${sha256.slice(0, 16)}…`);
    if (verdict.baselineSha256) console.error(`  as a diff against ${verdict.baselineSha256.slice(0, 16)}…`);
}

/** Record a clean verdict reached by a person rather than by the skill. */
function approve(): void {
    const { members } = inspectBundle(BUNDLE);
    const verdict: Verdict = {
        bundle: rel(BUNDLE),
        sha256,
        ...(baseline ? { baseline: rel(baseline.path), baselineSha256: baseline.sha256 } : {}),
        mode: 'sign',
        state: verifyBundleSync(BUNDLE).state,
        members: members.length,
        reviewed: members.length,
        verdict: 'pass',
        summary: values.note ?? 'approved by hand; no note given',
        findings: [],
        by: 'human',
        at: new Date().toISOString(),
    };
    FS.mkdirSync(PATH.dirname(VERDICT), { recursive: true });
    FS.writeFileSync(VERDICT, `${JSON.stringify(verdict, null, 2)}\n`);
    console.error(`* recorded a pass over ${sha256.slice(0, 16)}… in ${rel(VERDICT)}`);
}

interface Verdict {
    bundle?: string;
    sha256?: string;
    /** The archive this one was reviewed against, when the review was a diff. */
    baseline?: string;
    baselineSha256?: string;
    mode?: 'sign' | 'run';
    state?: string;
    members?: number;
    reviewed?: number;
    verdict?: 'pass' | 'fail';
    summary?: string;
    findings?: { severity: string; file: string; line?: number; what: string; why?: string }[];
    by?: string;
    at?: string;
}

function rel(path: string): string {
    return PATH.relative(ROOT, path) || path;
}

function fail(reason: string): never {
    console.error(`error: ${reason}`);
    process.exit(1);
}
