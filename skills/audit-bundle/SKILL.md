---
name: audit-bundle
description: Verify, extract, and security-review a bundle archive (.bundle, app.run, a SEA, or any archive built by @pipobscure/bundle). Use in two situations: before SIGNING a bundle you just built — the step between `bundle create` and `bundle sign` — and before RUNNING or shipping one you received. Triggers on "audit/review/vet/inspect/check this bundle", "is this safe to sign", "is this safe to run", "what is in this bundle", or diffing one against a previously approved version.
---

# Auditing a bundle

A signature answers *who produced these bytes*. It does not answer *are these bytes
safe*. Those are different questions, and the second one is why this skill exists: every
significant npm compromise of recent years shipped a correctly published, correctly
signed package from a legitimately compromised account. Provenance would have confirmed
it came from the real maintainer, and been useless.

What makes the second question tractable here is that a bundle is a **closed set**.
Nothing resolves later, nothing is fetched at install, no lifecycle script pulls in more
code. Unlike a review of a dependency tree, a review over a bundle can actually be
complete — so aim for completeness, and say so in the report.

## The same review, at two points

This is one task run at either end of the same life-cycle, and the checklist below does
not change between them:

```
observe a run → bundle create → AUDIT → bundle sign → … ship … → AUDIT → bundle run
                                  ↑                                      ↑
                            before you sign it                  before you run it
```

**Before signing.** The archive is one you just built and are about to put your name on.
A signature is a claim about bytes you stand behind, so the standard is the one you would
hold someone else's bundle to — that is the whole point of caring what you publish.

**Before running.** The archive arrived from somewhere else. Same review, and provenance
is now part of the picture too.

Only two things differ, and both are noted where they arise: what the verification states
*mean* (an unsigned archive is expected in the first case and a red flag in the second),
and how the verdict is phrased (*should this be signed* against *should this run*). Ask
which one you are in if it is not obvious from how you were called; if nobody says, assume
before-running, which is the stricter reading.

Work in three phases, in order. Do not reorder them and do not skip phase 1.

---

## Phase 1 — Verify (mandatory)

An audit that silently reviewed a tampered archive would be worse than no audit, so
this phase gates the rest. It is mandatory in both situations: pre-signing, it is what
proves the archive on disk is the one the build just wrote and that its member digests
are internally consistent.

Find the CLI. Installed, it is `bundle`; without an install, `npx @pipobscure/bundle`
works; in a checkout of the tool itself it is `node dist/main.js` (after `npm run build`).
Then:

```sh
bundle verify --json <archive>
```

Read the `state` field and act on it:

| `state` | Exit | Before signing | Before running |
|---|---|---|---|
| `unsigned` | 3 | **Expected. Continue, no warning.** This is what `bundle create` produces and what you are here to clear. | **Continue, with a prominent warning.** Nothing attests to origin at all. |
| `valid` | 0 | Already signed. Say so and ask whether re-signing is intended, then continue. | Continue. Record the identity. |
| `valid-untrusted` | 1 | Already signed, by someone you cannot place. Same question, then continue. | **Continue, with a prominent warning.** The bytes are intact and genuinely signed; you just cannot place the signer. Reviewing exactly this case is the useful one. |
| `invalid` | 2 | **Stop.** The archive does not hold together; rebuild it rather than review it. | **Stop.** Report the reason and go no further. The member list, the content, or the signature has been altered since signing. There is nothing worth reviewing, because what you would review is not what was signed. |

Record from the JSON, for the report:

- `identity` and `issuer` — for a sigstore signature, this is the real answer to "who
  signed this". A GitHub Actions identity looks like
  `https://github.com/OWNER/REPO/.github/workflows/release.yml@refs/heads/main`.
- `subject` — the certificate subject, for an archive signed against an ordinary CA.
- `signedAt` — when, per the transparency log.
- `members` — the full file list. **This is the review's scope.** Nothing outside it can run.

If the state is `valid-untrusted` with a reason mentioning the sigstore trust root, run
`bundle trust` once and re-verify — that is a missing local cache, not a problem with
the archive.

For an unsigned archive there is no `identity` or `signedAt` to record; `members` is
still there, and it is still the review's scope.

## Phase 2 — Extract

It is a real ZIP, so this needs no special tooling. Extract to a scratch directory
outside the user's project:

```sh
unzip -o <archive> -d <scratch>/extracted
```

A prefixed archive (`app.run`, or a SEA binary) extracts correctly too — the offsets
are absolute, which is the point of building it that way. `unzip` echoes the EOCD
comment, so the `SIGNED:<hash>:<signature>` marker scrolls past first; that is the
signature itself, not output to act on. Some `unzip` builds additionally warn about
leading bytes before the archive. Neither is a finding.

Then reconcile:

- `AUTHORITY.PEM` is the manifest — algorithms and the signing chain. Read its first
  few lines. It is *not* application code; exclude it from the review but confirm the
  identity it names matches what phase 1 reported.
- Compare the extracted file list against `members` from phase 1. They must match. A
  file on disk that is not in the signed member list is a finding in itself.

## Phase 3 — Review every file

Read **every** extracted file. The set is finite and closed — that is the whole
advantage — so do not sample, and do not stop at the entry point. Use `grep` to
triage and prioritise, never as the review itself; obfuscated code is specifically
designed to survive a grep.

Hunt for these, which is what the recent supply-chain attacks actually did:

**Runs at load time.** Anything executing on import rather than on call: top-level
side effects, install/lifecycle hooks, `postinstall`-style scripts in `package.json`,
self-invoking functions. A bundle has no install step, so a lifecycle hook here is
either dead weight or an attempt to run something the reviewer did not expect.

**Obfuscated, minified, or encoded payloads.** Long base64 or hex string literals,
`Buffer.from(..., 'base64')` feeding execution, hex-escaped identifiers, deeply
mangled names in a file that is otherwise source, unusually long single lines. Ask
why any of it is in a bundle whose file list was produced by observation.

**Outbound network calls.** `fetch`, `http`/`https`, `net`, `dgram`, WebSocket. Weigh
each against what the module is for: a network call in an argument parser or a date
formatter is the signal. Note every destination host, and flag hardcoded IPs, raw
`.onion`/dynamic-DNS hosts, and URLs assembled from fragments at runtime.

**Credential and environment reads.** `process.env` (especially broad enumeration
rather than named lookups), `~/.aws`, `~/.ssh`, `~/.npmrc`, `.git-credentials`,
keychains, browser profile and cookie stores, cryptocurrency wallet paths.

**CI and cloud metadata endpoints.** `169.254.169.254`, `metadata.google.internal`,
`ACTIONS_ID_TOKEN_REQUEST_URL`, `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*`. A bundle
reaching for a CI token is exfiltration until proven otherwise.

**Indirection that hides intent.** `child_process` (`exec`, `spawn`, `execSync`),
`eval`, `new Function`, dynamic `require`/`import` with a computed specifier,
`process.binding`, prototype mutation of built-ins, monkey-patching `fs` or `http`.

**Files nothing references.** Cross-check the member list against what is actually
imported from the entry point. A member no code reaches is not automatically
malicious — data files and assets are normal — but it is worth naming, because the
member list came from observing a real run and anything unreferenced did not come
from that observation.

**Anything at odds with the stated purpose.** The strongest signal is usually not a
single dangerous call but a mismatch: a module whose name and documented job do not
explain what its code does.

## The report

Write it as prose with a short table, not a wall of findings. Cover, in this order:

1. **Verification** — state, identity, issuer, signing time. Before running, lead with a
   clear warning if the archive was unsigned or untrusted. Before signing, say plainly
   that it is unsigned because it has not been signed yet, and do not dress that up as a
   finding.
2. **Scope** — how many files, how many lines, and the explicit claim that every one
   was read. Name anything excluded and why.
3. **Findings** — each with the file and line (`path/to/file.js:42`), what the code
   does, and why it is or is not a concern. Order by severity. Distinguish
   *confirmed malicious*, *suspicious and worth an explanation*, and *benign but
   notable*. Do not pad the list to look thorough; an empty findings section over a
   genuinely clean bundle is a good result, and say so plainly.
4. **Verdict** — a direct answer to the question the caller actually has. Before signing,
   that is *should this be signed*: say **sign** or **do not sign**, and if the latter,
   say what to change and rebuild rather than what risk to accept — an unsigned archive
   costs nothing to throw away, which is exactly why this is the cheap place to catch
   things. Before running, it is *should this run*, with the residual risk stated. Either
   way, name the bundle's whole-file hash (`bundle verify --json` reports it once signed;
   before that, `sha256sum` the file) so the verdict is pinned to the bytes it was reached
   over and cannot be quietly carried to a later build.

Be specific about what an audit of this kind cannot tell you: it is a review of source
that will run with the full authority of the process. Verification is provenance, not
confinement — a mounted bundle is not sandboxed, and nothing here limits what the code
can do once it starts.

## A verdict something else can gate on

When the caller asks for a machine-readable result — or when `BUNDLE_AUDIT_VERDICT` names
a path in the environment, which is how CI asks — write the verdict there as JSON, *in
addition to* the prose report. A build step reads it and refuses to sign or ship on
anything but a clean result.

```json
{
  "bundle": "build/cli.bundle",
  "sha256": "<sha256sum of the archive file, lower-case hex>",
  "baseline": "build/baseline.bundle",
  "baselineSha256": "<sha256sum of the archive it was reviewed against>",
  "mode": "sign",
  "state": "unsigned",
  "identity": null,
  "members": 679,
  "reviewed": 679,
  "verdict": "pass",
  "summary": "One sentence. What was reviewed and what was concluded.",
  "findings": [
    { "severity": "high", "file": "node_modules/x/index.js", "line": 42,
      "what": "reads process.env wholesale and POSTs it to a hardcoded IP",
      "why": "no plausible reason in a module that formats dates" }
  ]
}
```

Rules for the file, because a gate is only as good as what it refuses:

- **`sha256` is mandatory and is the sha256 of the archive file itself**, not the
  `SIGNED:` hash. It is what pins the verdict to the bytes you actually reviewed; a
  consumer must re-hash the file and refuse a verdict that does not match.
- **`mode`** is `"sign"` or `"run"` — which of the two questions you answered.
- **`verdict`** is `"pass"` or `"fail"`. Nothing else. Write `"fail"` whenever you would
  not sign or would not run it, including when you could not complete the review.
- **`findings`** is every finding, `[]` when there are none. `severity` is `high`,
  `medium`, `low`, or `note`. Anything above `note` means the verdict is `"fail"` unless
  you explain in `summary` why a specific finding is understood and accepted — do not
  quietly downgrade a severity to reach a pass.
- **`baseline` / `baselineSha256`** are present only when the review was a diff, and then
  they name the archive it was against. Omitting them says the review was of everything;
  a consumer that fetched a baseline will treat a verdict without them as a full review
  and one with the *wrong* hash as stale, so do not guess at either.
- **`reviewed`** is how many members you actually read. In diff mode that is the changed
  set, not the whole archive, and `summary` should say which — an audit that reviewed 12
  of 679 members is the right outcome for a small release and the wrong one if nobody
  knows that is what happened.
- Write the file **last**, after the prose report, and only once. If phase 1 stopped the
  audit, still write it, with `verdict: "fail"` and the reason in `summary`.

## Diff mode

When there is a previously approved archive, review only what changed. This is the
realistic repeat-use case and it is more valuable than a fresh full review, not less: a
full re-read of an unchanged dependency tree every release is the kind of review that
quietly decays into a rubber stamp, while a small diff gets read properly.

It is also the default in this project's release pipeline, where the baseline is the
**currently published release**, already verified as genuinely signed by the release
workflow. That matters: the diff is only meaningful if the thing you are diffing against
is the thing it claims to be, because everything the baseline already contained reads as
"unchanged" and is therefore not read at all.

Verify **both** archives first — a baseline that is `invalid`, or `unsigned` when it
should not be, is a reason to stop and review everything instead. Then extract both and:

```sh
diff -ru <scratch>/baseline <scratch>/candidate
```

Report on the changed files with the full checklist above, and state explicitly which
files were unchanged and therefore carried over. Call out every member that was **added**
or **removed** — a changed file list deserves scrutiny even when each individual diff
looks harmless, and an added member is the cheapest place for something to arrive
unnoticed.

Two things a diff cannot tell you, so say so rather than implying otherwise:

- An unchanged member is only as trustworthy as the review that cleared it last time.
  A diff inherits every earlier verdict.
- A member removed from the archive is not a member removed from the world; check that
  nothing left behind still references it.

Record `baseline` and `baselineSha256` in the verdict so the review is pinned to the
comparison it actually made, and set `reviewed` to the number of members you read rather
than the number in the archive.
