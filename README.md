# @pipobscure/bundle

Ship a Node.js application as **one signed file** that the runtime refuses to run if it has
been tampered with.

```sh
bundle create --base ./app --files app.manifest --output app.run   # archive it
bundle sign --launcher --output app.nzip app.run                   # sign, via sigstore
./app.nzip                                                         # and it is a program
```

The archive is a real ZIP with a signature over the whole file. Mounting it through
`node:vfs` is what enforces that signature: the provider verifies before it returns a
filesystem, so an archive that does not check out never becomes one and its entry point
never runs. Every member is re-hashed against its signed digest as it is read, for the life
of the process.

> **Requires Node 26.11.1 or later**, run with `--experimental-vfs`. Every piece this needs is
> in a released Node; the last, a SEA's file system as a ZIP archive, shipped in v26.11.0.
> See [Requirements](#requirements). Everything here is experimental.

---

## Contents

- [Installing bundle](#installing-bundle) · [The four steps](#the-four-steps) · [CLI reference](#cli-reference)
- [Using it from code](#using-it-from-code) · [Exports](#exports)
- [Executables that verify before they run](#executables-that-verify-before-they-run) · [Plugins](#plugins)
- [How it works](#how-it-works) · [What it does and does not prove](#what-it-does-and-does-not-prove)
- [Requirements](#requirements) · [Development](#development) · [Reading further](#reading-further)

---

## Installing bundle

```sh
npx @pipobscure/bundle install      # -> a signed `bundle` on your PATH
bundle --help
bundle update                       # later, when there is a new release
```

That is the whole install: npm fetches the package once, and what stays behind is the signed
archive itself, on your PATH and keeping itself current. Or take it from the release page and
skip npm altogether — Node 26.11.1 or later is all it needs:

```sh
curl -LO https://github.com/pipobscure/bundles/releases/latest/download/bundle.nzip
chmod +x bundle.nzip
./bundle.nzip install                # the same thing: fetch, verify, put on PATH
```

As a library instead:

```sh
npm install @pipobscure/bundle
```

The `.nzip` extension is what makes an archive runnable on Windows, where the association is
by extension. On unix it means nothing, so `bundle install` drops it and leaves you a command
called `bundle`.

Releases are signed by the [publish workflow](.github/workflows/publish.yml), so the
identity to pin when you check one is
`https://github.com/pipobscure/bundles/.github/workflows/publish.yml@refs/heads/main`, issuer
`https://token.actions.githubusercontent.com`. The audit verdict each was signed under sits
beside it as `cli.audit.json`.

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
[the tool as a bundle of itself](HISTORY.md#where-this-ends-up-the-tool-as-a-bundle-of-itself).

Running it by name does not verify it — the kernel gives a `#!` launcher no preload to carry
a provider, and this package says so rather than pretending otherwise. Verification is a
separate act, done with a copy of `bundle` you already trust: `bundle verify bundle.nzip` to
check it, or `bundle run bundle.nzip <args>` to execute it through the verifying mount.

---

## The four steps

Building a bundle is four steps, in this order:

```
1. observe   run the application, and write down every file it actually reads
2. create    archive exactly that list, unsigned          -> app.run
3. audit     review it — against the last release, if there is one
4. sign      only if step 3 came back clean               -> app.nzip
```

**The two extensions say which is which.** A `.run` is an archive that has not
been signed — the thing step 3 reviews. A `.nzip` has been, and is what anything
else should be handed. The verifying provider knows the difference: registered,
it claims every archive it is offered and mounts only the ones that verify, so a
`.run` does not run through it at all. Running an unsigned archive is something
you do deliberately, with that provider out of the picture.

### 1. Observe

Static analysis is perennially wrong about dynamic `require`, data files and conditional
imports. So the file list comes from running the thing:

```sh
BUNDLE_MANIFEST=app.manifest node --experimental-vfs \
    -r @pipobscure/bundle/record --vfs-load=./app -- <args>
```

Every file read through the mount is appended to `app.manifest`, one path per line, as it is
read — so a killed process still leaves a usable list. Read-only `open()`s count too, which
catches streamed files that a `readFile` hook would miss.

Observation has one blind spot worth knowing: code on a path the run never took. For a
dependency tree, pair it with a computed closure — see [`moduleFiles`](#using-it-from-code).

### 2. Create

```sh
bundle create --base ./app --files app.manifest --output app.run
```

Unsigned, and deliberately so. This is the single input to every shape you ship.

### 3. Audit

A signature is a claim about bytes you stand behind, so the review belongs *before* it:

```sh
bundle audit app.run             # what is about to be reviewed, and how
bundle skill                        # install the audit skill into .claude/skills/
claude "/audit-bundle app.run"   # verify, extract, read every member
bundle audit --check app.run     # exits non-zero without a clean verdict
```

`bundle audit` does the two mechanical halves around the review. On its own it reports the
archive's hash, its members and — with `--baseline <previous>` — what changed since the last
release you approved. With `--check` it is a **gate**: it reads the JSON verdict the skill
writes and refuses unless that verdict passed *and* names the sha256 of the bytes on disk,
so rebuilding invalidates an approval. `--approve --note '<what you checked>'` records a
verdict you reached by reading the archive yourself.

There is deliberately no environment variable that turns the gate off. It is a command you
choose to put in your pipeline — if you do not want it, do not put it there.

[`audit-bundle`](skills/audit-bundle/SKILL.md) is a [Claude Code](https://claude.com/claude-code)
skill that verifies the archive, extracts it, and security-reviews every file — load-time
hooks, encoded payloads, outbound calls, credential and CI-token reads, `eval` and dynamic
`require`, and members nothing references. Because a bundle is a **closed set** — nothing
resolves later, nothing is fetched at install — the review can actually be complete.

It is the same review whoever receives the bundle should run before trusting it. That is the
point: hold your own artifact to the standard you would hold someone else's. It can also
review only the **diff** against a previously approved archive, which is the realistic
repeat-use case.

### 4. Sign

```sh
bundle audit --check app.run && bundle sign --launcher --output app.nzip app.run
```

Through **sigstore** by default: an ambient CI identity when there is one, otherwise a
browser sign-in. No long-lived key exists to steal — the certificate lasts about ten
minutes, and a transparency-log entry and timestamp are what let it verify afterwards.

Or against a certificate authority of your own:

```sh
bundle sign --key leaf.key --chain chain.pem --output app.signed.nzip app.run
```

Signing is separate from building, and that is what makes one build serve every target:

```sh
bundle sign --launcher --output app.nzip          app.run   # a file you can run by name
bundle sea             --output app.sea           app.run   # standalone executable
bundle sign            --output app.signed.nzip   app.run   # plain, for a mount
```

Each is correctly offset and signed over its own finished bytes. `--launcher` prepends the
shell prefix this package ships, so nobody has to know it lives inside `node_modules`;
`--prefix <file>` takes a launcher of your own, or a node binary.

---

## CLI reference

Everything `bundle` does, command by command. `bundle --help` prints the same options in
brief; this is the long form.

```
bundle <command> [options] [arguments]
bundle --help          bundle -v, --version
```

| Building and signing | |
|---|---|
| [`create`](#create) | build an unsigned archive from a list of files |
| [`audit`](#audit) | report what is about to be reviewed, and gate signing on the verdict |
| [`sign`](#sign) | sign an archive into a new file, optionally behind a launcher or a binary |
| [`sea`](#sea) | build a node runtime that verifies an archive before running it |

| Checking and running | |
|---|---|
| [`verify`](#verify) | verify an archive and report its trust state |
| [`run`](#run) | verify an archive, mount it, and run what is inside |

| Vouching | |
|---|---|
| [`attest`](#attest) | vouch for archives from an atproto account, warn against them, or withdraw that |
| [`lexicon`](#lexicon) | show, check or publish the atproto lexicons attestations and listings are written in |

| Publishing and finding | |
|---|---|
| [`publish`](#publish) | list an archive's URL under a name, so others can find and install it |
| [`unpublish`](#unpublish) | take a listing down again |
| [`search`](#search) | search the listed archives by name, description and publisher |
| [`listings`](#listings) | every listed archive, from a local index kept in step with the network |

| Installing and keeping current | |
|---|---|
| [`install`](#install) | fetch an archive from a URL, a domain or a listing, review it, and put it on your PATH |
| [`update`](#update) | refetch what was installed, and replace it if a new version is accepted |
| [`installed`](#installed) | list what is installed, and re-check each against its record |
| [`validate`](#validate) | re-check installs, and say what has been attested since |
| [`uninstall`](#uninstall) | remove an install, and forget where it came from |

| Trust and policy | |
|---|---|
| [`trust`](#trust) | refresh the sigstore trust root and the cached attestations |
| [`policy`](#policy) | show, start or check the rules this machine installs by |

| Setting up | |
|---|---|
| [`shell`](#shell) | print what to load at shell start: Tab completion, and a quiet re-check |
| [`skill`](#skill) | install the bundle-auditing skill into a project |

### Conventions

- **Options come before arguments.** `--name value` and `--name=value` both work. A short
  option takes its value as the next word: `-o app.nzip`.
- **Options that are on by default are turned off with `--no-`**: `--no-discover`,
  `--no-sigstore`, `--no-shell`, `--no-validate`, `--no-complete`.
- **Repeatable options** (`--root`, `--attester`, `--block`) may be given as many times as needed.
- **Durations** (`--every`, `--timeout`, `--max-age`, the policy's `maxAge`) are a number with
  an optional unit: `90s`, `30m`, `12h`, `7d`. A bare number is seconds.
- **Attesters** are written `[kind@]<did or handle>`: `did:web:audit.example.com`,
  `audited@did:plc:ewvi7nxzyoun6zhxrhs64oiz`, `audited@alice.example.com`. A handle is resolved
  to its DID when the command runs, and checked both ways: the DID's document must claim the
  handle back. Only the DID is ever stored or baked into anything, because a handle can change
  hands. With a kind, only attestations of that kind count.
- **Installs are named** by the name they were installed under (`tool`), by the URL they came
  from, by the domain whose `nzip:` record named them, or by the listing they were installed
  from, as `@<did>/<name>`. A plugin is named `<app's package>:<plugin's package>`
  (`bled:@alice/bled-gpio`).
- **Errors go to stderr**, results to stdout. `--json`, where offered, prints a machine-readable
  result on stdout and nothing else there.
- **Nothing is done without asking that is not yours to decide.** A signer or attester nobody
  has accepted is a question; editing your shell's startup file is a question. With no
  terminal to ask on, those commands stop and say so (exit 4) rather than assume a yes.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Done. For `verify`, `run` and friends: **valid**, meaning genuine and trusted as asked. |
| `1` | **valid-untrusted**: genuine, but not vouched for the way it was required to be: an unanchored certificate, a missing sigstore trust root, a signer or attesters other than the ones demanded. `validate`: a new warning. `trust`: a refresh failed. `lexicon check`: not published as this version. |
| `2` | **invalid**: the bytes changed since signing, a member does not match its digest, the archive no longer parses, something was appended after its end, or an attester you block on has marked it bad. For `installed` and `validate`: also an install that is missing, or was replaced by something other than `update`. |
| `3` | **unsigned**: no signature, and nothing else vouching for it. |
| `4` | **Needs a decision**: `install` or `update` found evidence nobody has accepted yet and had no terminal to ask on (pass `--yes` to accept what it shows), or you declined. |
| `64` | No command given. |
| `70` | Anything else that went wrong: a bad option, a file that is not there, a network error. The message says what. |

"Could not check" is never `2`. A missing trust root or library is `1`, because conflating "I
could not tell" with "this is forged" is how people learn to click through warnings.

### Building and signing

#### `create`

```
bundle create [options] < file-list
bundle create --base ./app --files app.manifest --output app.run
```

Builds an archive from a newline-separated list of files, read from `--files` or from stdin,
relative to `--base`. Each member records the digest of its own content, and an
`AUTHORITY.PEM` member declares the algorithms. The result is **unsigned**, deliberately:
it is the one input to every shape you then sign ([`sign`](#sign), [`sea`](#sea)), and the
thing [`audit`](#audit) reviews. By convention it is called `.run`.

| Option | |
|---|---|
| `-b, --base <dir>` | the directory the file list is relative to (default: `.`) |
| `-f, --files <file>` | read the file list from here (default: stdin) |
| `-o, --output <file>` | write the archive here (default: stdout) |
| `-p, --prefix <file>` | put this in front of the archive: a launcher or a node binary. Omit it for a plain archive, to be run from a mount. |
| `-k, --key <file>` | sign as it is built, with this private key (PEM) — only with `--chain` |
| `-c, --chain <file>` | the certificate chain for `--key` (PEM, leaf first) |
| `--hash <alg>` | the digest for the whole-file hash and the member digests (default: `sha256`) |
| `--sign <alg>` | the digest the signature uses (default: `sha256`) |

Signing at build time is for a certificate authority of your own. To sign through sigstore,
create unsigned and use [`sign`](#sign).

#### `audit`

```
bundle audit [options] <archive>
bundle audit app.run                                  # what is about to be reviewed, and how
bundle audit --baseline last-release.nzip app.run     # ...as a diff against what was approved before
bundle audit --check app.run && bundle sign …         # the gate
bundle audit --approve --note 'read every member' app.run
```

The review itself needs judgement, so no command performs it. `audit` does the two mechanical
halves around it.

- **On its own**, it reports the archive's hash and members, and how to run the review: the
  [`audit-bundle`](skills/audit-bundle/SKILL.md) skill (see [`skill`](#skill)), or reading it
  yourself. With `--baseline`, it says what was added and removed since an archive you approved
  before, so the review can be of the difference.
- **`--check`** is the gate. It reads the JSON verdict (the skill writes one) and exits
  non-zero unless that verdict passed, names the sha256 of the bytes on disk, and was reached
  against the same baseline. Rebuilding invalidates an approval.
- **`--approve`** records a passing verdict you reached by reading the archive yourself,
  pinned to its bytes, with `--note` saying what you checked.

| Option | |
|---|---|
| `-b, --baseline <file>` | a previously approved archive to review against |
| `-v, --verdict <file>` | where the verdict is (default: `<archive>.audit.json`) |
| `--check` | exit non-zero unless a clean verdict pins these bytes |
| `--approve` | record a clean verdict you reached yourself |
| `-n, --note <text>` | what you checked, recorded with `--approve` |

There is deliberately no switch that turns the gate off. It is a command you choose to put in
your pipeline.

#### `sign`

```
bundle sign [options] <archive>
bundle sign --launcher --output app.nzip app.run                 # runs by name, signed through sigstore
bundle sign --output app.signed.nzip app.run                     # a plain archive, for a mount
bundle sign --key leaf.key --chain chain.pem --output app.nzip app.run   # your own CA
```

Re-emits an archive's members into a new file, behind whatever prefix is asked for, and signs
the finished bytes. The input is never modified. The signature covers the **whole file**:
the prefix, every member, and the central directory. So each shape (a launcher, an executable,
a plain archive) is correctly offset and signed over itself.

**Through sigstore by default.** The signing certificate is issued for an identity you sign in
as. In CI that is the workflow's own token; elsewhere it is a browser sign-in, or a device
code. It is valid for about ten minutes, so there is no long-lived key to steal. A
transparency-log entry and a timestamp, recorded with the signature, are what let it verify
afterwards. Or sign against a certificate authority of your own with `--key` and `--chain`.

| Option | |
|---|---|
| `-o, --output <file>` | write the signed archive here (default: stdout) |
| `-l, --launcher` | prepend this package's two-line `#!/bin/sh` launcher, so the result runs by name. The usual way to make a self-executing archive. |
| `-p, --prefix <file>` | prepend some other prefix: a launcher of your own, or a node binary |
| `-x, --executable` | make the output executable (implied by `--launcher` and `--prefix`) |
| `--hash <alg>`, `--sign <alg>` | as for [`create`](#create) |
| `-k, --key <file>` | sign with this private key (PEM) instead of sigstore — with `--chain` |
| `-c, --chain <file>` | the certificate chain for `--key` (PEM, leaf first) |
| `--flow <how>` | how to get a sigstore identity: `auto` (the default: CI if there is one, else a browser, else a device code), `ci`, `browser`, `device` |
| `--token <jwt>` | use this OIDC token instead of signing in |
| `--oidc-issuer <url>` | the OIDC issuer to sign in with (default: sigstore's) |
| `--connector <name>` | the identity provider to go straight to: `github` (the default), `google`, `microsoft` |
| `--fulcio <url>` | the certificate authority (default: `fulcio.sigstore.dev`) |
| `--rekor <url>` | the transparency log; an empty string skips it |
| `--tsa <url>` | the timestamp authority; an empty string skips it |

A sigstore signature is public by design: your identity, the archive's hash and the time go
into an append-only log.

#### `sea`

```
bundle sea --output <file> [options] [archive]
bundle sea --output app.sea --identity '<workflow>' --issuer '<issuer>' app.run   # the application
bundle sea --output node-verifying --root my-root.pem                             # a verifying node
```

Builds a node runtime with this package's verifier inside it.

- **With an archive, the result is that application:** one executable that verifies its own
  signature before running anything. The signature covers the runtime and the verifier too.
- **Without one, the result is a verifying node:** a runtime that takes an archive on its
  command line (`./node-verifying app.zip --args`), verifies it, and runs it. `--verify`
  reports the trust state without running anything.

The policy flags given here (`--root`, `--identity`, `--issuer`, `--attester`, `--quorum`,
`--max-age`, `--untrusted`) are **baked in**, and a runtime with a policy is **sealed**: its
command line cannot loosen that policy. `--block` only ever tightens, so the runtime accepts
it at any time. Signing works as for [`sign`](#sign): sigstore by default, or `--key` and
`--chain`. Attestations are checked against the cache [`trust`](#trust) keeps, never the
network.

| Option | |
|---|---|
| `-o, --output <file>` | where to write the executable (required) |
| `--node <file>` | the node binary to embed (default: the one running) |
| `--base <file>` | reuse a runtime built before, instead of building one |
| `--no-sigstore` | leave the sigstore libraries out of the verifier (it can then check only certificate-chain signatures) |
| `-r, --root <file>` | a trusted root the executable checks against; repeatable |
| `--identity <san>`, `--issuer <url>` | the sigstore signer the executable requires |
| `--attester <[kind@]who>` | an attester the executable requires; repeatable. Handles are resolved now; the DID is baked. |
| `--quorum <n>` | how many of the attesters (default: all) |
| `--max-age <time>` | how stale a cached attestation may be (default: `7d`) |
| `--block <who>` | refuse what this DID or handle has marked bad; repeatable |
| `--untrusted` | let it run an archive whose signature is good but unanchored |
| `-k`, `-c`, `--hash`, `--sign`, `--flow`, `--token`, `--oidc-issuer`, `--connector`, `--fulcio`, `--rekor`, `--tsa` | signing, as for [`sign`](#sign) |

Building an executable needs a Node with
[nodejs/node#65810](https://github.com/nodejs/node/pull/65810); see
[Executables that verify before they run](#executables-that-verify-before-they-run).

### Checking and running

#### `verify`

```
bundle verify [options] <archive>
bundle verify --root ca.pem --json app.nzip
bundle verify --identity '<workflow>' --issuer https://token.actions.githubusercontent.com app.nzip
bundle verify --attester audited@did:web:audit.example.com app.nzip
```

Recomputes the whole-file hash, checks the signature over it, checks every member's digest,
and decides whether whoever signed it means anything to you. It reports one of four states
and exits with the matching code:

| State | Exit | Meaning |
|---|---|---|
| `valid` | 0 | Hash, signature and every member digest are sound, and it is trusted as asked. |
| `valid-untrusted` | 1 | All of that is sound, but it is not vouched for as required: a certificate you cannot place, a missing sigstore trust root, a signer other than the one demanded, attestations missing. |
| `invalid` | 2 | The bytes changed since signing, a member's digest does not match its content, the archive no longer parses as a ZIP, something was appended after its end, or an attester you `--block` on marked it bad. |
| `unsigned` | 3 | No signature, and no attestations vouching for it. |

A certificate chain is trusted only for what it was issued for. The leaf must carry the
code-signing extended key usage, and everything above it must be a CA. Otherwise the key of any
publicly trusted certificate, a web server's included, could sign an archive that reads as
`valid`. A root given with `--root` that *is* the leaf is trusted as itself: that is pinning.

`--identity` and `--issuer` demand a particular sigstore signer, matched exactly, never as a
pattern. An archive signed against an ordinary CA carries no identity at all, so under such a
demand it is `valid-untrusted`, not passing.

With `--attester`, attestations are required instead of, or as well as, a signer (see
[`attest`](#attest)). A signature is then optional: if present it must verify, but its
certificate only has to be trusted when `--identity`/`--issuer` ask for a signer too.
The attesters' proofs are fetched first; if that fails, the cache answers, for as long as
`--max-age` allows.

| Option | |
|---|---|
| `-a, --archive <file>` | the archive (or give it as the argument) |
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `--identity <san>` | require this sigstore signing identity |
| `--issuer <url>` | require this sigstore OIDC issuer |
| `--sigstore-root <file>` | the sigstore trust root to check against (default: the one [`trust`](#trust) keeps) |
| `--attester <[kind@]who>` | require an attestation from this DID or handle; repeatable |
| `--quorum <n>` | how many of the attesters must have attested (default: all of them) |
| `--max-age <time>` | how stale a cached attestation may be (default: `7d`) |
| `--block <who>` | refuse it if this DID or handle has marked it bad; repeatable |
| `--json` | print the result as JSON |

#### `run`

```
bundle run [options] <archive> [arguments for the program…]
bundle run --root ca.pem app.signed.nzip --its --own --flags
```

Verifies the archive exactly as [`verify`](#verify) does, mounts it through the verifying
provider, and runs its entry point **in this process**, the way a verifying runtime does. Every
member is re-hashed against its signed digest as it is read, for as long as the process lives.
Nothing from the archive runs unless it is `valid` (or `valid-untrusted` with `--untrusted`).

**`run`'s own options come before the archive, and everything after it belongs to the
program**, flags included. A `--` there is accepted too, out of habit, but not needed.

| Option | |
|---|---|
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `--identity <san>`, `--issuer <url>` | require this sigstore signer |
| `--attester <[kind@]who>`, `--quorum <n>`, `--max-age <time>`, `--block <who>` | as for [`verify`](#verify) |
| `--untrusted` | run an archive whose signature is good but whose certificate is unanchored. It never waives what the other flags demand. |

There is no child process and no preload: the provider is already registered in the process
doing the mounting. The cost is isolation: the program shares the process with this package.
For a process of its own, spawn node with the arguments [`mountArgv`](#using-it-from-code)
returns.

### Vouching

#### `attest`

```
bundle attest [options] <archive>...
bundle attest --as audit.example.com --kind audited app.nzip app.sea app.run   # one sign-in for all three
bundle attest --as scanner.example --verdict bad --kind malware app.nzip
bundle attest --as audit.example.com --revoke app.nzip
```

An attestation is an atproto record, in the attester's own repository, saying *I vouch for the
archive with this whole-file hash*: the same hash a signature covers. It can say what kind of
claim it is (`published`, `audited`, `reproduced`), or it can say the opposite: `--verdict bad`
warns everyone who installs the file, with `--kind` saying why (`malware`, `vulnerable`, …).
Anyone with an atproto account (any `did:plc` or `did:web`) can attest, and only they can
withdraw their attestation.

- **Every archive named is checked first.** One whose bytes or signature do not hold
  together stops them all, before anyone signs in.
- **Then one sign-in covers them all.** It uses OAuth in the browser, against the account's
  own PDS. It asks for write access to attestation records and nothing else
  (`repo:com.pipobscure.bundle.attestation`). It falls back to general write access only on a
  server that does not offer that, and says so.
- **Nothing is kept.** The session is revoked when the command is done, so every attestation
  is approved by whoever it speaks for. In CI, where there is no browser, an app password
  from `BUNDLE_ATPROTO_PASSWORD` or `--password-file` is used instead.
- **What it writes** is `at://<your DID>/com.pipobscure.bundle.attestation/<hash>`: one record
  per account per file, so attesting again replaces the old record.

How attestations are used, and what they do and do not prove, is in [`install`](#install),
[`verify`](#verify), the [policy](#policy) and
[proposals/atproto-attestations.md](proposals/atproto-attestations.md).

| Option | |
|---|---|
| `--as <handle or did>` | the account to attest as (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--kind <kind>` | what is being said: `published`, `audited`, `reproduced`, or with `--verdict bad`, `malware`, `vulnerable`, … |
| `--verdict <good or bad>` | `good` (the default) vouches for the file; `bad` warns against it |
| `--note <text>` | a short note kept with the attestation |
| `--revoke` | withdraw your attestations of these archives instead |
| `--password-file <file>` | use an app password from this file instead of signing in (`BUNDLE_ATPROTO_PASSWORD` works too). Never take a password as an argument. |
| `-r, --root <file>` | an extra trusted root, for checking the archives first; repeatable |

Different shapes of one release are different bytes. Attest each one you publish.

#### `lexicon`

```
bundle lexicon                                   # what needs publishing, and where
bundle lexicon check                             # is it published, and current?
bundle lexicon publish --as pipobscure.com --dry-run
bundle lexicon publish --as pipobscure.com
```

Attestations are written in the lexicon `com.pipobscure.bundle.attestation`, and listings in
`com.pipobscure.bundle.listing`. For the network to resolve and validate them, each is
published in two parts. The first is a DNS TXT record `_lexicon.bundle.pipobscure.com` saying
`did=<DID>`, which covers both. The second is a `com.atproto.lexicon.schema` record per
lexicon in that DID's repository, holding the lexicon document.

- With no subcommand, `lexicon` lists the lexicons this package carries and the record each
  needs.
- **`check`** resolves the DNS record and fetches the published schema with its proof,
  verified. It says whether that schema is current, different, unpublished, or has no DNS
  record. It exits `1` unless all are current.
- **`publish`** writes each schema record from `--as`. It signs in with access to
  `com.atproto.lexicon.schema` and nothing else, refuses an account the DNS record does not
  name (unless `--force`), and reads each record back to confirm it.

This is for whoever owns the lexicons' domain; using attestations or listings needs none of it.

| Option | |
|---|---|
| `--as <handle or did>` | the account to publish from (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--dry-run` | say what `publish` would write, and stop before signing in |
| `--force` | publish even though DNS does not name that account yet |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |

### Publishing and finding

A **listing** is an atproto record, in the publisher's own repository, that makes an archive
findable and installable by name:

```
at://<your DID>/com.pipobscure.bundle.listing/bled
{ "subject": "sha256:aa2e2af5…1169", "url": "https://github.com/…/releases/latest/download/bled.nzip",
  "title": "bled", "description": "…", "createdAt": "…" }
```

It says where and nothing else: no hash, no version. Point it at a URL that stays the same
across releases, and publishing a new version is still just making a release. Or, in place of
the URL, name a domain whose `nzip:` TXT record names it (`"domain": "bled.pip.fyi"`), and
keep managing the URL in DNS, as for [`install`](#install) by domain. A listing vouches
for nothing. What `bundle install @<account>/<name>` fetches from that URL is reviewed exactly as
any download is.

Every listing's `subject` is the same value, the sha256 of the lexicon's NSID. That is what makes
them findable with no service of our own: the backlink index (Constellation) indexes every field
that parses as a URI, so asking it what links to that one value lists every listing on the network.
`search` and `listings` keep a local index of them, and search that.

#### `publish`

```
bundle publish [options] <name> <url | domain>
bundle publish --as pipobscure.com --description 'blink an LED' bled https://github.com/pipobscure/bled/releases/latest/download/bled.nzip
bundle publish --as pipobscure.com --description 'blink an LED' bled bled.pip.fyi     # the URL is the TXT record's to say
bundle publish --as alice.example --for @pipobscure.com/bled bled-gpio https://…/bled-gpio.nzip   # a plugin for bled
```

Writes `at://<your DID>/com.pipobscure.bundle.listing/<name>`, naming the URL, or the domain.
A listing that names a domain follows its `nzip:` TXT record wherever it points, on every
install and update. `<name>` is lowercase letters,
digits and `-`, at most 64, and is what the archive installs as. Publishing the same name again
replaces the listing, keeping when it was first listed.

- **The URL is checked first**, before anyone signs in, and for a domain that is the URL its
  TXT record names now. It must be `https:`, and it is fetched:
  something that is not an archive, or whose bytes or signature do not hold together, is
  refused. An unsigned archive is published with a warning, since installs will only accept it
  on the strength of attestations.
- **Signing in** works as it does for [`attest`](#attest): OAuth in the browser, asking for write
  access to listing records only (`repo:com.pipobscure.bundle.listing`), and nothing kept
  afterwards. In CI, an app password from `BUNDLE_ATPROTO_PASSWORD` or `--password-file`.
- **The record is read back** to confirm what landed is what was sent.
- **A plugin is listed against its app.** With `--for`, the listing's `subject` is the
  `at://` address of the app's listing, not the concept hash. So it never appears among apps,
  and `search --for` and `listings --for` find exactly that app's plugins. An app installed
  from a URL or a domain has no listing for plugins to name, so its plugins can't be listed.
  They still install with `install --for`, from a URL or a domain.

| Option | |
|---|---|
| `--as <handle or did>` | the account to publish from (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--for <app>` | list it as a plugin for this app: an app installed from its listing, `@<handle or did>/<name>`, or an `at://` address |
| `--title <text>` | a display name (default: the name) |
| `--description <text>` | what it is, in a sentence or two (at most 300 characters) |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |
| `-r, --root <file>` | an extra trusted root, for checking the archive first; repeatable |

#### `unpublish`

```
bundle unpublish [options] <name>
bundle unpublish --as pipobscure.com bled
```

Deletes the listing. Exits `1` if there was none. Installs made from it keep working, and keep
checking the URL it last named; [`update`](#update) says the listing is gone.

| Option | |
|---|---|
| `--as <handle or did>` | the account the listing is in (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |

#### `search`

```
bundle search [options] <words>...
bundle search led
bundle search --json bled
```

```
@pipobscure.com/bled   blink an LED
@alice.example/ledger  double-entry bookkeeping
```

Every word must match the start of a word in the listing's name, title, description or
publisher's handle, and the best matches come first: a match in the name counts most, then the
title, the handle, and the description least. The first column is exactly what
[`install`](#install) takes. It is the publisher's handle when that checks out both ways, and
their DID when it does not.

**The search is local**, against `listings.sqlite` in the state directory. When that is more
than an hour old, or was built from another backlink index, it is synced first:

1. The backlink index the [policy](#policy) names (`discovery`) is asked for every listing. It
   answers a hundred at a time, and this pass also notices publishers who have taken everything
   down.
2. Each publisher's PDS is asked for its repository's latest revision. If that has not moved
   since the last sync, nothing more is asked of it.
3. A publisher who is new, or whose repository moved, has their listings fetched again, usually
   in one request.

Handles are checked again once a day, since a handle can change without the repository
changing. A PDS that cannot be reached keeps what the index had for it. A sync that cannot
start at all leaves the index as it was, and the search answers from that, saying how old it is.

**Plugins are searched for one app at a time.** `--for` names the app: one installed from its
listing, or `@<handle or did>/<name>`. The index follows the plugins of every app installed
here from a listing, and of the one `--for` names. It asks the backlink index what links to each
app's listing, so plugins for apps you don't have are never fetched.

Nothing is installed from the index. `install` fetches the listing again, from the publisher's
own PDS, and verifies it.

| Option | |
|---|---|
| `--for <app>` | search the plugins listed for this app instead |
| `--refresh` | sync first, however recent the index is |
| `--offline` | answer from the index as it is, without the network |
| `--json` | print `[{ install, did, handle, name, title, description, url, domain, for, createdAt }]` |

#### `listings`

```
bundle listings [options]
```

Every listing in the index, by name, synced first exactly as for [`search`](#search).

| Option | |
|---|---|
| `--for <app>` | the plugins listed for this app instead |
| `--refresh` | sync first, however recent the index is |
| `--offline` | answer from the index as it is, without the network |
| `--json` | print the listings as JSON, as `search --json` does |

### Installing and keeping current

#### `install`

```
bundle install [options] [url | domain | @account/name]
bundle install https://example.com/tool.nzip     # fetch, review, put on PATH
bundle install tool.example.com                 # whatever its TXT record names, as `tool`
bundle install @pipobscure.com/bled             # whatever that listing names, as `bled`
bundle install --for bled @alice.example/bled-gpio   # a plugin for bled, into bled's scope
bundle install                                  # this package, from its own release
```

`curl | sh` with the dangerous parts removed. Nothing is executed to install it, and nothing
lands on disk unless it verifies and somebody vouches for it whom you accept. The archive is
fetched, reviewed, and renamed into place, so an archive that is refused never exists at its
destination, not even briefly.

**Everything that vouches for the archive is shown, and whom to believe is your decision.**
That is its signature, if it has one, and every attestation of its hash. Attestations come from
attesters this machine knows, and from anyone the backlink index (Constellation, by default)
says has attested it. Each one is fetched from the attester's own PDS and verified before it is
shown:

```
* tool: sha256:3f1a… (signed)
   1 signed by   https://github.com/acme/tool/.github/workflows/release.yml@refs/heads/main via https://token.actions.githubusercontent.com — new
   2 attested by audit.acme.com (did:web:audit.acme.com) as audited, 2026-10-01T… — trusted by policy
     WARNING     scanner.example (did:plc:…) as malware — marked it bad
* tool: … accept which? numbers (1,2), 'all', or Enter to decline:
```

- **Accepted without asking:** a signer or attester accepted for this install before, one
  the [policy](#policy) trusts, one a flag demands, or a certificate anchored in the trust
  store.
- **Otherwise you are asked.** On a terminal you pick what to accept, and that is remembered
  for later updates. Elsewhere it stops with exit **4** unless `--yes` accepts everything
  shown. A bad verdict from someone you trust or accepted always produces a question.
- **A bad verdict from anyone else is a warning.** Anyone can publish one, so on its own it
  decides nothing.
- **Refused outright:** bytes or a signature that do not verify; a missing `--identity`,
  `--issuer` or `--attester`; a policy requirement that is not met; a bad verdict from
  someone `--block` or the policy blocks on.

Only flags and the policy make anything mandatory. A signer recorded at install time is
*accepted* on later versions, not *required*. That is what lets a publisher move their
releases elsewhere without breaking every install.

**Where it goes.** The name comes from the server's `Content-Disposition`, or the last
segment of the URL, reduced to a bare file name: a suggestion from somebody else's server names
a file, never a path. `--name` overrides it. The `.nzip` extension comes off everywhere but
Windows, where it is what makes the file runnable. The file goes to `~/.local/bin`
(`%LOCALAPPDATA%\bundle\bin` on Windows; `BUNDLE_INSTALL_DIR` or `--dir` anywhere), is made
executable, and you are told if that directory is not on your `PATH`.

On Windows it also registers `.nzip` for the current user, adds it to `PATHEXT`, and
broadcasts the change so a new terminal sees it. It writes `HKCU\Environment` directly rather
than through `setx`, which would freeze a copy of the machine's value. Both halves are checked
before they are written, so installing twice changes nothing. An `.nzip` default set in
Windows' app settings is reported rather than overridden. cmd runs an archive by name, or by an
unquoted path, but refuses a *quoted* path. See [examples/echo-argv/windows](examples/echo-argv/windows/).

**A domain works in place of a URL.** `bundle install tool.example.com` looks for a TXT
record on that domain of the form `nzip:<url>`. The URL is a full `https:` URL, or a
reference resolved against `https://tool.example.com/`, and the install is named after the
domain's first label (`tool`). DNS is not authenticated, so the record says only *where* to
fetch from. The archive is reviewed exactly as a URL's would be, only `https:` is accepted,
and two differing `nzip:` records are refused rather than guessed between.

**So does a listing.** `bundle install @pipobscure.com/bled` resolves the handle, checked both
ways, and fetches the listing `bled` from that account's own PDS with its proof, verified
against the account's key. A DID works in place of the handle: `@did:plc:…/bled`. The archive
is fetched from the URL the listing names, or that its domain's `nzip:` record names, installed
as `bled`, and reviewed exactly as a URL's
would be. See [`publish`](#publish) and [`search`](#search).

**How it was installed is remembered**, and [`update`](#update) follows it. A URL is a URL. A
domain's `nzip:` record, and a listing, are asked again on every update, so a publisher who
moves their releases moves every install with them. A listing that names a domain is both
asked again: the listing, then the domain's TXT record. A listing is remembered by its address,
`at://<did>/com.pipobscure.bundle.listing/<name>`, never by the handle, because handles change
hands.

**`--for` installs a plugin** for an app, from a URL, a domain or a listing alike: a bundle
the app loads by package name, with `@pipobscure/bundle/plugins` (see [Plugins](#plugins)).
`--for` takes the app as it is installed (`bled`, mapped to its package name) or its package
name. The plugin goes into that app's **scope**: a directory of the app's own
(`~/.local/share/bundle/plugins/<scope>/`; see [Files and directories](#files-and-directories)),
under the package name inside it. It is not made executable and is never on the PATH.

It is reviewed like any install, under the policy's global rules and its `scopes` section for
that app, never the app's own `apps` section, because a plugin's author is not the app's.
A listing that says it is a plugin for an app (see [`publish`](#publish)) installs only with
`--for`. If that app was installed from its listing, it installs only into that app's scope.
Its record is `<scope>:<package>`, which `update`, `installed`, `validate` and `uninstall`
take like any other name. An update that carries another package name is refused, because it
is a different plugin.

**With neither, it installs this package itself**, from its own GitHub release, accepting
the identity its [publish workflow](.github/workflows/publish.yml) signs with. `npx
@pipobscure/bundle install` is therefore the whole bootstrap. It then offers to set up the
shell it is run from (see [`shell`](#shell)). Run it again once installed and it fetches
nothing: it only offers the shell setup for the shell you are in now, so after switching
shells, `bundle install` is all it takes.

| Option | |
|---|---|
| `-y, --yes` | accept everything found, rather than asking |
| `--identity <san>` | require this sigstore signing identity |
| `--issuer <url>` | require this sigstore OIDC issuer |
| `--attester <[kind@]who>` | require an attestation from this DID or handle; repeatable |
| `--quorum <n>` | how many of the attesters must have attested (default: all) |
| `--block <who>` | refuse it if this DID or handle has marked it bad; repeatable |
| `--no-discover` | do not ask the backlink index who has attested it |
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `-n, --name <name>` | install under this name |
| `--for <app>` | install a plugin for this app: an installed name, or the app's package name |
| `-d, --dir <dir>` | install here (default: `~/.local/bin`, or `%LOCALAPPDATA%\bundle\bin`) |
| `--no-shell` | installing itself, do not offer to set up the shell |

#### `update`

```
bundle update [options] [name]
bundle update            # everything installed
bundle update tool       # one
```

Asks each install's source where the archive is now: a domain's `nzip:` record, or the
listing it was installed from, fetched and verified again. If the source cannot be asked, or a
listing has been taken down, it says so and checks the URL it last named. Then it refetches,
as a conditional request with the ETag recorded last time. A server with nothing new answers `304` and nothing is downloaded. Identical bytes
are not an update either. Something new is reviewed exactly as an [`install`](#install) is,
against what has been accepted for it so far:

- **Evidence from someone accepted before proceeds.**
- **A new signer, or attestations from people nobody accepted, is a question, not a
  failure.** Publishers move their releases, and auditors do not review every version. To
  make a signer or attester mandatory, put it in the [policy](#policy) (for example
  `"require": { "sameIssuer": true }`) or pass the flags.
- **One install that is refused, declined or waiting on a decision does not stop the
  others.** Each is reported, the installed copy stays as it was, and the exit code is the
  worst of them.

| Option | |
|---|---|
| `-y, --yes` | accept everything found for a new version, rather than asking |
| `--identity <san>`, `--issuer <url>` | require this sigstore signer of every new version |
| `--attester <[kind@]who>`, `--quorum <n>` | require attestations of every new version |
| `--block <who>` | refuse a new version this DID or handle has marked bad; repeatable |
| `--no-discover` | do not ask the backlink index who has attested it |
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |

#### `installed`

```
bundle installed [--json]
```

Lists what is installed (where from, who signed and attested it, since when) and re-checks
each install against its record:

- the file is still there;
- its bytes are still the bytes that were installed;
- someone accepted for it still vouches for it;
- the policy still holds;
- nobody it blocks on has marked it bad.

Attestations are fetched fresh first, discovery included, so a warning published since the
install shows up here.

The hash is the cheap check and the interesting one. `update` is the only thing that should
ever replace an installed file, so a file whose hash moved without the record moving with it
was changed by something else. A signature check alone would not notice that, because the
replacement may be perfectly well signed. That reports as `CHANGED`. The exit code is the worst
found, so a script can gate on it.

| Option | |
|---|---|
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `--json` | print the results as JSON |

#### `validate`

```
bundle validate [options] [name | url | domain]...
bundle validate                                    # every install: what has changed since the last look
bundle validate tool
bundle validate --quiet --every 1d --timeout 5s    # at shell start
```

`installed` says what *is*; `validate` says what is *new*. It re-checks each install exactly as
[`installed`](#installed) does, with attestations fetched afresh and discovery asked again. It
then compares the result with what the install saw last time:

- an attestation that was not there before;
- one that has been withdrawn;
- above all, a new **warning**: someone marking the file bad since.

Then it remembers what it saw, so each change is reported once. It is made to run unattended,
at login or on a timer; [`shell`](#shell) sets that up.

| Option | |
|---|---|
| `-q, --quiet` | say nothing unless something needs attention |
| `--every <time>` | leave alone any install validated more recently than this, without touching the network |
| `--timeout <time>` | one deadline for all of its network requests, after which the cache answers |
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `--json` | print the results as JSON |

| Exit | |
|---|---|
| 0 | nothing needs attention (new good attestations are reported, but are not a problem) |
| 1 | a new warning, or nobody accepted for an install vouches for it any more |
| 2 | an install is changed, missing or invalid, or someone the policy blocks on has marked it bad |
| 3 | an install is unsigned and nothing vouches for it |

Installs made before `validate` existed have no record of what they had seen, so the first
run reports all their current attestations as new, once.

#### `uninstall`

```
bundle uninstall [name | url | domain | @did/name]
bundle uninstall tool                              # by name
bundle uninstall https://example.com/tool.nzip     # by where it came from
bundle uninstall tool.example.com                  # by the domain it was installed by
bundle uninstall @did:plc:…/bled                   # by the listing it was installed from
bundle uninstall                                   # this package's own install
```

Deletes the file and forgets the record. With no argument it removes what `bundle install`
left behind, found by the URL it came from whatever it ended up called, and also takes the
shell setup out of every startup file it was added to. The `.nzip` association on Windows is
left alone: other archives may need it.

**An app's plugins go with it**, since nothing can load them any more. The exception is
another install of the same app (the same package, under another name), which loads the same
scope, so they stay for that one. A scope no app is installed as, such as a suite's shared one,
belongs to no single app, and is only emptied plugin by plugin.

### Trust and policy

#### `trust`

```
bundle trust [options]
bundle trust                                       # everything
bundle trust --no-sigstore --attester audit.example.com
```

Verification never reaches for the network to decide whether to mount something. So the
material it checks against is fetched ahead of time, here:

- **The sigstore trust root**, over TUF: signed metadata with its own root of trust, not a
  plain download. Until it is first fetched, the copy the sigstore libraries ship is used.
- **The attestations of every attester this machine knows.** That means attesters named
  here, in `BUNDLE_ATTESTERS` or `BUNDLE_BLOCK`, in either policy file, accepted for an
  install, or already in the cache. For each one it lists their attestations, fetches and
  verifies new ones, drops withdrawn ones, and re-confirms the rest.

This is what a sealed executable or the preload checks attestations against, and how stale
that may be is the policy's `maxAge` (default seven days). Exit `1` if any refresh failed.

| Option | |
|---|---|
| `--mirror <url>` | the TUF repository to refresh from (default: sigstore's) |
| `--attester <who>` | also keep this DID's or handle's attestations; repeatable |
| `--no-sigstore` | refresh only the attestations |

#### `policy`

```
bundle policy [show | init | check <file>] [options]
bundle policy              # the rules in force, and the files they came from
bundle policy --app tool   # including the apps.tool section
bundle policy init         # write a starter file for you (--system: for the machine)
bundle policy show         # print the files themselves
bundle policy check f.json # check a file the way an install will read it
```

The rules this machine installs by, in JSON, from two files that both apply:

- the machine's: `/etc/bundle/policy.json`, `/Library/Application Support/bundle/policy.json`
  on macOS, `%ProgramData%\bundle\policy.json` on Windows (`BUNDLE_SYSTEM_POLICY`);
- the user's: `~/.config/bundle/policy.json`, `~/Library/Application Support/bundle/` on
  macOS, `%APPDATA%\bundle\` on Windows (`BUNDLE_POLICY`).

```jsonc
{
  "require": {                       // mandatory: not met means refused
    "signature": true,               // it must carry a signature that verifies
    "sameIssuer": true,              // updates signed through the same OIDC issuer as before
    "attesters": ["audited@did:web:audit.acme.com"],
    "quorum": 1
  },
  "issuers": ["https://token.actions.githubusercontent.com"],  // the only issuers that count
  "trust": {                         // accepted without asking
    "signers": [{ "identity": "…", "issuer": "…" }],
    "attesters": ["did:web:audit.acme.com"],
    "certificates": ["AB:CD:…"]      // certificate-chain root fingerprints
  },
  "block": ["did:plc:…"],            // their bad verdict refuses it
  "ignore": ["did:plc:…"],           // their verdicts are not shown at all
  "discovery": "https://constellation.microcosm.blue",  // or false
  "maxAge": "7d",
  "apps": { "tool": { "require": { "sameIssuer": true } } },
  "scopes": { "bled": { "require": { "attesters": ["audited@did:web:bled.dev"] } } }
}
```

`apps` sections are for one installed name. `scopes` sections are for the plugins installed for
one app, by its package name. A plugin answers to the global rules and its scope's section,
never to its app's `apps` section. When an app verifies its plugins as it loads them, the
scope's section applies there too (see [Plugins](#plugins)).

Requirements from every file and section apply together, and trust adds up. Unknown settings
are an error, so a typo cannot quietly loosen anything. The policy governs `install`, `update`,
`installed` and `validate`.

**The format is described by a JSON Schema**, [`schemas/policy.schema.json`](schemas/policy.schema.json),
which is also the full reference for every setting. Each release attaches the schema for that
version, and the files `bundle policy init` writes and `bundle policy show` prints start with a
`$schema` pointing at it. So an editor that understands JSON Schema completes settings,
explains them, and flags mistakes as you type. A test holds the schema to the checker `bundle`
itself uses.

**VS Code needs to be told to trust it, once.** It only downloads schemas from locations on
its allow-list (`json.schemaDownload.trustedDomains`), and GitHub releases are not on it by
default, so it reports `Location … is untrusted` (error `65538`). Either use the quick fix on
the `$schema` line (**Trust URI**, for that one version), or trust every release's schema at
once in your user settings:

```jsonc
"json.schemaDownload.trustedDomains": {
    "https://github.com/pipobscure/bundles/releases/download/": true
}
```

That covers this project's release downloads and nothing else on GitHub. Setting it replaces
VS Code's default list (SchemaStore and the rest), so copy those entries in too if you rely on
them, or use the quick fix instead.

| Option | |
|---|---|
| `-a, --app <name>` | the rules for this installed name, its `apps` section included |
| `--json` | print the rules in force as JSON: merged, not a policy file |
| `--system` | `init` and `show` the machine's file |
| `--user` | `show` only the user's file (`init` writes it by default) |
| `-f, --force` | `init` over a file that is already there |

### Setting up

#### `shell`

```
bundle shell [bash | zsh | fish | powershell] [options]
eval "$(bundle shell bash)"                                 # in ~/.bashrc
eval "$(bundle shell zsh)"                                  # in ~/.zshrc
bundle shell fish | source                                  # in ~/.config/fish/config.fish
bundle shell powershell | Out-String | Invoke-Expression    # in $PROFILE
```

Prints what to load when a shell starts. [`install`](#install) offers to add it for you when it
installs bundle itself.

- **Tab completion:**
  - commands, and their options;
  - the values those options take (`--verdict good|bad`, `--flow`, the shells, …);
  - installed names for `update`, `uninstall` and `validate`;
  - file names wherever a file goes.

  Options come from the same table the commands parse with, so what Tab offers is what a
  command accepts. fish and PowerShell also show what each option does. fish ships completions
  for Ruby's Bundler, which is also called `bundle`; these replace them.
- **`bundle validate --quiet --every 1d --timeout 5s`** in interactive shells only, so a
  warning about something you installed is the first thing a new terminal says. It asks the
  network at most once a day, gives up after five seconds and answers from the cache, and
  prints nothing when there is nothing to say. In PowerShell, a profile loaded for `pwsh
  -Command` or a script does not run it.

**Which shell** is the one you are in, not the platform:

1. `BUNDLE_SHELL`, if set.
2. Where the process tree can be read (Linux, macOS), the nearest shell in it. So pwsh started
   from zsh is pwsh, whatever `$SHELL` says.
3. `$SHELL`. This is how Git Bash on Windows counts as bash.
4. PowerShell on Windows sets no `$SHELL`, and is recognised by the module directory it adds to
   `PSModulePath`.

cmd.exe has no programmable completion, and gets nothing.

**Under Windows**, bundle is installed as `bundle.nzip`. Git Bash runs it by its `#!` line, so
the bash setup uses that name. PowerShell would run a `.nzip` through its file association,
whose output it cannot capture, so the PowerShell setup runs node with the installed archive
mounted (which is what the association runs anyway). The PowerShell profile is the one
PowerShell itself reports as `$PROFILE`, wherever Documents has been moved to.

**What `install` adds** is a marked block in the startup file, guarded so the shell still
starts if bundle is gone:

```sh
# >>> bundle: Tab completion, and a quiet re-check of installs >>>
command -v bundle >/dev/null 2>&1 && eval "$(bundle shell bash)"
# <<< bundle <<<
```

It is added once, only with your yes, and [`uninstall`](#uninstall) takes it out again,
leaving the rest of the file as it was.

| Option | |
|---|---|
| `--every <time>` | how often a new shell re-validates installs (default: `1d`) |
| `--timeout <time>` | how long it may wait for the network (default: `5s`) |
| `--no-validate` | leave out the re-validation |
| `--no-complete` | leave out Tab completion |

#### `skill`

```
bundle skill [options] [name]
bundle skill                 # -> .claude/skills/audit-bundle/SKILL.md
bundle skill --list
bundle skill --dir <dir> --force
```

Installs the [Claude Code](https://claude.com/claude-code) skills this package carries,
[`audit-bundle`](skills/audit-bundle/SKILL.md) among them, into a project. It never overwrites
a file that is already there unless forced, so local edits survive.

| Option | |
|---|---|
| `-d, --dir <dir>` | where to install (default: `.claude/skills`) |
| `-f, --force` | overwrite files that are already there |
| `-l, --list` | list the skills this package carries, and stop |

### Files and directories

| What | Where | |
|---|---|---|
| Installed programs | `~/.local/bin`; `%LOCALAPPDATA%\bundle\bin` on Windows | `BUNDLE_INSTALL_DIR`, or `--dir` |
| Install records | `installed.json` in the state directory | |
| Attestation cache | `attestations/` in the state directory: each attester's DID document, and their verified proofs | `BUNDLE_ATTESTATIONS` |
| Listing index | `listings.sqlite` in the state directory: a cache, rebuilt from the network whenever it is missing or out of date | |
| Plugins | `$XDG_DATA_HOME/bundle/plugins/<scope>/` (`~/.local/share/…`); `~/Library/Application Support/bundle/plugins/<scope>/` on macOS; `%LOCALAPPDATA%\bundle\plugins\<scope>\` on Windows | `BUNDLE_PLUGINS` |
| The state directory | `$XDG_STATE_HOME/bundle` (`~/.local/state/bundle`); `~/Library/Application Support/bundle` on macOS; `%LOCALAPPDATA%\bundle\Data` on Windows | |
| Policy | see [`policy`](#policy) | `BUNDLE_POLICY`, `BUNDLE_SYSTEM_POLICY` |
| Sigstore trust root | `$XDG_DATA_HOME/sigstore-js` (`~/.local/share/sigstore-js`); `~/Library/Application Support/sigstore-js` on macOS; `%LOCALAPPDATA%\sigstore-js\Data` on Windows | `BUNDLE_SIGSTORE_ROOT`, `--sigstore-root` |
| Shell setup | `~/.bashrc`, `${ZDOTDIR:-~}/.zshrc`, `~/.config/fish/config.fish`, PowerShell's `$PROFILE`, only with your yes | `BUNDLE_SHELL`, `BUNDLE_POWERSHELL_PROFILE` |
| `.nzip` association | `HKCU\Software\Classes` and the user's `PATHEXT`, on Windows | `BUNDLE_NO_WINDOWS_SETUP` |

Nothing from signing in is ever stored: not the sigstore certificate's key, nor an OAuth
session.

### Environment

| Variable | |
|---|---|
| `BUNDLE_INSTALL_DIR` | where `install` puts programs |
| `BUNDLE_PLUGINS` | where plugin scopes are, for `install --for` and the plugin loader alike |
| `BUNDLE_SELF_SOURCE` | where `bundle install` (with no argument) fetches this package from: a mirror. Its publish workflow's identity is still the one accepted. |
| `BUNDLE_NO_WINDOWS_SETUP` | do not register `.nzip` or touch `PATHEXT` on Windows |
| `BUNDLE_POLICY` / `BUNDLE_SYSTEM_POLICY` | the user's and the machine's policy file |
| `BUNDLE_ATTESTATIONS` | the attestation cache directory |
| `BUNDLE_SIGSTORE_ROOT` | the sigstore trust root to check against, instead of the cache |
| `BUNDLE_SHELL` | the shell `install` sets up and `shell` prints for, instead of detecting it |
| `BUNDLE_POWERSHELL_PROFILE` | the PowerShell profile `install` adds its setup to, instead of asking PowerShell |
| `BUNDLE_ATPROTO_IDENTIFIER` | the account `attest`, `publish`, `unpublish` and `lexicon publish` act as, without `--as` |
| `BUNDLE_ATPROTO_PASSWORD` | an app password: `attest`, `publish`, `unpublish` and `lexicon publish` use it instead of signing in, for CI |
| `BUNDLE_OAUTH_CLIENT_ID` | a hosted OAuth client metadata URL, instead of the loopback development client |
| `BUNDLE_PLC_DIRECTORY` | the PLC directory `did:plc` is resolved against (default: `https://plc.directory`) |
| `BUNDLE_NO_BROWSER` | never open a browser to sign in with sigstore; use a device code |
| `BUNDLE_AUDIT_VERDICT` | where the audit skill writes its verdict, when a pipeline asks for one |

The verifying preload and an executable built without a baked policy take their policy from the
environment, since they have no command line of their own:

| Variable | |
|---|---|
| `BUNDLE_ROOTS` | extra trusted roots: a path-delimiter-separated list of PEM files |
| `BUNDLE_ALLOW_UNTRUSTED` | mount an archive whose signature is good but unanchored |
| `BUNDLE_IDENTITY` / `BUNDLE_ISSUER` | require a particular sigstore signer |
| `BUNDLE_ATTESTERS` | require attestations: space- or comma-separated `[kind@]did` |
| `BUNDLE_QUORUM` / `BUNDLE_ATTESTATION_MAX_AGE` | how many of them, and how stale a cached proof may be |
| `BUNDLE_BLOCK` | refuse what any of these DIDs has marked bad |
| `BUNDLE_MANIFEST` | where the recording preload writes the files a run read |

---

## Using it from code

Everything the CLI does, as an API. The CLI is a `parseArgs` wrapper over exactly these
functions and holds no logic of its own.

```ts
import {
    createBundle, signBundle, verifyBundle, inspectBundle, runBundle, fileSigner,
} from '@pipobscure/bundle';

// Build unsigned — the single input to every shape you ship.
await createBundle({ base: 'app/', files, output: 'app.run' });

// Sign, once per shape.
const signer = fileSigner({ key: 'leaf.key', chain: 'chain.pem' });
await signBundle({ source: 'app.run', output: 'app.nzip', prefix: 'shell-base', signer });

// Ask what it claims, and then whether any of it is true.
const { members, signed, hash } = inspectBundle('app.nzip');
const { state, reason, identity } = await verifyBundle('app.nzip', { roots: ['ca.pem'] });

// Mount it through the verifying provider and run it, in this process.
const status = await runBundle('app.signed.nzip', { roots: ['ca.pem'], args: ['--help'] });
```

**Signers.** A signer is `{ chain, signAlg, sign(digest) }`. The chain goes into the archive
*before* hashing; `sign()` is called *after*, with the finished hash. That two-phase shape is
what lets sigstore work at all — the certificate has to be embedded before the bytes exist,
and the signature made after. `keySigner()` is the offline-CA implementation and
`@pipobscure/bundle/sigstore`'s `signer()` is the other one; a third (an HSM, a KMS, a
corporate signing service) is three properties away.

**Working out what to bundle.** `@pipobscure/bundle/recorder` observes a run;
`@pipobscure/bundle/files` computes a closure. Use both — the closure for completeness, the
observation as a cross-check:

```ts
import { moduleFiles } from '@pipobscure/bundle/files';

const files = moduleFiles({
    base: '.',
    files: ['package.json'],
    dirs: ['dist'],
    dependencies: ['@sigstore/verify'],   // and everything they depend on, transitively
    filter: (name) => !name.endsWith('.map'),
});
```

**Registering the verifying provider yourself**, when the environment variables are not
enough:

```js
// my-preload.js — node --experimental-vfs -r ./my-preload.js --vfs-load=app.nzip
import { register } from '@pipobscure/bundle/provider';

register({
  extensions: ['.nzip', '.app'],   // claimed by name
  claimSigned: true,                 // and anything carrying a signature marker, whatever it is called
  roots: ['/etc/ssl/my-root.pem'],   // PEM text or paths to PEM files
  allowUntrusted: false,
  identity: 'https://github.com/me/app/.github/workflows/release.yml@refs/heads/main',
  issuer: 'https://token.actions.githubusercontent.com',
});
```

A preload runs under the CommonJS loader, so it must contain no top-level `await`. ESM syntax
is otherwise fine, and `--import` works as well as `-r`.

A preload takes no arguments, so the verifying mount is configured through the
environment: `BUNDLE_ROOTS`, `BUNDLE_IDENTITY`, `BUNDLE_ATTESTERS` and the rest, listed under
[Environment](#environment) in the CLI reference.

---

## Exports

```jsonc
{
  ".":          "create / sign / verify / inspect / run, from code",
  "./register": "-r preload: mount only what is signed",
  "./record":   "-r preload: write down what a run reads",
  "./sea":      "build a verifying runtime, with or without an app inside",
  "./launch":   "verify a container, mount it, run it — and the runtime's CLI",
  "./provider": "the verifying provider, and register(options)",
  "./recorder": "the recording provider, and recording(Base, manifest)",
  "./cli":      "main(argv, io) -> exit code",
  "./manifest": "the archive format on its own",
  "./archive":  "bundling and re-emitting",
  "./files":    "dependency closures",
  "./skill":    "the shipped skills, and installing them",
  "./audit":    "the audit gate: prepare, check, approve",
  "./sigstore": "the sigstore signer and bundle verification",
  "./attestation": "attestation policies, and the cache they are checked against",
  "./policy":   "the machine's install policy file",
  "./review":   "what install and update find, and what they decide",
  "./atproto":  "resolving DIDs, fetching and writing attestations",
  "./oauth":    "signing in to a PDS: atproto OAuth with PAR, PKCE and DPoP",
  "./lexicon":  "this package's lexicons, and publishing them",
  "./listing":  "listings: publishing, resolving, and the local search index",
  "./plugins":  "use() and list(): load plugin bundles by package name, verified when asked",
  "./oidc":     "identity tokens: CI, browser, or device code"
}
```

The package root deliberately does **not** re-export the two providers: importing either
needs `node:vfs`, and creating or verifying an archive does not, so `import
'@pipobscure/bundle'` must not drag that requirement in.

Written in TypeScript, published as ESM with declarations. The sources use erasable syntax
only, so `node src/main.ts` runs them directly under Node's type stripping.

---

## Executables that verify before they run

`bundle sea` builds a node runtime with this package inside it. What you do with that runtime
is the difference between the two shapes it can take.

**With an archive, it becomes that application** — one file that checks its own signature
before running anything:

```
[ node runtime | SEA blob: stub + the verifier, as a mounted archive ] [ app.run ]
  \_______________________ the prefix, and part of the _______________/
   \______________________ archive's signed region ______/
```

```sh
bundle sea --output app.sea \
    --root /etc/ssl/my-root.pem \
    --identity 'https://github.com/me/app/.github/workflows/release.yml@refs/heads/main' \
    --issuer 'https://token.actions.githubusercontent.com' \
    app.run
```

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

The two are the same binary. A verifying node with an archive appended to it — `bundle sign
--prefix node-verifying app.run` — *is* the self-validating executable, and at startup the
runtime decides which it is by looking at its own tail: a signed archive behind it runs that,
nothing behind it takes one from the command line, and an *unsigned* archive behind it is
refused rather than quietly treated as neither.

**Policy is baked in, or it is not.** The `--root`, `--identity` and `--issuer` given at build
time become the executable's own policy — the point being that a binary run by its own name
has no flags and no preload to configure it. A runtime built with a policy is **sealed**: it
takes no policy from its command line, because a binary that demands a signing identity is
not one whose user can ask it to stop. Build without one and the flags above work, falling
back to `BUNDLE_ROOTS` and friends, so one build can be decided about later.

From code, `createSeaBase()` and `buildSea()` split the expensive half (a ~155 MB copy of
Node) from the cheap one, `@pipobscure/bundle/launch` is the entry point all of this runs
through — `run()`, `runSelf()`, `verify()`, `main()` — and `verifySelf()` lets an application
report on its own provenance. The package rides inside the executable as an archive that node
mounts for itself: `"useVfs": true` ([nodejs/node#65675](https://github.com/nodejs/node/pull/65675),
released in v26.9.0) with `"vfsArchive"` ([nodejs/node#65810](https://github.com/nodejs/node/pull/65810),
still open), which is why the generated stub is a handful of lines and why there is no second
copy of the verifier anywhere.

---

## Plugins

A plugin is a bundle an app loads by package name, rather than runs: created, audited and
signed like any other, installed for one app with `bundle install --for`, and loaded with
`@pipobscure/bundle/plugins`:

```js
import { use, list } from '@pipobscure/bundle/plugins';

use('bled');                                   // this app's plugins, in this thread
const gpio = await import('@alice/bled-gpio'); // ordinary import and require from here on
for (const name of list('bled')) await import(name);   // or everything installed

use('bled', { verify: {                        // checked as they load, on top of what the
    attesters: ['audited@did:web:bled.dev'],   // runtime and the policy require
    ca: certificatePem,                        // also: identity, issuer, quorum, block
} });
```

`use(scope)` takes the app's package name, which is the scope `install --for` put the plugins
in, or an absolute path to a directory of plugins. Each plugin is found by the `name` in its
`package.json`, and its entry points are its `exports` (or `main`).

- **Plugins resolve last.** Builtins and the app's own dependencies always come first, so a
  plugin can never stand in for them. What a plugin imports and does not carry is resolved as
  the host would, so it gets the app's API as the same instance the app has.
- **Every thread calls `use()` itself.** Mounts and module hooks are per thread.
- **Checking at load is opt-in, as it is for apps.** The full review happens at install, and
  `installed` and `validate` repeat it. `use(scope, { verify })` checks every plugin before
  it returns, and a verifying runtime (`bundle run`, `register`, a SEA) always does.
- **A plugin is judged as a plugin.** The app's signer, roots and `apps` section never apply
  to it. What carries over from the runtime is attestations, blocks, and that a signature is
  needed. The policy's `scopes` section and the host's own rules in code add to that, and
  nothing can take any of it away. With verification, `use()` checks every plugin before it
  returns. If any is refused, none is loaded, and the `ERR_BUNDLE_UNTRUSTED` it throws names
  every plugin, every reason, and where each rule came from.
- **The loader is light, and the verifier comes only when needed.** The loader goes into every
  host's bundle, so it imports nothing heavy, and loads without `--experimental-vfs`. Under a
  verifying runtime, the runtime's own verifier checks plugins, so the code and policy that
  checked the app check its plugins too. Otherwise this package's verifier is loaded the first
  time `use()` verifies. `bundle create` bundles what the recording run read, so record a host
  that verifies its plugins from a run that does.

Shared code for a suite of apps works the same way: install it into a scope the suite's apps
share (`--for @acme/suite`), and have each app `use()` that scope too. Each name has one
version per scope, there is no dependency resolution, and bundles in a scope are meant to be
loaded, never re-wrapped npm packages. [proposals/plugins.md](proposals/plugins.md) has the
reasoning.

## How it works

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

**The mount** is where it stops being advisory. `--vfs-load` asks registered providers who
wants its source; this package's provider claims `.nzip` files by name and any file carrying
a signature marker by content — so renaming a signed archive cannot quietly downgrade it to
the unchecked built-in ZIP provider. It verifies before returning a filesystem, and re-hashes
each member as it is first read, because a `ZipFile` reads lazily from an open descriptor and
a file rewritten underneath a running program would otherwise be served unchecked.

**Prefixes.** ZIP offsets are absolute, so an archive can sit *after* arbitrary bytes and
still be a valid ZIP — which is what lets one build become a `#!` launcher, a native
executable, or a plain mountable archive. The prefix has to be chosen before offsets are
fixed, and therefore before the hash exists, which is exactly why signing re-emits an archive
rather than appending to one.

---

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
- **A shebang archive does not self-verify.** The kernel gives it no preload flag to carry a
  provider. Mount it with the preload, or use a SEA.
- **A sigstore signature is public.** Signing puts your identity, the archive's hash and the
  time in an append-only log. That is the mechanism working — it is what makes the
  ten-minute certificate verifiable later — not something to discover afterwards.
- **Everything here is experimental**, including the Node it needs.

---

## Requirements

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

[HISTORY.md](HISTORY.md) explains each in detail and why they are worth having.

`openssl` on `PATH` is needed only to generate the throwaway PKI the tests use.

---

## Development

```sh
npm install
npm run build          # TypeScript -> dist/, with declarations
npm test               # the whole suite; generates a throwaway PKI into build/certs/ on first run
npm run typecheck
```

The suite needs Node 26.11.1 or later, including the tests that build an executable. On a Node
whose `--build-sea` lacks `vfsArchive` those skip themselves and say why. [CI](.github/workflows/ci.yml)
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
BUNDLE_AUDIT_VERDICT=build/cli.audit.json claude "/audit-bundle build/cli.run"
npm run sign:cli:local      # 4: now allowed -> bundle.nzip
```

| Script | |
|---|---|
| `manifest:cli` | observe a run, close over the dependencies, write the file list |
| `pack:cli` | `bundle create` over that list |
| `baseline:cli` | fetch and verify the published release, to review against |
| `audit:cli` | `bundle audit` — report the diff and print the skill invocation |
| `approve:cli` | `bundle audit --approve` |
| `sign:cli` | `bundle audit --check`, then `bundle sign --launcher` through sigstore |
| `release:cli` | steps 1–3, stopping at the gate |

Only `manifest:cli` and `baseline:cli` are scripts of their own; the rest are the CLI. The
first observes a run and computes a dependency closure, the second fetches this package's
own published release from npm — both specific to how *this* project is built.

**The gate is real, and it is a shipped command** — `bundle audit --check`, not repo
tooling. It runs before signing, reads the JSON verdict the skill writes, and refuses unless
that verdict passed *and* pins the sha256 of the bytes on disk. Everything this repository
does to release itself is something you can do to your own project.

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) is the whole pipeline as a
workflow — test, pack, fetch the published release, audit the diff, gate, sign through
sigstore with the workflow's OIDC identity, publish through npm trusted publishing, every
action pinned to a commit SHA. It runs whenever CI passes on `main` and does nothing unless
`package.json` names a version npm does not have yet: bumping the version *is* the release.
There is no npm token anywhere; npm trusts that workflow file by name.

---

## Reading further

- **[HISTORY.md](HISTORY.md)** — why this exists, what changed in Node and why those changes
  make sense, and the experiment that produced the tool. The long-form argument, with the
  implementation notes at the end.
- **[HISTORY.md § Implementation notes](HISTORY.md#implementation-notes)** — design
  decided before it was built, and what departed from the plan: signing-time attestation,
  the audit skill, shipping the tool as a bundle of itself, the self-validating executable,
  and the audit as a build step.
- **[examples/static-server/](examples/static-server/)** — an example application: a static web
  server that serves the directories and archives it is handed, built and signed the way this
  README says to build things. It ships with the repository, not with the package.
- **[skills/audit-bundle/SKILL.md](skills/audit-bundle/SKILL.md)** — the review procedure.
- **[slides/](slides/)** — *Ship the Tree*, a talk about the project, kept in step with it.
  `slides/index.html` opens in any browser with no build step; press <kbd>S</kbd> for the
  speaker notes, which carry most of the argument.
  **[Read it here](https://claude.ai/artifact/FsAKxG5e5rKYaUXArqb6Us)** —
  same deck, published.

---

## License

[EUPL-1.2](https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12)
