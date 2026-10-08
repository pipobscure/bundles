# How `bundle` works, and why it is built this way

This is the technical companion to the [README](../README.md): the archive format, what is
signed and how it is checked, the verifying mount, the executables, and the trust model
behind installs, attestations, listings and plugins. Each part says why it is the way it is.
For using the tool, see the README and the [command reference](cli.md). For the long-form
argument, why this exists at all and what it took in Node, see [HISTORY.md](../HISTORY.md).

## Contents

- [The idea](#the-idea) · [The archive](#the-archive) · [Building one](#building-one)
- [The verifying mount](#the-verifying-mount) · [Executables](#executables)
- [The tool as a bundle of itself](#the-tool-as-a-bundle-of-itself)
- [Installing: who decides](#installing-who-decides) · [Attestations](#attestations) · [Listings](#listings)
- [Plugins](#plugins) · [What it does and does not prove](#what-it-does-and-does-not-prove)
- [What it needs from Node](#what-it-needs-from-node) · [Working on this repository](#working-on-this-repository)

## The idea

A Node.js application is not a file. It is a tree: its own modules, every dependency, data
files, perhaps a native addon. That tree is assembled on the machine that runs it, by
`npm install` resolving ranges against a registry at install time. So what runs is decided
then and there, not when the application was released, and nothing records what it was.

`bundle` makes the tree one file, decided once, at release. A bundle is a ZIP of exactly the
files the application reads, signed over the whole file. Node mounts it as a file system and
runs the application out of it. Mounting through this package's provider is what makes the
signature binding: an archive that does not verify never becomes a file system, so its entry
point never runs. Everything below follows from taking that seriously.

## The archive

**The archive** is a ZIP. Its members each carry the hex digest of their own content in the
ZIP entry comment. A final `AUTHORITY.PEM` member declares the algorithms and carries the
signing certificate chain — a real, extractable filename, so `unzip` plus `openssl x509`
tells you who signed something without any of this code.

**The signature** covers the *entire file*: any prefix, every member, the whole central
directory, and the fixed part of the end-of-central-directory record — everything up to the
EOCD's trailing comment. That comment then records both:

```
[ prefix | members | AUTHORITY.PEM | central directory | EOCD ] [ comment ]
  \_____________ hashed region → H ______________________/       SIGNED:H:S[:FIELD=…]
```

Staged deliberately. The hash alone is a cheap, certificate-free integrity gate you can run
before deciding to mount anything; only then is the signature over that hash checked against
the leaf certificate; only then is the chain anchored. Because the hash covers the central
directory, it fixes *which* members exist and what each one's digest is, so changing any byte
after signing yields `invalid`.

The comment sits outside the hash on purpose: it is the unsigned-attribute region every
code-signing scheme eventually grows. Anything obtained *after* the signature exists cannot
be inside what the signature covers — which is where the sigstore bundle rides, carrying the
transparency-log entry and timestamp that establish *when* a ten-minute certificate was
valid. RFC 3161 puts timestamp tokens in CMS `unsignedAttrs` for exactly this reason.

**Unsigned, it still records its hash.** `bundle create` writes `UNSIGNED:<hash>` where a
signature would go: the same whole-file hash over the same region. It says what the bytes
should be, so damage shows, and it is what attestations of an unsigned bundle name. It says
nothing about who made it, since anyone can recompute it; that is the signature's job.

**Prefixes.** ZIP offsets can be absolute, so an archive can sit *after* arbitrary bytes and
still be a valid ZIP — which is what lets a bundle be a `#!` launcher, a native executable,
or a plain mountable archive. The prefix is chosen when the archive is **created**, because
it runs: a launcher is a shell script, a binary is a runtime, and either runs before anything
in the archive does. So it is part of what an audit reviews, and signing keeps it byte for
byte. Signing still re-emits the archive rather than appending to it, since the certificate
chain goes into `AUTHORITY.PEM` and moves every offset after it, but it does so behind the
prefix it was given.

**Every bundle is an `.nzip`.** Signed or not: an unsigned one is a bundle that attestations
can vouch for. The verifying provider claims every archive it is offered, whatever it is
called, and mounts one only when its signature checks out, or when the attestations the
policy requires vouch for it. Running an unsigned archive nobody vouches for is something you
do deliberately, with that provider out of the picture. While both copies exist, the unsigned
one is conventionally `app.unsigned.nzip`, and signing writes `app.nzip`.

## Building one

Building a bundle is four steps: **observe** what the application reads, **create** an
unsigned archive of exactly that, **audit** it, and **sign** it only if the audit came back
clean. The README walks through the commands. The reasons are here.

**Why observe.** Static analysis is perennially wrong about dynamic `require`, data files
and conditional imports. So the file list comes from running the thing:

```sh
BUNDLE_MANIFEST=app.manifest node --experimental-vfs \
    -r @pipobscure/bundle/record --vfs-load=./app -- <args>
```

Every file read through the mount is appended to `app.manifest`, one path per line, as it is
read — so a killed process still leaves a usable list. Read-only `open()`s count too, which
catches streamed files that a `readFile` hook would miss.

Observation has one blind spot worth knowing: code on a path the run never took. For a
dependency tree, pair it with a computed closure — see [`moduleFiles`](api.md#the-library).

**Why audit before signing.** A signature is a claim about bytes you stand behind, so the
review belongs before it. `bundle audit` does the two mechanical halves around the review. On
its own it reports the archive's hash, its members and — with `--baseline <previous>` — what
changed since the last release you approved. With `--check` it is a **gate**: it reads the JSON verdict the skill
writes and refuses unless that verdict passed *and* names the sha256 of the bytes on disk,
so rebuilding invalidates an approval. `--approve --note '<what you checked>'` records a
verdict you reached by reading the archive yourself.

There is deliberately no environment variable that turns the gate off. It is a command you
choose to put in your pipeline — if you do not want it, do not put it there.

[`audit-bundle`](../skills/audit-bundle/SKILL.md) is a [Claude Code](https://claude.com/claude-code)
skill that verifies the archive, extracts it, and security-reviews every file — load-time
hooks, encoded payloads, outbound calls, credential and CI-token reads, `eval` and dynamic
`require`, and members nothing references. Because a bundle is a **closed set** — nothing
resolves later, nothing is fetched at install — the review can actually be complete.

It is the same review whoever receives the bundle should run before trusting it. That is the
point: hold your own artifact to the standard you would hold someone else's. It can also
review only the **diff** against a previously approved archive, which is the realistic
repeat-use case.

**Why sign separately, and last.** What is signed should be exactly what was reviewed. So
`create` decides everything about the archive, the prefix included, `audit` reviews that
file, and `sign` adds a signature without changing anything else (see
[Prefixes](#the-archive) above). It signs in place by default, writing the signed archive
beside the original and moving it over only once it is complete, so a failed sign leaves the
reviewed file as it was.

**Why sigstore by default.** There is no long-lived key to steal. The certificate lasts about
ten minutes, and the transparency-log entry and timestamp recorded with the signature are
what let it verify afterwards. Signing against a certificate authority of your own works the
same way.

**Signers.** A signer is `{ chain, signAlg, sign(digest) }`. The chain goes into the archive
*before* hashing; `sign()` is called *after*, with the finished hash. That two-phase shape is
what lets sigstore work at all — the certificate has to be embedded before the bytes exist,
and the signature made after. `keySigner()` is the offline-CA implementation and
`@pipobscure/bundle/sigstore`'s `signer()` is the other one; a third (an HSM, a KMS, a
corporate signing service) is three properties away.

## The verifying mount

`--vfs-load` asks registered providers who wants its source. This package's provider,
registered by the `register` preload, claims `.nzip` files by name, anything carrying a
signature marker by content, and every other ZIP so that it can refuse it. So with the
provider registered, an archive either verifies or does not mount. There is no third outcome
where it quietly falls through to the built-in provider, which checks nothing.

It verifies before returning a file system, and then re-hashes each member the first time it
is read, keeping the verified copy. A ZIP is read lazily from an open file descriptor, so a
file rewritten underneath a running program would otherwise be served unchecked.

A preload takes no arguments, so the mount is configured through the environment
(`BUNDLE_ROOTS`, `BUNDLE_IDENTITY`, `BUNDLE_ATTESTERS` and the rest; see
[Environment](cli.md#environment)), or by calling `register()` from a preload of your own (see
[api.md](api.md#the-library)).

## Executables

`bundle sea` builds a node runtime with this package inside it. What you do with that runtime
is the difference between the two shapes it can take.

**With an archive, it becomes that application** — one file that checks its own signature
before running anything:

```
[ node runtime | SEA blob: stub + the verifier, as a mounted archive ] [ app ]
  \_______________________ the prefix, and part of the _______________/
   \______________________ archive's signed region ______/
```

```sh
bundle sea --output app.unsigned \
    --root /etc/ssl/my-root.pem \
    --identity 'https://github.com/me/app/.github/workflows/release.yml@refs/heads/main' \
    --issuer 'https://token.actions.githubusercontent.com' \
    app.unsigned.nzip
bundle sign app.unsigned          # -> app
```

`bundle sea` builds; it does not sign. The executable is a new archive with a new prefix, the
runtime, so it is reviewed as it will run and then signed, like any other. Until it is signed,
it refuses to run.

The whole-file hash covers the prefix too, so the runtime and the verifier inside it are
signed by the same signature that covers the application. There is nothing to check the
checker against, because the checker is inside what is checked.

**Without one, it becomes a verifying node** — a runtime that takes an archive on its command
line, checks it, and runs it:

```sh
bundle sea --output node-verifying --root /etc/ssl/my-root.pem
./node-verifying ./my-app.zip --args --for --the --app
./node-verifying --verify ./my-app.zip        # the trust state, without running it
```

One runtime, any number of applications, none of them trusted until they verify. The
application sees the argv it would have had from `--vfs-load`: the archive where a script
path goes, its own arguments from index 2 on, and none of the runtime's flags — which is why
everything after the archive belongs to the program, `--help` included.

The two are the same binary. A verifying node with an archive behind it — `bundle create
--prefix node-verifying …`, then `bundle sign` — *is* the self-validating executable, and at startup the
runtime decides which it is by looking at its own tail: a signed archive behind it runs that,
nothing behind it takes one from the command line, and an *unsigned* archive behind it is
refused rather than quietly treated as neither.

**Policy is baked in, or it is not.** The `--root`, `--identity` and `--issuer` given at build
time become the executable's own policy — the point being that a binary run by its own name
has no flags and no preload to configure it. A runtime built with a policy is **sealed**: it
takes no policy from its command line, because a binary that demands a signing identity is
not one whose user can ask it to stop. Build without one and the flags above work, falling
back to `BUNDLE_ROOTS` and friends, so one build can be decided about later.

<a id="worker-threads"></a>**Worker threads run from the application too.** Node starts a SEA's worker with nothing
mounted: not the executable's own file system, and not the application its main thread
verified. So the executable carries a preload that every thread runs first. In the main
thread it does nothing. In a worker it mounts this package out of the executable, then
verifies and mounts what the main thread did, at the same path, before the worker's script
loads. `new Worker(new URL('./worker.js', import.meta.url))` then works as it would anywhere,
and plugins the worker loads are verified as in the main thread. The main thread passes what
it mounted on in `BUNDLE_SEA_THREAD`, the one thing a worker inherits on its own. A worker
given an `env` of its own has to carry it over. The record is not trusted: a self-validating
executable's workers run only its own application, and a sealed runtime's policy holds over
anything the record says. One kind of worker is not covered: classic inline code
(`new Worker(code, { eval: true })`), which node runs without preloads. It has nothing
mounted, so it can't load anything from the application either.

The package rides inside the executable as an archive that node
mounts for itself: `"useVfs": true` ([nodejs/node#65675](https://github.com/nodejs/node/pull/65675),
released in v26.9.0) with `"vfsArchive"` ([nodejs/node#65810](https://github.com/nodejs/node/pull/65810),
released in v26.11.0), which is why the generated stub is a handful of lines and why there is no second
copy of the verifier anywhere.

**Why the zeros.** A prefix can carry an archive of its own: a SEA's file system is a ZIP in
its blob, near the end of the executable. Node's ZIP reader looks back over a fixed window
from the end of a file and refuses one with two plausible archive ends in it, since two
readers could disagree about which archive the file is. With a small application appended,
the SEA's own archive end falls inside that window. So when a prefix has an archive end near
its own end, signing follows it with enough zeros to put that end out of reach. The zeros are
part of the prefix, inside the signed region. For the same reason, a binary counts an archive
as *appended* only when the archive ends exactly at the end of the file.

## The tool as a bundle of itself

The `bundle` command npm installs **is** the signed archive. `bin` points straight at
`bundle.nzip` — the CLI, its skill and its whole dependency tree in one file, behind a two-line
`#!/bin/sh` prefix that mounts it and runs it. There is no wrapper script in between, which
is the point: nothing unsigned stands between you and the artifact, and

```sh
head -c 100 "$(npm root)/@pipobscure/bundle/bundle.nzip"   # what it will do
unzip -l    "$(npm root)/@pipobscure/bundle/bundle.nzip"   # everything it contains
bundle verify "$(npm root)/@pipobscure/bundle/bundle.nzip" # who signed it
```

answer every question about it without running anything. See
[the tool as a bundle of itself](../HISTORY.md#3-shipping-the-tool-as-a-bundle-of-itself).

Running it by name does not verify it — the kernel gives a `#!` launcher no preload to carry
a provider, and this package says so rather than pretending otherwise. Verification is a
separate act, done with a copy of `bundle` you already trust: `bundle verify bundle.nzip` to
check it, or `bundle run bundle.nzip <args>` to execute it through the verifying mount.

## Installing: who decides

`bundle install` is `curl | sh` with the two dangerous parts removed: nothing runs to install
it, and nothing lands on disk that did not verify. What is left to decide is **whom to
believe**, and that is the user's call, not the tool's.

Everything that vouches for an archive is gathered and shown: its signature, and every
attestation of its hash, from attesters this machine knows and from anyone a backlink index
says has attested it, each fetched from the attester's own PDS and verified. Then:

- **Refused:** bytes or a signature that do not verify; a requirement from a flag or the
  policy file that is not met; a bad verdict from someone the policy blocks on.
- **Proceeds:** evidence from someone accepted for this install before, trusted by the
  policy, demanded by a flag, or a certificate anchored in the trust store.
- **Otherwise asked.** The answer is remembered for later updates.

Only flags and the policy make anything mandatory. A signer recorded at install is
*accepted* on later versions, not *required*, so a publisher who moves their releases to
another CI produces a question rather than a broken install. An install also remembers *how*
it was made, a URL, a domain's `nzip:` TXT record, or a listing, and `update` asks that
again, so a moved release moves every install with it.

## Attestations

An attestation is an atproto record in the attester's own repository, keyed by the archive's
whole-file hash: *I vouch for these bytes*, optionally saying what kind of claim it is
(`published`, `audited`, `reproduced`), or the opposite, a warning (`malware`,
`vulnerable`). Anyone with an atproto account can attest, and only they can withdraw it.

It is checked offline. A proof fetched from a PDS is a CAR file holding the repository's
signed commit and the Merkle path to the record, verified against the key in the attester's
DID document and cached. The verifying mount, which never reaches for the network, checks the
cache, and `bundle trust` keeps it fresh. Attestations are found without naming attesters in
advance: the record's `hash` field is indexed by Constellation, a backlink index over the
whole network, and every DID it names is fetched and verified before it counts.
[proposals/atproto-attestations.md](../proposals/atproto-attestations.md) has the details.

## Listings

A listing is a record in the publisher's repository, keyed by the name the bundle installs
as, naming where to fetch it: a URL, or a domain whose `nzip:` TXT record names one. It has no
hash and no version, so a release is still just whatever the URL serves next, and a listing
vouches for nothing.

Every app's listing carries the same `subject`, the sha256 of the lexicon's NSID. That one
value is what makes listings findable without a service of our own: Constellation indexes
every field that parses as a URI, so asking what links to it enumerates every app listed. A
plugin's listing names the app's listing as its subject instead, so it never appears among
apps, and asking what links to an app's listing finds exactly its plugins.

Search is local, against an SQLite index (`node:sqlite`, FTS5) synced as cheaply as the
network allows: one pass over the backlinks, then one revision check per publisher, and a
refetch only where a repository moved. Plugins are followed only for apps installed here.
[proposals/atproto-listings.md](../proposals/atproto-listings.md) has the details, and what
replaces Constellation once it stops scaling.

## Plugins

A plugin is a bundle an app loads by package name. The decisions that shape it:

- **Ordinary resolution.** Hosts already find plugins with `require` and `import`. A
  `module.registerHooks()` resolve hook keeps that working, answering only names nothing else
  can, so a plugin can never stand in for a builtin or the host's own dependency.
- **Scopes, not the PATH.** A plugin is for one app, so it lives in that app's directory,
  named after the app's package name, which survives renames and is known to the app at
  runtime.
- **Checking at load is opt-in**, as it is for apps, except under a verifying runtime, which
  asked for nothing unverified to be mounted in its process.
- **Judged as a plugin.** A plugin's author is not the app's, so nothing that describes the
  app's author (its signer, its roots, its `apps` policy section) applies to it. Only what
  holds whoever the author is carries over from the runtime: attestations, blocks, and that a
  signature is needed. The policy's `scopes` section and the host's own rules add to that,
  and nothing can loosen it.
- **A light loader.** The loader ends up inside every host's bundle, so it imports nothing
  heavy and needs no `--experimental-vfs` to load. The verifier is loaded the first time
  something is verified, and under a verifying runtime it is the runtime's own.
- **One version per name per scope**, with no dependency resolution. Shared code for a suite
  of apps goes in a shared scope. This is deliberately not a way to bundle npm packages one at
  a time.

The API is in [api.md](api.md#plugins-pipobscurebundleplugins), and the reasoning in full in
[proposals/plugins.md](../proposals/plugins.md).

## What it does and does not prove

**It proves provenance.** The code is the code that was signed, by someone holding that
certificate, and the runtime enforces it rather than the application checking itself.

**It does not prove safety.** Every significant npm compromise of recent years shipped a
correctly published, correctly signed package from a legitimately compromised account. A
signature would have confirmed it came from the real maintainer and been useless. That is
what step 3 is for, and why it is a separate step performed by a reviewer rather than a
property of the format.

Other limits, stated plainly:

- **VFS is not a sandbox.** It redirects `fs` calls; it does not confine untrusted code.
  Verified code runs with the full authority of the process.
- **The gate is only as strong as how Node was launched.** Anyone who can change the command
  line can drop the `-r`, and the mount falls back to the built-in provider, which checks
  nothing. Registration is a userland opt-in, not a runtime policy. A SEA closes this for
  itself by carrying its own bootstrap.
- **A plugin runs with the full authority of its host.** Loading it is no more contained than
  any other `import`. What vouches for it is the review at install and, when asked for, the
  check at load. Without that check, a plugin is what `bundle install` accepted, and
  `installed` and `validate` are what notice it changed since.
- **A shebang archive does not self-verify.** The kernel gives it no preload flag to carry a
  provider. Mount it with the preload, or use a SEA.
- **A sigstore signature is public.** Signing puts your identity, the archive's hash and the
  time in an append-only log. That is the mechanism working — it is what makes the
  ten-minute certificate verifiable later — not something to discover afterwards.
- **Everything here is experimental**, including the Node it needs.

## What it needs from Node

Everything here sits on Node's experimental `node:vfs` (by Matteo Collina) and runs under
`--experimental-vfs`. Where each piece stands, as of 2026-09-02:

| Piece | Where it is |
|---|---|
| **`node:vfs`**, and modules resolving and loading out of a mount | released, v26.4.0 |
| **ZIP support in `node:zlib`** — `ZipFile`, `ZipBuffer`, `ZipEntry` | released, v26.8.0 |
| **`ZipProvider`**, a VFS provider backed by such an archive | released, v26.9.0 — [nodejs/node#64915](https://github.com/nodejs/node/pull/64915) |
| **Native addons loaded from a mount** | released, v26.9.0 — [nodejs/node#65680](https://github.com/nodejs/node/pull/65680) |
| **`"useVfs"`**, a SEA's assets behind a VFS mount | released, v26.9.0 — [nodejs/node#65675](https://github.com/nodejs/node/pull/65675) |
| **`--vfs-load`**, and `vfs.registerProvider()` | released, v26.10.0 — [nodejs/node#65748](https://github.com/nodejs/node/pull/65748) |
| **`"vfsArchive"`**, a ZIP as a SEA's file system — `bundle sea` only | released, v26.11.0 — [nodejs/node#65810](https://github.com/nodejs/node/pull/65810) |
| **The `--vfs-load` source at the same mount point in every thread** | released, v26.11.0 — [nodejs/node#66162](https://github.com/nodejs/node/pull/66162) |

v26.9.0 already had everything a program needs to *be* an archive: it reads ZIP archives,
turns one into a file system, resolves modules out of it, and loads native addons from it.
v26.10.0 added the way to ask for that mount from *outside* the program, which is the whole
hinge: **`--vfs-load`** makes a mounted tree the thing a program resolves and runs from, and
the same pull request brings `vfs.registerProvider()` — the extension point that lets a
preload decide what backs a mount, and therefore the one that makes a *verifying* mount
possible from userland at all.

**`--vfs-load` is the only flag.** v26.10.0 also shipped `--vfs-mount`, which mounted a source
without running it, and v26.11.0 removes it
([nodejs/node#66162](https://github.com/nodejs/node/pull/66162)): nothing needs more than one
mount from the command line, and a program that wants more mounts them through `node:vfs`,
where it also holds the instance. The same change reserves layer 0 for the `--vfs-load`
source, so it sits at the same mount point in every thread whatever else is mounted, and
mounts a program makes itself are numbered from 1. Nothing here uses `--vfs-mount`, and
mount points stay node's to assign: named mounts
([nodejs/node#66119](https://github.com/nodejs/node/pull/66119)) were closed rather than
merged.

[nodejs/node#65810](https://github.com/nodejs/node/pull/65810), in v26.11.0, is what building an
executable needs. It lets a SEA's file system *be* a ZIP archive rather than a list of assets,
which is how this package gets inside one: `bundle sea` embeds the verifier bundle whole and
node mounts it. The reserved mount point of #66162 is what lets a worker thread reach the
`--vfs-load` source at the path its main thread uses, and so start a script from it.

Native addons out of a mount shipped in v26.9.0, as
[nodejs/node#65680](https://github.com/nodejs/node/pull/65680), which closed the last gap in
what a bundle can contain. A `dlopen()` needs a path with an inode behind it and a VFS path
has none, so it reads the addon's bytes out of the mount and loads them from a private,
self-cleaning image instead — an anonymous memfd on Linux, an unlinked temp file elsewhere.
Before it, a bundle whose dependency tree included a `.node` file mounted fine and then failed
at `require`.

[HISTORY.md](../HISTORY.md) explains each in detail and why they are worth having.

`openssl` on `PATH` is needed only to generate the throwaway PKI the tests use.

## Working on this repository

```sh
npm install
npm run build          # TypeScript -> dist/, with declarations
npm test               # the whole suite; generates a throwaway PKI into build/certs/ on first run
npm run typecheck
```

The suite needs Node 26.11.1 or later, including the tests that build an executable. On a Node
whose `--build-sea` lacks `vfsArchive` those skip themselves and say why. [CI](../.github/workflows/ci.yml)
runs the suite on every push to `main` and every pull request, on 26.11.1 — the floor
`package.json` promises.

Tests import the sources rather than the build, so they run under Node's type stripping. The
test PKI is generated on demand by `tools/testpki.ts` and is **never committed** — a private
key in a repository is a private key people sign with, and it would produce signatures that
look like provenance and carry none.

Building the tool the way the tool says to build things — the same four steps:

```sh
npm run release:cli         # 1-3: observe, pack, fetch the baseline, stop at the gate
npm run sign:cli:local      # 4: refuses — nothing has been audited yet
BUNDLE_AUDIT_VERDICT=build/cli.audit.json claude "/audit-bundle build/cli.unsigned.nzip"
npm run sign:cli:local      # 4: now allowed -> bundle.nzip
```

| Script | |
|---|---|
| `manifest:cli` | observe a run, close over the dependencies, write the file list |
| `pack:cli` | `bundle create --launcher` over that list |
| `baseline:cli` | fetch and verify the published release, to review against |
| `audit:cli` | `bundle audit` — report the diff and print the skill invocation |
| `approve:cli` | `bundle audit --approve` |
| `sign:cli` | `bundle audit --check`, then `bundle sign` through sigstore |
| `release:cli` | steps 1–3, stopping at the gate |

Only `manifest:cli` and `baseline:cli` are scripts of their own; the rest are the CLI. The
first observes a run and computes a dependency closure, the second fetches this package's
own published release from npm — both specific to how *this* project is built.

**The gate is real, and it is a shipped command** — `bundle audit --check`, not repo
tooling. It runs before signing, reads the JSON verdict the skill writes, and refuses unless
that verdict passed *and* pins the sha256 of the bytes on disk. Everything this repository
does to release itself is something you can do to your own project.

[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) is the whole pipeline as a
workflow — test, pack, fetch the published release, audit the diff, gate, sign through
sigstore with the workflow's OIDC identity, publish through npm trusted publishing, every
action pinned to a commit SHA. It runs whenever CI passes on `main` and does nothing unless
`package.json` names a version npm does not have yet: bumping the version *is* the release.
There is no npm token anywhere; npm trusts that workflow file by name.
