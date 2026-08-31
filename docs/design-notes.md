# Design notes

Two pieces of design that were decided-enough to write down before they were built.
**Both are now implemented** — this file is kept as the reasoning behind them, which is
worth more than the diff. Where the implementation departed from the plan, that is
recorded inline.

- **§1 signing-time attestation** — built. The marker grammar is extensible, and the
  evidence rides in a `SIGSTORE=` field carrying a full sigstore bundle (transparency-log
  entry *and* RFC 3161 token) rather than a bare TSA token. See `lib/sigstore.js` and
  the "Signing with sigstore" section of the README.
- **§2 the audit skill** — built, as `skills/audit-bundle/`.

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
