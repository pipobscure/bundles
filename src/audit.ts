import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { verifyBundleSync, inspectBundle } from './api.ts';
import { STATES, message } from './manifest.ts';

// Step 3 of building a bundle: the audit gate.
//
//   observe → create → AUDIT → sign
//
// The review itself needs judgement — it is `skills/audit-bundle`, and a person
// or an agent performs it. What code can do is the two mechanical halves around
// it: say what is about to be reviewed and how, and then refuse to let signing
// proceed on anything but a clean verdict over exactly these bytes.
//
// The verdict is a JSON file the skill writes (see its "A verdict something else
// can gate on" section), and the load-bearing field is the **sha256 of the
// archive**. Without that pin the gate is theatre: it would approve any later
// build on the strength of one earlier approval, which is the failure mode of
// every "security review completed" checkbox. Rebuilding invalidates the
// approval, and it should.
//
// This is a gate you choose to put in your own pipeline, not something the
// format imposes — the same position `--identity` takes.

/** What an audit concluded, as the gate reads it. */
export interface Verdict {
    /** The archive reviewed, as the auditor referred to it. */
    bundle?: string | undefined;
    /** sha256 of the archive file — what pins the verdict to the bytes. */
    sha256?: string | undefined;
    /** The archive it was reviewed against, when the review was a diff. */
    baseline?: string | undefined;
    baselineSha256?: string | undefined;
    /** Which question was answered: whether to sign it, or whether to run it. */
    mode?: 'sign' | 'run' | undefined;
    state?: string | undefined;
    members?: number | undefined;
    /** How many members were actually read — the changed set, in diff mode. */
    reviewed?: number | undefined;
    verdict?: 'pass' | 'fail' | undefined;
    summary?: string | undefined;
    findings?: Finding[] | undefined;
    /** 'human' when a person recorded it rather than the skill. */
    by?: string | undefined;
    at?: string | undefined;
}

export interface Finding {
    severity: string;
    file: string;
    line?: number | undefined;
    what: string;
    why?: string | undefined;
}

export interface AuditOptions {
    /** The archive under review. */
    bundle: string;
    /** Where the verdict is written and read (default: `<bundle>.audit.json`). */
    verdict?: string | undefined;
    /** A previously approved archive to review against, when there is one. */
    baseline?: string | undefined;
}

/** What `prepare()` found, for a caller that wants to report it itself. */
export interface Preparation {
    bundle: string;
    sha256: string;
    state: string;
    members: string[];
    verdict: string;
    /** Present when a baseline was supplied and exists. */
    baseline?: {
        path: string;
        sha256: string;
        added: string[];
        removed: string[];
        carried: number;
    } | undefined;
}

/** Where the verdict for `bundle` lives, unless the caller says otherwise. */
export function verdictPath(bundle: string, override?: string | undefined): string {
    return override ? PATH.resolve(override) : `${PATH.resolve(bundle)}.audit.json`;
}

function sha256Of(path: string): string {
    return CRYPTO.createHash('sha256').update(FS.readFileSync(path)).digest('hex');
}

/**
 * Describe what is about to be audited: its hash, its members, and — when a
 * baseline is given — what changed since. Throws when the archive does not hold
 * together, because reviewing an archive whose contents are not what it says
 * they are is worse than not reviewing it.
 */
export function prepare({ bundle, verdict, baseline }: AuditOptions): Preparation {
    if (!FS.existsSync(bundle)) throw new Error(`there is no archive at ${bundle}`);

    // Damaged badly enough not to parse as a ZIP throws from inside the reader
    // rather than answering; that is still a refusal and should read as one.
    let state, members;
    try {
        state = verifyBundleSync(bundle).state;
        ({ members } = inspectBundle(bundle));
    } catch (err) {
        throw new Error(`${bundle} could not be read as an archive: ${message(err)}`);
    }
    if (state === 'invalid') {
        throw new Error(`${bundle} is ${STATES.invalid.label} — rebuild it rather than reviewing it; ` +
            'what you would review is not what it holds');
    }

    const found: Preparation = {
        bundle, sha256: sha256Of(bundle), state, members,
        verdict: verdictPath(bundle, verdict),
    };

    if (baseline && FS.existsSync(baseline)) {
        const previous = inspectBundle(baseline).members;
        const added = members.filter((name) => !previous.includes(name));
        const removed = previous.filter((name) => !members.includes(name));
        found.baseline = {
            path: baseline, sha256: sha256Of(baseline),
            added, removed, carried: members.length - added.length,
        };
    }
    return found;
}

/**
 * The gate. Returns the verdict when it passes; throws with the reason when it
 * does not — no verdict, a verdict over different bytes, a verdict against a
 * different baseline, or a verdict that failed.
 */
export function check({ bundle, verdict, baseline }: AuditOptions): Verdict {
    const path = verdictPath(bundle, verdict);
    if (!FS.existsSync(path)) {
        throw new Error(`${bundle} has not been audited — there is no verdict at ${path}`);
    }

    let found: Verdict;
    try {
        found = JSON.parse(FS.readFileSync(path, 'utf-8')) as Verdict;
    } catch (err) {
        throw new Error(`${path} is not readable JSON: ${message(err)}`);
    }

    const sha256 = sha256Of(bundle);
    if (found.sha256?.toLowerCase() !== sha256) {
        throw new Error(`${path} approves different bytes — it is stale.\n` +
            `  approved: ${found.sha256 ?? '(none)'}\n` +
            `  on disk:  ${sha256}\n` +
            '  re-audit the archive this build actually produced');
    }

    // A baseline that was available but reviewed against something else is the
    // one way this gate can be fooled honestly: a verdict claiming a diff it did
    // not do. A verdict recording *no* baseline is a full review, which is fine.
    if (baseline && FS.existsSync(baseline) && found.baselineSha256) {
        const expected = sha256Of(baseline);
        if (found.baselineSha256.toLowerCase() !== expected) {
            throw new Error(`${path} was reached against a different baseline.\n` +
                `  audited against: ${found.baselineSha256}\n` +
                `  on disk:         ${expected}\n` +
                '  re-audit against the baseline this build is comparing to');
        }
    }

    if (found.verdict !== 'pass') {
        const serious = (found.findings ?? []).filter((f) => f.severity !== 'note');
        throw new Error(`the audit of ${bundle} did not pass: ${found.summary ?? '(no summary)'}` +
            serious.map((f) => `\n  [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.what}`).join(''));
    }
    return found;
}

/**
 * Record a clean verdict reached by reading the archive yourself. It writes the
 * same file the skill would, marked `by: 'human'`, so the gate treats both
 * identically while the record still says which happened.
 */
export function approve({ bundle, verdict, baseline, note }: AuditOptions & {
    /** What you checked — it becomes the verdict's summary. */
    note?: string | undefined;
}): Verdict {
    const found = prepare({ bundle, verdict, baseline });
    const recorded: Verdict = {
        bundle,
        sha256: found.sha256,
        ...(found.baseline ? { baseline: found.baseline.path, baselineSha256: found.baseline.sha256 } : {}),
        mode: 'sign',
        state: found.state,
        members: found.members.length,
        reviewed: found.members.length,
        verdict: 'pass',
        summary: note ?? 'approved by hand; no note given',
        findings: [],
        by: 'human',
        at: new Date().toISOString(),
    };
    FS.mkdirSync(PATH.dirname(found.verdict), { recursive: true });
    FS.writeFileSync(found.verdict, `${JSON.stringify(recorded, null, 2)}\n`);
    return recorded;
}
