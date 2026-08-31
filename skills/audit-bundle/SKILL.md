---
name: audit-bundle
description: Verify, extract, and security-review a signed bundle archive (.bundle, app.run, or any archive built by @pipobscure/bundle). Use when asked to audit, review, vet, inspect, or check an archive or bundle before running or shipping it — including "is this safe to run", "what is in this bundle", "review this archive", or diffing one against a previously approved version.
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

Work in three phases, in order. Do not reorder them and do not skip phase 1.

---

## Phase 1 — Verify (mandatory)

An audit that silently reviewed a tampered archive would be worse than no audit, so
this phase gates the rest.

Find the CLI. In this repository it is `node lib/app.js`; installed, it is `bundle`;
and any archive built by it is self-describing, so `npx @pipobscure/bundle` also works.
Then:

```sh
bundle verify --json <archive>
```

Read the `state` field and act on it:

| `state` | Exit | What to do |
|---|---|---|
| `valid` | 0 | Continue. Record the identity. |
| `valid-untrusted` | 1 | **Continue, with a prominent warning.** The bytes are intact and genuinely signed; you just cannot place the signer. Reviewing exactly this case is the useful one. |
| `unsigned` | 3 | **Continue, with a prominent warning.** Nothing attests to origin at all. |
| `invalid` | 2 | **Stop.** Report the reason and go no further. The archive does not hold together — the member list, the content, or the signature has been altered since signing. There is nothing worth reviewing, because what you would review is not what was signed. |

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

1. **Verification** — state, identity, issuer, signing time. Lead with a clear warning
   if the archive was unsigned or untrusted.
2. **Scope** — how many files, how many lines, and the explicit claim that every one
   was read. Name anything excluded and why.
3. **Findings** — each with the file and line (`path/to/file.js:42`), what the code
   does, and why it is or is not a concern. Order by severity. Distinguish
   *confirmed malicious*, *suspicious and worth an explanation*, and *benign but
   notable*. Do not pad the list to look thorough; an empty findings section over a
   genuinely clean bundle is a good result, and say so plainly.
4. **Verdict** — a direct answer to "should this run", with the residual risk stated.

Be specific about what an audit of this kind cannot tell you: it is a review of source
that will run with the full authority of the process. Verification is provenance, not
confinement — a mounted bundle is not sandboxed, and nothing here limits what the code
can do once it starts.

## Diff mode

When the user has a previously approved archive, reviewing only what changed is the
realistic repeat-use case and far more valuable than a fresh full review.

Verify **both** archives first, extract both, then:

```sh
diff -ru <scratch>/approved <scratch>/candidate
```

Report on the changed files with the full checklist above, and state explicitly which
files were unchanged and therefore carried over from the previous approval. Call out
any member that was **added** or **removed** — a changed file list deserves scrutiny
even when every individual diff looks harmless.
