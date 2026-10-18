#!/usr/bin/env node
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { packageRoot } from '../src/files.ts';

// The release's pre-signing audit: the audit-bundle skill, run over the
// unsigned CLI bundle against the published one, by an agent built on the
// Claude Agent SDK. It writes the verdict `npm run sign:cli` gates on, and
// keeps its whole transcript beside it, so a refused release leaves its
// reasoning behind.
//
//   node --no-warnings tools/audit.ts
//
// It authenticates the way the rest of the release does, without a key: the
// federation variables (ANTHROPIC_FEDERATION_RULE_ID, _ORGANIZATION_ID,
// _SERVICE_ACCOUNT_ID, _IDENTITY_TOKEN_FILE, and _WORKSPACE_ID) exchange the
// job's OIDC token for access. See .github/workflows/publish.yml.
//
// Exits non-zero when the agent does not finish its work; whether the bundle
// passed is the verdict's to say, and the gate's to check.

const ROOT = packageRoot();
const BUILD = PATH.join(ROOT, 'build');
const TRANSCRIPT = PATH.join(BUILD, 'audit-transcript.jsonl');
const VERDICT = process.env['BUNDLE_AUDIT_VERDICT'] ?? 'build/cli.audit.json';
const REPOSITORY = process.env['GITHUB_REPOSITORY'] ?? 'pipobscure/bundles';

const prompt = `/audit-bundle build/cli.unsigned.nzip against build/baseline.nzip

This is a pre-signing audit. build/cli.unsigned.nzip is the unsigned bundle this workflow just built for ${REPOSITORY} and is about to sign; build/baseline.nzip is the currently published release, already verified as genuinely signed. If the baseline file is absent, review every member instead and say so.

Use diff mode: review what changed, and call out every member added or removed even when each individual diff looks harmless. Write the machine-readable verdict to ${VERDICT}, including baselineSha256 when you reviewed a diff. The build gates on that file and will not sign without a pass pinned to this archive's sha256.`;

FS.mkdirSync(BUILD, { recursive: true });
const transcript = FS.createWriteStream(TRANSCRIPT);
const keep = (message: SDKMessage) => { transcript.write(`${JSON.stringify(message)}\n`); };

let outcome: Extract<SDKMessage, { type: 'result' }> | undefined;
try {
    for await (const message of query({
        prompt,
        options: {
            cwd: ROOT,
            model: 'claude-opus-5-5',
            maxTurns: 120,
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            // The skill comes from the project: `bundle skill` installed it there.
            settingSources: ['project'],
            skills: ['audit-bundle'],
            // What the audit needs, and nothing else: only these tools are
            // offered, no MCP server is, and anything not approved here is
            // refused rather than waited on.
            tools: ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Skill'],
            allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'Write'],
            strictMcpConfig: true,
            permissionMode: 'dontAsk',
            env: { ...process.env, BUNDLE_AUDIT_VERDICT: VERDICT },
        },
    })) {
        keep(message);
        if (message.type === 'result') outcome = message;
    }
} catch (err) {
    console.error(`audit: the agent failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
} finally {
    await new Promise((resolve) => transcript.end(resolve));
}

if (outcome) {
    const cost = outcome.total_cost_usd.toFixed(2);
    console.error(`audit: ${outcome.subtype} after ${outcome.num_turns} turns, ${Math.round(outcome.duration_ms / 1000)}s, about $${cost}; transcript in ${PATH.relative(ROOT, TRANSCRIPT)}`);
    if (outcome.subtype === 'success') {
        console.error(outcome.result);
        if (outcome.is_error) process.exitCode = 1;
    } else {
        for (const error of outcome.errors) console.error(`audit: ${error}`);
        process.exitCode = 1;
    }
} else if (!process.exitCode) {
    console.error('audit: the agent ended without a result');
    process.exitCode = 1;
}
