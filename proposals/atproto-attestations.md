# Attestations: who vouches for a bundle, over atproto

**Status:** implemented (first cut)
**Author:** Philipp Dunkel

## Summary

A bundle is identified by its whole-file hash, the same hash a signature covers today.
Anyone with an atproto account can publish a record saying "I vouch for this hash", in
their own repository:

```
at://did:web:audit.example.com/com.pipobscure.bundle.attestation/<sha256 hex>
{
  "$type":     "com.pipobscure.bundle.attestation",
  "hash":      "sha256:<hex>",
  "kind":      "audited",
  "createdAt": "2026-10-06T12:00:00.000Z"
}
```

A verification policy names the DIDs whose attestations it requires:

```console
$ bundle attest --as audit.example.com --kind audited app.nzip
$ bundle install --attester audited@did:web:audit.example.com https://example.com/app.nzip
```

Attestations sit alongside the sigstore signature; they don't replace it. They can also
say a bundle is bad, which warns everyone installing it, and refuses it on machines whose
policy blocks on that attester. The archive format does not
change. A sigstore signature covers the hash and travels in the file; attestations name the
same hash and live outside it. A policy can require either, both, or several attesters, so
"our auditing department vouched for this" is something a runtime can demand without
caring who built the file.

## Why this shape

**Multiple attesters is the point.** The publisher, an auditor and someone who rebuilt
the bundle from source and got the same bytes are making different claims, and a consumer
may want any combination of them. Each is a record in the attester's own repository, so
nobody needs anyone else's permission to vouch for a bundle, and nobody can vouch on
someone else's behalf.

**No single trust root has to be trusted.** A policy that requires a sigstore identity
*and* an attestation can only be satisfied by breaking both: Fulcio, Rekor and GitHub's
OIDC on one side, and the attester's DID and repository key on the other.

**Revocation is deleting the record.** Sigstore signatures cannot be withdrawn;
attestations can, per attester, without touching the file or anyone else's attestation.

**Any DID atproto supports works.** Verification resolves the DID document every time
proofs are fetched, so key rotation and PDS migration are simply picked up. `did:plc` and
`did:web` are the two methods atproto supports; both work.

## What the record proves, and what it does not

The record is not trusted because a server returned it. Proofs are fetched with
`com.atproto.sync.getRecord`, which returns a CAR file containing the repository commit,
signed with the key the DID document publishes as `#atproto`, and the Merkle Search Tree
path from the commit down to the record. [`src/repo.ts`](../src/repo.ts) checks every
block against its CID, the commit signature against the DID's key, and walks the tree to
the record. So the proof is self-verifying: it can come from the PDS, a mirror or a cache
on disk.

What it establishes is "the holder of this DID's repository key published this record".
For most accounts that key is held by the PDS, not by a person, so an attestation is
exactly as trustworthy as the attester's account. An organisation that wants
independence should attest from a `did:web` on its own domain, or a `did:plc` whose
rotation keys it holds, on a PDS it runs.

## Verification stays offline: the attestation cache

The mount path is synchronous and cannot reach the network, so attestations are fetched
ahead of time and checked from a local cache, the same way the sigstore trust root is:

| when | what is fetched |
|---|---|
| `bundle install`, `update`, `verify`, `run`, `installed` | the one proof for this file's hash, from each attester the policy names |
| `bundle trust` | every attestation of every attester known to this machine: the ones `--attester` names, the ones installs are pinned to, and `BUNDLE_ATTESTERS` |
| mounting (`register`, SEA, verifying node) | nothing: the cache is read and every proof is re-verified |

For the common `.nzip` case nothing changes at run time. The shell launcher does not
verify at all; `install`, `update` and `installed` do, and those are online anyway.

The cache lives beside the install record (`~/.local/state/bundle/attestations` on Linux,
or wherever `BUNDLE_ATTESTATIONS` points): one directory per DID holding its DID document,
the proofs, and when each was last confirmed.

### Freshness, and a correction

An earlier version of this design used the commit's `rev`, a timestamp inside the
signed commit, to tell how fresh a proof is, so that even a mirrored cache could not
hide a revocation. That does not work. `rev` changes only when the repository is written
to, so a proof freshly fetched from an idle repository carries an old `rev` and cannot be
told apart from a replayed one.

Freshness is therefore the local time a proof was last confirmed, and a policy's
`maxAge` (default seven days) bounds how stale a cached proof may be. Revocation reaches
an offline machine within `maxAge` of its last refresh. The cache is trusted the way the
sigstore trust-root cache is: by file permissions. An attester that writes a heartbeat
record regularly would make `rev` meaningful again; that is left for later.

## Verification policy

These flags apply to `verify`, `run`, `sea`, the preload and the verifying node. That is,
everywhere an archive is checked rather than installed. Installing works differently;
see [Installing and updating](#installing-and-updating).

| flag | meaning |
|---|---|
| `--attester [kind@]<did or handle>` | require an attestation from this DID, optionally of this kind; repeatable |
| `--quorum <n>` | how many of the named attesters must have attested (default: all of them) |
| `--max-age <duration>` | how old a cached proof may be (`30m`, `12h`, `7d`; default `7d`) |
| `--block <did or handle>` | refuse the archive if this attester has marked it bad; repeatable |

Handles are resolved to DIDs when the command runs and only the DID is stored or baked,
because handles can change hands. The same policy can come from the environment for the
preload: `BUNDLE_ATTESTERS` (space- or comma-separated), `BUNDLE_QUORUM`,
`BUNDLE_ATTESTATION_MAX_AGE`, `BUNDLE_BLOCK`.

How it combines with signatures:

- **With no attesters**, nothing changes.
- **With attesters**, the file's integrity (whole-file hash and member digests) is always
  checked. A signature, if there is one, must verify, but its certificate need not be
  trusted unless `--identity`/`--issuer` also demand it. That is what makes "required by
  our auditors rather than signed by the author" expressible. An unsigned archive is
  acceptable when the attestations are.
- **The result** is `valid` when everything the policy demands holds. Otherwise it is
  `valid-untrusted` for a signed archive (genuine, but not vouched for by whom it should
  be), or `unsigned` for an unsigned one. A blocking attester's bad verdict is `invalid`,
  with the reason "marked bad by …".
- **`--untrusted` waives anchoring only.** It accepts a genuine signature whose chain is
  not in the trust store. It never accepts an archive that is missing something a flag
  demanded (an identity, an issuer, attestations), or one a blocker has marked bad.

A SEA built with `--attester` has the policy baked in and sealed: its command line cannot
remove it. `--block` only ever tightens, so even a sealed runtime accepts it.

## Bad verdicts

An attestation can say the opposite of vouching: `"verdict": "bad"`, with a `kind` saying
why (`malware`, `vulnerable`, …). `bundle attest --verdict bad --kind malware app.nzip`.

Anyone can publish one, so what a bad verdict does depends on who said it:

| who | effect |
|---|---|
| anyone else | a warning, shown at install, update and `installed` |
| someone trusted by the policy, or accepted for this install | nothing proceeds without asking |
| someone `--block` or the policy's `block` names | refused, at install and, through the cache, at mount time |
| someone the policy's `ignore` names | not shown at all |

Bad verdicts never count towards a requirement. A scanning service is a natural `block`
entry, and someone whose opinion you would rather not hear is a natural `ignore` entry.
There is deliberately no rule that turns a bad verdict into a good one. That would let
someone else's "bad" vouch for a file, which nobody should be able to arrange by accident.

## Discovery

Attesters do not have to be named in advance. Every record's `hash` field
(`sha256:<hex>`) parses as a URI, so Constellation, microcosm's backlink index over the
whole network, indexes it. Install and update ask
`blue.microcosm.links.getBacklinks?subject=sha256:<hex>&source=com.pipobscure.bundle.attestation:hash`
who has attested a file. `installed` asks again, so a warning published after the install
still reaches the person who installed it.

The index is a hint and nothing more. It can leave people out or make them up, so every
DID it names is resolved, and their attestation is fetched from their own PDS and verified
before it is shown. At most 50 are followed. The policy can point `discovery` at another
index or turn it off, and `--no-discover` turns it off for one command. Requests to the
index identify the tool, not the user.

## Installing and updating

Verification answers "are these bytes genuine, and who stands behind them?". Installing
asks a different question: "do I accept whoever that is?". The answer is not the same for
every version. A publisher moves their releases to another CI; an auditor reviews one
version and not the next; someone who rebuilt it from source vouches for it a week later.
If every such change were a refusal, an author moving elsewhere would break every install
of what they publish. So install and update work like this
([`src/review.ts`](../src/review.ts)):

1. **Gather** everything that vouches for the file: its signature, if it has one, and every
   verified attestation of its hash. Attestations come from attesters this machine knows
   about and from anyone discovery finds.
2. **Refuse** if the bytes or signature do not verify, if a requirement is not met, or if a
   blocker says it is bad. Requirements come only from command-line flags (`--identity`,
   `--issuer`, `--attester`) and the policy file.
3. **Proceed** if any of the evidence is known: a signer or attester accepted for this
   install before, one the policy trusts, one a flag demands, or a certificate anchored in
   the trust store.
4. **Otherwise ask.** Everything found is shown, numbered, and the person chooses what to
   accept. What they accept is remembered for later versions. `--yes` accepts everything
   shown. With nobody to ask, the command stops with exit code 4, not as a verification
   failure. A bad verdict from someone trusted always leads here.

What is recorded is *acceptance*, not requirement. A signer accepted for version 1 makes
version 2 from the same signer proceed. A version 2 from someone else is a question. To
make a signer mandatory, write it into the policy.

This package's own release is a trusted signer for its own install, not a required one,
so the same reasoning applies to it.

## The policy file

`bundle policy` shows the rules in force. They come from two JSON files that both apply:
the machine's (`/etc/bundle/policy.json`; `BUNDLE_SYSTEM_POLICY`) and the user's
(`~/.config/bundle/policy.json`; `BUNDLE_POLICY`). Each file has global rules, and rules
for one installed name under `apps`.

| setting | meaning |
|---|---|
| `require.signature` | the file must carry a signature that verifies, from an accepted issuer |
| `require.sameIssuer` | an update must be signed through the same OIDC issuer as the version it replaces |
| `require.attesters`, `require.quorum` | attestations that must be present |
| `issuers` | the only OIDC issuers whose signatures count at all |
| `trust.signers`, `trust.attesters`, `trust.certificates` | accepted without asking |
| `block`, `ignore` | see [Bad verdicts](#bad-verdicts) |
| `discovery` | the backlink index URL, or `false` |
| `maxAge` | how stale a cached proof may be |

Requirements from every file and section apply together; trust adds up; the shortest
`maxAge` wins; a machine that turns discovery off keeps it off. Unknown settings are an
error, so a typo cannot quietly loosen anything.

The format is defined by a JSON Schema, [`schemas/policy.schema.json`](../schemas/policy.schema.json),
which documents every setting. Each GitHub release attaches the schema for its version
(`releases/download/v<version>/policy.schema.json`, with a matching `$id`). The files
`bundle policy init` writes and `bundle policy show` prints start with a `$schema`
pointing there, so editors can complete and check them. A test holds the schema and
the runtime checker to the same keys, patterns and verdicts. The policy governs `install`, `update`
and `installed`. Applying it to `verify` and `run` as well is a natural next step.

## Making an attestation

```console
$ bundle attest --as alice.example.com --kind audited app.nzip
attested sha256:3f1a… as did:plc:… (audited)
  at://did:plc:…/com.pipobscure.bundle.attestation/3f1a…
$ bundle attest --as alice.example.com --revoke app.nzip
```

`attest` checks the archive's integrity first, and refuses an archive whose signature
does not verify; attesting broken bytes is never what anyone means.

It signs in with atproto OAuth ([`src/oauth.ts`](../src/oauth.ts)), against the
authorization server the account's own PDS names. The flow is a public client, using:

- pushed authorization requests (PAR);
- PKCE (S256);
- DPoP proofs from a P-256 key generated per session, with the server's nonce;
- a loopback redirect, checked for `state` and `iss`.

The token's `sub` must be the DID that was resolved. The scope requested is
`atproto repo:com.pipobscure.bundle.attestation`, write access to attestation records and
nothing else, which bsky.social accepts. A server that rejects it is asked for
`transition:generic` instead, and the user is told.

**No session is kept.** It lives for one command, is refreshed in memory if a token
expires mid-command, and is revoked when the command ends. So every attestation is
approved in the browser by whoever it speaks for, and no refresh token or DPoP key is
ever on disk. `bundle attest a.nzip b-sea c.run` attests several archives under one
sign-in. It checks all of them first, and one that does not hold together stops the
lot before anyone signs in. An app password (`BUNDLE_ATPROTO_PASSWORD`,
`--password-file`) remains for CI, where no browser can be used.

The client is atproto's loopback development client (`client_id` `http://localhost?…`)
unless `BUNDLE_OAUTH_CLIENT_ID` names hosted client metadata. That is deliberate for
now. Since sessions are short-lived one-offs, a hosted client would mainly buy a nicer
consent screen. It would also need a callback page on its own origin, because only the
development client may redirect to a loopback address. That is for when this goes
public at scale, around 1.0.

The record key is the hex digest, so there is at most one attestation per attester per
hash, and checking one needs no index: the verifier knows exactly which record to ask for.

Different shapes of one release (`.nzip`, a SEA, a plain archive) are different bytes and
need one attestation each.

## The lexicon

[`lexicons/com/pipobscure/bundle/attestation.json`](../lexicons/com/pipobscure/bundle/attestation.json).
The NSID is a single constant in [`src/attestation.ts`](../src/attestation.ts).

Publishing it, so that services can resolve and validate it, takes two steps:

1. **DNS.** A TXT record `_lexicon.bundle.pipobscure.com` with the value
   `did=<DID of the publishing account>`. The authority is the NSID without its last
   segment, reversed. It does not cover sub-names, so every `com.pipobscure.bundle.*`
   lexicon lives in that one repository.
2. **The schema record.** `at://<that DID>/com.atproto.lexicon.schema/com.pipobscure.bundle.attestation`,
   holding the lexicon document above with `"$type": "com.atproto.lexicon.schema"`.

`bundle lexicon` lists what needs publishing; `bundle lexicon check` resolves the
DNS record and compares the published schema, verified, with this package's;
`bundle lexicon publish --as <account>` writes it. It signs in with access to
`com.atproto.lexicon.schema` only, refuses an account the DNS record does not name
unless `--force` is given, and reads each record back. `--dry-run` stops before signing
in.

Until then, PDSes accept the records under optimistic validation. Once the lexicon is
published, validators check records against it, so it must describe exactly what
`attest` writes.

## Where this is going: bundles hosted on tangled.sh

The aim is that a CLI bundle can live entirely on atproto infrastructure. Its source and
releases would be on tangled.sh, and the people vouching for it would publish attestations
from their own accounts, so installing it needs nothing from GitHub. Attestations,
discovery and the install review above are the trust half of that. What is still missing
is the *source* half: `bundle install` has to resolve a tangled repository's latest
release artifact (a blob on the publisher's PDS) the way it resolves an `nzip:` TXT
record today.

## Not done yet

- **Installing from tangled.sh** (see above).
- **The policy for `verify` and `run`**, not only install and update.
- **Heartbeats**, so that a mirrored cache could prove its own freshness (see above).
