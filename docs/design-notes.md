# Design notes

Design that was decided-enough to write down before it was built. This file is kept as
the reasoning, which is worth more than the diff; where an implementation departed from
its plan, that is recorded inline.

For using the tool see [README.md](../README.md); for the long-form argument about Node
packaging and supply chains that all of this sits inside, see [HISTORY.md](../HISTORY.md).

- **§1 signing-time attestation** — built. The marker grammar is extensible, and the
  evidence rides in a `SIGSTORE=` field carrying a full sigstore bundle (transparency-log
  entry *and* RFC 3161 token) rather than a bare TSA token. See `src/sigstore.ts` and
  the "Signing with sigstore" section of HISTORY.md.
- **§2 the audit skill** — built, as `skills/audit-bundle/`.
- **§3 shipping the tool as a bundle of itself** — built. The published package carries its
  own CLI as one signed archive and the `bundle` command is a launcher for it; the sigstore
  dependencies became members, as this section said they had to.
- **§4 the self-validating single executable** — built, as `src/sea.ts` and `bundle sea`.
  The VFS mount that drives a SEA, applied to the archive appended to it.
- **§5 the audit as a build step** — built, as `tools/audit.ts`, `tools/baseline.ts` and
  `.github/workflows/release.yml.disabled`. The review moves from something you do to an
  archive you received to something that happens between `create` and `sign` — and it is
  read as a diff against the release that is already published.

---

## 1. Signing-time attestation, so short-lived certificates verify later

> **Built.** What follows is the reasoning; see the note at the end of this section for
> where the implementation differs.

### The problem

`verifySync()` anchors the chain with `anchored(chain, roots, now)`, and `within()`
requires **every certificate in the chain to be inside its validity window at `now`**,
which defaults to `Date.now()` (`lib/manifest.js`). That is correct for a long-lived
code-signing certificate and wrong for a short-lived one.

Sigstore's Fulcio issues certificates valid for about **ten minutes** — deliberately, so
there is no long-lived key to steal. An archive signed that way verifies as `valid` for
ten minutes and `valid-untrusted` forever after. The signature is still good; the
verifier is simply asking the wrong question.

The right question is not *"is this certificate valid now?"* but *"was it valid when the
signature was made?"* — which requires the archive to carry a trustworthy assertion of
when that was.

### The circular approach, and why it fails

The obvious move — put the Rekor transparency-log entry in the archive as a member — does
not work:

1. The archive is hashed and signed, producing `H` and `S`.
2. Submitting `(H, S, cert)` to Rekor yields a signed entry timestamp.
3. Adding that as a member changes the member list, so the central directory changes, so
   `H` changes, so `S` is invalid.
4. Re-signing produces a new `H`, so a new log entry, so back to 3.

Anything placed **inside the hashed region** has this problem. The timestamp is obtained
*after* the signature exists, so it can never be part of what the signature covers.

### The resolution: the EOCD comment is already an unsigned-attribute region

This is a solved problem in code signing generally. [RFC 3161][rfc3161] puts the timestamp
token in the CMS `SignerInfo` **`unsignedAttrs`**, for exactly this reason: the token is
produced after the signature, so it cannot live inside the signed data. Authenticode does
the same with a counter-signature unsigned attribute.

This format already has such a region. The whole-file hash deliberately stops short of the
EOCD comment, and `bundle()` writes that comment *after* hashing and signing:

```
[ prefix | members | AUTHORITY.PEM | central directory | EOCD fixed part ] [ comment ]
  \___________________ hashed region → H _______________________________/   \__ not hashed
                                                                              SIGNED:H:S
```

So the timestamp goes in the comment, beside the signature — not in a member.

### Proposed change

**Build** (`lib/archive.js`, step 3 of `bundle()` — already runs after hashing):

1. Compute `H`, sign it → `S`. Unchanged.
2. Send **`S`** to a timestamp authority; receive a token.
3. Write `SIGNED:<H>:<S>:TS=<base64 token>` as the EOCD comment.

No re-hash, no re-sign, no loop.

**Verify** (`lib/manifest.js`):

1. Recompute the hash of the region and match `H`. Unchanged — still the cheap,
   certificate-free first gate.
2. Parse the token from the comment; verify it against a **pinned** TSA key/root. This
   yields a trusted time `T`, bound to `S`.
3. Verify `S` over `H` against the leaf. Unchanged.
4. Anchor the chain with `now = T` instead of `Date.now()`.

`verifySync()` already accepts a `now` option, so step 4 needs no new plumbing.

**Code touch points**

| Where | Change |
|---|---|
| `parseSignature()` | The regex is anchored at exactly two fields: `/^SIGNED:([0-9a-f]+):([0-9a-f]+)$/i`. Needs an extensible trailing-field grammar, and must stay backward compatible with two-field markers. |
| `bundle()` | Request and append the token after signing. |
| `inspect()` | Verify the token, derive `T`, pass it as `now`. |
| trust config | A pinned TSA root, alongside the existing `extraRoots` / `BUNDLE_ROOTS`. |

### Timestamp `S`, not `H`

A token over `H` proves *the archive* existed at `T`. A token over `S` proves *the
signature* existed at `T`, which is the question actually being asked about certificate
validity. CMS convention is to timestamp the signature value.

### Why an unhashed comment is acceptable here

The comment is not covered by `H`, so it is malleable. That is not exploitable:

- **Strip the token** → verification falls back to `Date.now()` → the certificate reads as
  expired → result degrades to `valid-untrusted`. A denial of service, not a forgery.
- **Forge a token** → requires the TSA's key.
- **Transplant a token from another archive** → it binds to that archive's `S`.
- **Obtain a fresh token** → a later `T` only makes the certificate look more expired.

This is also no weaker than the status quo: `S` itself already lives in the unhashed
comment and self-authenticates. Nothing about the trust model changes.

**Size budget.** The EOCD comment length field is 2 bytes → 65535 bytes. An RFC 3161 token
carrying its TSA chain is roughly 2–4 KB. Not a constraint.

### Cheaper alternatives, if this is too much machinery

- **Self-asserted signing time.** A `!signed <RFC3339>` directive in `AUTHORITY.PEM` sits
  *inside* the hashed region, so it is covered by `S` and is tamper-evident. But it is only
  as good as the signer's clock, and it gives back the bounded-damage property that
  short-lived certificates exist to provide. A convenience fallback, not an equivalent —
  and it should produce a distinguishable result state, not silently pass as `valid`.
- **Verify once at ingest, then pin the hash.** Sidesteps long-lived re-verification
  entirely. For many deployment models this is the right answer and needs no format change
  at all.

### Open questions

- Which TSA to pin by default. Sigstore operates one; confirm the current endpoint and
  root distribution rather than hard-coding a hostname.
- Whether an archive with a good signature but *no* timestamp and an expired certificate
  deserves its own state/reason rather than collapsing into `valid-untrusted`.
- Whether to support Rekor inclusion proofs as an alternative to a plain TSA token. Same
  placement, strictly more verification work; only worth it if log transparency is wanted
  for its own sake.

### What was actually built

The placement argument survived intact — the evidence lives in the EOCD comment, beside
the signature, because it postdates it. Three things landed differently:

- **A sigstore bundle, not a bare TSA token.** The `SIGSTORE=` field carries the whole
  sigstore bundle: the Fulcio certificate, the signature, the Rekor entry *and* any RFC
  3161 timestamps. That answers the "Rekor inclusion proofs as an alternative?" open
  question with *both*, because the bundle format carries both and `@sigstore/verify`
  checks whichever are present.
- **The signing time is not plumbed through `now`.** The plan was to derive `T` and pass
  it to the existing `anchored()`. In practice the sigstore path *replaces* X.509
  anchoring rather than parameterising it: `Verifier` does certificate-to-Fulcio-root,
  SCT, log inclusion, timestamps and the signature as one coherent check, and splitting
  that across two trust models would have been strictly worse. `now` is simply ignored
  when a `SIGSTORE=` field is present.
- **No TSA to pin.** The open question about which TSA to pin by default dissolved: the
  trust material comes from the sigstore trust root over TUF, refreshed by `bundle
  trust`, so the TSA and log keys are distributed the same way as the Fulcio roots and
  need no hard-coded hostname.

Two checks the design did not anticipate turned out to be necessary, both because the
field sits in the malleable region. The bundle must be over *this* archive's hash, and
the certificate it verifies against must be the one `AUTHORITY.PEM` names — otherwise a
genuine bundle for another identity could be pinned to an archive whose extractable
manifest claims a different signer. The signature would check out and the inspectable
file would be a lie.

The remaining open question stands: an archive with a good signature, no timestamp and an
expired certificate still collapses into `valid-untrusted` rather than getting a state of
its own.

[rfc3161]: https://www.rfc-editor.org/rfc/rfc3161.html

---

## 2. An audit skill: verify → extract → review

> **Built**, as `skills/audit-bundle/SKILL.md`, following this shape closely —
> including the diff mode and the non-skippable verification step.

### Why a bundle is the right shape for this

A signed archive answers *who produced these bytes*. It does not answer *are these bytes
safe*. Those are different questions, and every npm compromise of recent years shipped a
correctly published, correctly signed package from a legitimately compromised account —
provenance alone would have confirmed it came from the real maintainer and been useless.

What makes the second question tractable here is that a bundle is a **closed set**: nothing
resolves later, nothing is fetched at install, no lifecycle script pulls in more code. A
review over it can be complete in a way that a review of a dependency tree cannot.

### Shape

A Claude Code skill that takes an archive path and:

1. **Verify** — run the existing verification. Report the state and the signing identity.
   Refuse to continue on `invalid`; continue with a clear warning on `unsigned` or
   `valid-untrusted`, since reviewing an untrusted archive is precisely the useful case.
2. **Extract** — unzip to a scratch directory. It is a real zip, so this needs no special
   tooling. Record the identity from `AUTHORITY.PEM` alongside the extraction.
3. **Review** — read every extracted file and report on:
   - install/lifecycle hooks and anything that runs at load time
   - obfuscated, minified, or encoded payloads in a source bundle
   - outbound network calls, especially in modules with no reason to make them
   - environment and credential reads; CI token and cloud metadata endpoints
   - `child_process`, `eval`, dynamic `require`, and other indirection
   - files present in the archive that nothing references

Output is a per-file report over a fixed, finite set of bytes.

### Notes

- Steps 1 and 2 are the existing CLI; only step 3 is new work.
- The verification step must not be skippable — an audit that silently reviewed a
  tampered archive would be worse than no audit.
- Worth pairing with a diff mode: review only what changed against a previously approved
  archive, which is the realistic repeat-use case.

---

## 3. Shipping the tool as a bundle of itself

> **Built.** What follows is the reasoning; see the note at the end of this section for
> where the implementation differs.

### The claim

`bundle` should not be installed from npm. It should be distributed the way it tells
everyone else to distribute: **one signed file**, verifiable by a copy of `bundle` you
already have, and auditable as a closed set before you run it.

That makes the tool its own best demonstration. Every property this project claims — a file
list discovered by observation, a whole-file signature, a mount that refuses what does not
verify, a closed set an audit can be complete over — is exercised by the way the tool
itself arrives on your machine. If the model does not hold up for `bundle`, it does not
hold up for anything.

### Why this is the answer to "where is the lock file?"

A lock file pins the bytes of a dependency tree that is still **fetched and executed at
install time**. It is a real improvement over not having one, but note what it is
improving: an install step that resolves a graph, runs lifecycle scripts, and ends with
code on your disk that nobody looked at. Reproducing that exactly is worth something, and
it is not the same as not needing it.

A signed bundle removes the step rather than pinning it:

| | lock file | signed bundle |
|---|---|---|
| what you fetch | a graph, resolved at install | one file |
| what runs at install | lifecycle scripts, transitively | nothing; there is no install |
| what you can review | in principle the tree, in practice not | every byte, and the set is finite |
| what proves origin | the registry's word | a signature over the whole artifact |
| what "the same bytes" means | same versions, re-resolved | literally the same bytes |

So the lock file is eye-candy *for this repo specifically* — the shipped artifact is not
produced by `npm install` on the user's machine. It stays useful for contributors
reproducing a build, which is a different question and an orthogonal one.

### The chain of custody

Version *N* is verified by version *N−1*. That is an ordinary trust chain over time, and
it is how package managers already handle their own updates:

```
bundle@0.1 (you have it)  --verify-->  bundle@0.2.bundle  --verify-->  bundle@0.3.bundle
```

Each release is signed through sigstore by the release workflow, so the identity to pin is
a workflow ref rather than a person:

```sh
bundle verify --identity 'https://github.com/pipobscure/bundles/.github/workflows/release.yml@refs/heads/main' \
              --issuer   'https://token.actions.githubusercontent.com' \
              bundle.bundle
```

`--identity` and `--issuer` already exist and already report a mismatch as
`valid-untrusted` rather than `invalid` — genuinely signed, just not by who you demanded.
`BUNDLE_IDENTITY`/`BUNDLE_ISSUER` impose the same policy at mount time, so a machine can
be configured to run *only* releases from that workflow.

**Bootstrapping.** The first copy has to be trusted some other way; there is no way around
that and pretending otherwise would be the dishonest part. The options are the usual ones —
verify the sigstore identity by hand against the transparency log, or take it from a
release page over TLS and audit it before first run. Trust-on-first-use, with the
mitigation that TOFU here is over an artifact you can read completely.

### The wrinkle: the tool has dependencies now

This is the part that needs work rather than just a decision. `lib/sigstore.js` pulls in
`@sigstore/*`, and a bundle has no `node_modules` at runtime — so those libraries have to
become **members of the bundle**.

That is not a workaround, it is the point: the dependency tree stops being a thing you
fetch and becomes a fixed set of files inside one signed artifact that `/audit-bundle` can
review in full. But it means:

- The manifest run has to resolve `node_modules`, not just `lib/`. Today `npm run manifest`
  mounts `lib/` alone, so nothing under `node_modules` is observed. The recording provider
  will capture them once the mount covers them — the mechanism is right, the mount point is
  not.
- The result is a much larger member list, and it is the honest one. Roughly 96 packages
  came in with the sigstore libraries; every one of them would be visible in the manifest,
  which is uncomfortable and correct.
- Verification-only builds could drop the signing half. `@sigstore/sign` and the OIDC flow
  are needed to *produce* a signature, not to check one, so a verify-only distribution is
  meaningfully smaller. Worth doing only if the size difference turns out to matter.

Until then the shipped `app.run` carries no sigstore libraries, which is why it degrades a
sigstore-signed archive to `valid-untrusted` — correct behaviour, and a limitation this
section is what fixes.

### Open questions

- **Downgrade.** A correctly signed old release stays valid forever, which is the point of
  the timestamp and also means nothing stops someone handing you version 0.1 tomorrow.
  Whether the tool should carry a version floor, or leave that to whoever is deploying it,
  is undecided. Probably the latter — it is a policy, and policy is the thing this project
  keeps insisting does not belong in the mechanism.
- **What the release artifact actually is.** A plain `.bundle` needs Node plus the preload
  flags; an `app.run` shebang runs anywhere with a compatible Node; a SEA needs nothing and
  costs 150 MB. Probably all three, but only the shebang one is a pleasant default.
- **Whether `npm` publication continues in parallel.** Useful for people embedding the
  library, and it should be explicit that the npm package is the *library* and the signed
  bundle is the *tool*, rather than pretending the registry copy does not exist.

### What was actually built

The chain-of-custody argument survived intact. Three things landed differently, all of them
about the *npm* copy rather than about the model.

- **npm publication continues, and carries the signed bundle inside it.** The open question
  resolved into "both, in one package": the registry copy is the library (an `exports` map
  of ESM entry points, typed), and beside it sits `bundle.bundle` — the CLI as one signed
  archive, 679 members including the whole sigstore dependency tree. The `bundle` command
  npm installs is a launcher (`src/bin.ts`) that verifies that archive and mounts it through
  the verifying provider, so `npx @pipobscure/bundle` runs the signed artifact, not the loose
  files. That keeps the model honest without pretending the registry does not exist.
- **The member list is computed, not observed.** The section assumed the manifest run would
  simply cover `node_modules` once the mount did. It does not, and the reason is the thing
  worth recording: `sigstore.ts` requires `@sigstore/verify` only when it meets an archive
  carrying a `SIGSTORE=` field, so an observation run that signs with a local key never
  loads it — and the resulting bundle could not check a sigstore signature it later met.
  Observation cannot see a path it did not take. So `src/files.ts` computes the dependency
  closure through `node_modules`, and the observation run is kept as the *check* on it:
  anything read that the closure missed stops the build. Both mechanisms, each doing what it
  is good at.
- **Unanchored is not a refusal, for the launcher specifically.** A sigstore-signed release
  is `valid-untrusted` on a machine that has never run `bundle trust`, and refusing there
  would make `npx` fail out of the box for a correct artifact. The launcher warns and
  continues on `valid-untrusted`, refuses outright on `invalid` or `unsigned`, and takes
  `BUNDLE_STRICT=1` to make the middle case fatal. (`trustedRootSync()` also falls back to
  the trust root `@sigstore/tuf` ships as a seed, so the common case needs no network.)

One thing the section did not anticipate: the identity policy had a hole. `--identity` and
`BUNDLE_IDENTITY` were only consulted on the sigstore path, so an archive signed against an
ordinary CA — which carries no identity claim at all — passed a policy demanding one. A
machine configured to run *only* releases from a workflow would have mounted anything
key-signed. It now reports `valid-untrusted`: the signature is genuine and simply is not the
one demanded.

The downgrade question is still open and still, deliberately, unanswered: a correctly signed
old release stays valid forever, and whether to carry a version floor is a policy, which is
the thing this project keeps insisting does not belong in the mechanism.

---

## 4. The self-validating single executable

> **Built**, as `src/sea.ts` and `bundle sea`.

### The claim

Every shape this tool produces gates on something outside itself. A `.bundle` needs the
verifying provider preloaded; a shebang launcher has no preload at all and hands straight
off to the application. The SEA is the shape that can carry its own gate, because the
container *is* the runtime — and the interesting property is that the gate can be inside
what it gates.

### The shape

```
[ node runtime | SEA blob: stub + verifier.bundle ] [ app.bundle ]
  \____________________ the prefix, and part of ___/
   \___________ the archive's signed region ______/
```

The application is an ordinary signed archive appended to a node binary — the same
`sign --prefix` that produces a shebang launcher, pointed at a different prefix. The
whole-file hash covers the prefix, so the runtime and the verifier inside it are signed by
the same signature that covers the application. There is nothing to check the checker
against because the checker is inside what is checked.

### Why the verifier is a mount rather than an inlined copy

The bootstrap runs before anything is mounted, so it cannot import the library the ordinary
way. The previous `sea.js` solved that by copying `manifest.js` into itself — about 180 lines
of duplicated verification logic, which promptly drifted: its marker regex was still the
two-field form, so it read every sigstore-signed container as *unsigned*.

The fix is to make the verifier reachable before the application is: this package's own
files ride in the SEA blob as one `.bundle` asset, and a fifteen-line CommonJS stub mounts
*that* with `node:vfs` and requires the real library out of it. Two mounts, in order: the
verifier's from the blob, then the application's from the archive at the end of the file.
Nothing is duplicated, and the verifier the container runs is the one the test suite tests.

This is the userland form of [nodejs/node#65675](https://github.com/nodejs/node/pull/65675)
(`"useVfs": true`), which puts a SEA's own assets behind a VFS mount and runs the main script
from its root. That work is not merged and is in no released node — `--build-sea` accepts the
key and ignores it — so it is done here by hand, with the difference that matters: the mount
that runs the *application* is the signed archive appended to the file, not the blob. When
`useVfs` lands, the generated stub is the only piece that changes.

### What runs before the check

The stub and the verifier execute before the signature has been verified, and that is worth
being explicit about rather than glossing. It is where the trust has to start: both live
inside the prefix, which is inside the hashed region, so tampering with either invalidates
the signature over the application — and an attacker who could rewrite the executable's own
runtime could equally rewrite a verifier that ran first. The application never runs until
the check passes.

The gain over the old arrangement is real, though: because the mount is the *verifying*
provider rather than a plain `ZipProvider`, every member is re-hashed against its signed
digest as it is first read, for the life of the process — the per-member guarantee the old
`sea.js` explicitly could not offer.

### Configuration, and where policy lives

An executable run by its own name has no flags and no preload, so `createSeaBase()` bakes
the bootstrap options into the generated stub — trusted roots, a required sigstore identity
and issuer, whether an unanchored chain is acceptable. Leave them off and the same
`BUNDLE_ROOTS` / `BUNDLE_IDENTITY` / `BUNDLE_ALLOW_UNTRUSTED` variables the mount honours
apply, so one build can be decided about later. Both are legitimate; which one you want is
whether the policy belongs to the publisher or to the deployment.

### Open questions

- **Cross-compilation.** `createSeaBase({ node })` takes the binary to embed, so building a
  container for another platform is a matter of having that platform's node to hand. Whether
  the tool should fetch one is a packaging decision it has so far declined to make.
- **Size, again.** The verifier asset is about a megabyte inside a 155 MB runtime, so the
  sigstore libraries are not what makes a SEA large. A verify-only verifier would save
  little and cost a build variant; `sigstore: false` exists for anyone who disagrees.



---

## 5. The audit as a build step, and a gate that can act on it

> **Built**, as `tools/audit.ts`, the verdict contract in `skills/audit-bundle/SKILL.md`,
> and `.github/workflows/release.yml`.

### The claim

§2 built the audit as something you do to an archive somebody sent you. That is half of it.
The other half is that a signature is a claim about bytes you stand behind, so the review
belongs *before* the signature, not only after it:

```
observe → create → AUDIT → sign → … ship … → AUDIT → run
```

Both ends are the same review. Treating them as different tasks would be the mistake: if
you would not run someone else's bundle without reading it, you should not sign your own
without reading it either, and the standard is the one that survives being applied to
yourself.

### Why the ordering has to be create-then-audit, not audit-then-create

The tempting alternative is to review the source tree and then bundle it. That reviews the
wrong thing. What ships is the archive, and the archive's member list came from an
observation run — so the interesting question is not "is this source good" but "is this
*set* the right set, and does everything in it belong". A dependency that arrived through
the closure, a file the observation pulled in that nobody expected, a member nothing
references: none of those are visible until the bundle exists. So the archive is built
first, unsigned, and the review is over the thing that will actually be signed.

This also makes the failure cheap. An unsigned archive costs nothing to throw away, which
is what makes this the right place to catch things — a finding here is "rebuild it", not
"decide whether to accept a risk in something already published".

### The gate

An audit needs judgement, so no script performs it. What a script can do is refuse to let
step 4 happen without one, and that requires the audit to leave behind something a build
step can read. Hence the verdict file: `verdict: "pass" | "fail"`, the findings with
severities, and — the load-bearing field — the **sha256 of the archive**.

`tools/audit.ts --check` re-hashes the file and refuses a verdict that names different
bytes. Without that pin the gate is theatre: it would approve any later build on the
strength of one earlier approval, which is precisely the failure mode of every
"security review completed" checkbox. Rebuilding invalidates the approval, and it should.

`--approve` exists so a person who read the archive themselves is a first-class auditor; it
writes the same file with `by: "human"`, so the gate treats both identically while the
record still says which happened. `BUNDLE_SKIP_AUDIT=1` steps past the gate and says in as
many words what that means. It is the publisher's own gate, not a runtime policy — the same
reason `--identity` is something a verifier chooses rather than something the format
imposes.

### Reviewing the diff, not the archive

Reviewing 679 members from scratch every release is expensive and, worse, is the same
reading over the same unchanged dependency tree — the kind of review that decays into a
rubber stamp precisely because nothing ever changes in most of it. What deserves attention
is the difference: which members appeared, which vanished, and what changed inside the ones
that stayed.

So the baseline is the **currently published release**, fetched with `npm pack` (which
downloads without installing or running anything, which is the property the whole project
is about) and verified before it is used. That verification is not ceremony. A diff makes
everything the baseline already contained read as "unchanged", and therefore go unread — so
a baseline that cannot be placed makes the review lie by omission rather than merely being
less useful. `tools/baseline.ts` refuses an `unsigned` or `invalid` baseline outright, and
can be told to require the release workflow's own signing identity.

This is the §3 chain of custody used for a second purpose. There, version *N* verifies
version *N+1* to establish trust; here *N* is what *N+1* is read *against*. Same edge,
different question.

Two states the design has to admit rather than paper over. The first release has no
baseline: `--allow-missing` says so and the audit reviews everything. And a diff inherits
every earlier verdict — an unchanged member is exactly as trustworthy as the review that
cleared it last time, which is worth stating in the report rather than leaving implied.

### Running the review in CI

`anthropics/claude-code-action@v1` runs Claude Code in *automation mode* when the workflow
supplies a `prompt` rather than waiting for an `@claude` mention, and a prompt can be a
skill invocation. So the release workflow installs the skill with the tool's own
`bundle skill` command — into `.claude/skills/`, where the action looks — and invokes
`/audit-bundle` over the freshly packed archive.

The action reports into the workflow log; it does not hand the job a structured result. That
is why the gate is a separate step reading a file rather than a condition on the action's
output, and why the verdict contract lives in the skill rather than in the workflow. The
verdict is uploaded as a run artifact `if: always()`, so a refused release leaves its
reasoning behind rather than only a red X.

Step 4 then signs through sigstore with the workflow's ambient OIDC identity, so the
release is signed *as the workflow* — which is the identity §3 says a consumer should pin,
and it closes the loop: the thing that was audited, the thing that was signed, and the
thing whose identity you can check are all the same bytes. `npm publish --provenance` files
its attestation from the same token, so the registry copy and the signed artifact inside it
trace to one identity rather than two.

### Pinning the actions

Every action is pinned to a full commit SHA rather than a tag. A tag is a mutable pointer,
and whoever can move `v1` can change what runs inside a job that holds an OIDC token able
to sign releases and publish to npm. That is not a hypothetical class of attack here; it is
the same class HISTORY.md's opening argument is about, and a workflow that publishes *this*
project while being open to it would be self-refuting.

The cost is real and worth naming: pinned SHAs do not pick up security fixes on their own,
so they have to be updated deliberately, with the diff read. That is the trade, and it is
the right one for a release pipeline specifically — less obviously so for ordinary CI.

### Why it ships disabled

None of this can run. `node:vfs`, the ZIP support in `node:zlib` and the `--vfs-mount`
loader are unmerged, so there is no `node-version` GitHub Actions can install that would
make the workflow pass, and shipping it live would produce a permanently red workflow and a
repository that looks broken.

It is kept anyway, at `.github/workflows/release.yml.disabled`: the file does not end in
`.yml`, so GitHub never parses it, and the body is commented out on top of that. The header
carries the one command that turns it back into a live workflow, and the result round-trips
to valid YAML. The reasoning is the part worth keeping — this file *is* the argument, made
concrete, and a design note that described a pipeline nobody could read would be worth
less.

### What this does not claim

An LLM review is a reviewer, not a proof. It raises the cost of slipping something past a
release and does not reduce it to zero, and a gate that implied otherwise would be worse
than no gate — which is what the `severity` and `summary` fields are for: they leave a
record of what was judged acceptable and by what reasoning, so a later reader can disagree
with it.

The gate also protects the publisher's pipeline only. A consumer who wants the same
assurance runs the same skill over what they received. That is not a gap being papered
over; it is the reason the skill is one review at two points rather than a build-only step.

### Open questions

- **Whether a `fail` should open an issue** rather than only failing the run. Probably yes,
  and it is a workflow concern rather than a tool one.
- **How far back a diff should reach.** The baseline is `@latest`, which is right for a
  normal release and wrong after a release that was itself under-reviewed — the diff would
  inherit that. A periodic full review, or diffing against the last *fully* reviewed
  release rather than the last one, would close it. Both need a record of which releases
  got which treatment, which the verdict file could carry but does not yet.
- **Whether the gate belongs in `prepublishOnly` too.** Today it gates signing, which is
  the step that makes the claim. Publishing an already-signed artifact is arguably a
  separate decision, and arguably not.
