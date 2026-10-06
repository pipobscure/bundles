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

> **Requires Node 26.10 or later**, run with `--experimental-vfs`. Every piece this needs is
> in a released Node; the last, the `--vfs-load` loader, shipped in v26.10.0. Building a
> single executable additionally needs one open pull request. See
> [Requirements](#requirements). Everything here is experimental.

---

## Contents

- [Install](#install) · [The four steps](#the-four-steps) · [CLI](#cli)
- [Using it from code](#using-it-from-code) · [Exports](#exports)
- [Executables that verify before they run](#executables-that-verify-before-they-run)
- [How it works](#how-it-works) · [What it does and does not prove](#what-it-does-and-does-not-prove)
- [Requirements](#requirements) · [Development](#development) · [Reading further](#reading-further)

---

## Install

```sh
npx @pipobscure/bundle install      # -> a signed `bundle` on your PATH
bundle --help
bundle update                       # later, when there is a new release
```

That is the whole install: npm fetches the package once, and what stays behind is the signed
archive itself, on your PATH and keeping itself current. Or take it from the release page and
skip npm altogether — Node 26.10 or later is all it needs:

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

## CLI

```
bundle <command> [options]
bundle -v, --version

  create    build an archive from a list of files
  sign      sign an archive into a new file, optionally behind a prefix
  audit     report what is about to be reviewed, and gate signing on the verdict
  verify    verify an archive and report its trust state
  attest    vouch for an archive from an atproto account, or withdraw that
  run       mount a signed archive and run it
  install   fetch a signed archive from a URL or domain and put it on your PATH
  update    refetch what was installed, and replace it if it changed
  installed list what is installed, and re-check each against its record
  validate  re-check installs, and say what has been attested since — at startup
  uninstall remove an installed archive, and forget where it came from
  sea       build a node runtime that verifies an archive before running it
  trust     refresh the sigstore trust root and the cached attestations
  policy    show the rules this machine installs by, and where they come from
  lexicon   show, check or publish the atproto lexicons attestations are written in
  shell     print what to load at shell start: Tab completion, and validate
  skill     install the bundle-auditing skill into a project
```

`bundle <command> --help` — or [`src/cli.ts`](src/cli.ts) — has every option. The ones worth
knowing:

### `verify`

```sh
bundle verify --root ca.pem --json app.run
```

Reports one of four states, and exits with the matching code:

| State | Exit | Meaning |
|---|---|---|
| `valid` | 0 | Hash, signature and every member digest are sound, and the chain is trusted. |
| `valid-untrusted` | 1 | All of that is sound; the certificate is not one you can place — or a sigstore trust root is missing, or a required identity did not match. |
| `unsigned` | 3 | No manifest, or a manifest with no signature. |
| `invalid` | 2 | The bytes changed since signing, a member's digest does not match its content, the archive no longer parses as a ZIP, or something was appended after its end. |

Note which side of the line "I could not check" falls on. Not being *able* to verify is
`valid-untrusted`, never `invalid` — conflating them is how people are trained to click
through warnings.

A certificate chain is trusted only for what it was issued for. The leaf must carry the
code-signing extended key usage, and everything above it must be a CA — otherwise the key
of any publicly trusted certificate, a web server's TLS certificate included, could sign an
archive that reads as `valid`. A root given with `--root` that *is* the leaf is trusted as
itself: that is pinning, and you chose it.

`--identity` and `--issuer` demand a particular sigstore signer, matched exactly — never as
a pattern. A mismatch is
`valid-untrusted`: the signature is genuine, it is simply not the one you asked for. An
archive signed against an ordinary CA carries no identity claim at all, so it also reads as
`valid-untrusted` under such a policy rather than passing.

`--attester [kind@]<did or handle>` (repeatable, with `--quorum <n>` and `--max-age`)
requires attestations instead of, or as well as, a signer — see [`attest`](#attest).

### `attest`

```sh
bundle attest --as audit.example.com --kind audited app.nzip app-sea app.run   # one browser sign-in for all three
bundle verify --attester audited@did:web:audit.example.com app.nzip
bundle attest --as audit.example.com --revoke app.nzip
bundle attest --as scanner.example --verdict bad --kind malware app.nzip
```

An attestation is an atproto record in the attester's own repository saying "I vouch for
the archive with this whole-file hash", the same hash a signature covers, optionally with
a kind: `published`, `audited`, `reproduced`. Anyone with an atproto account (any `did:plc`
or `did:web`) can make one, and only they can withdraw it. A policy names the attesters it
requires:

- With attesters, a signature is optional. If there is one it must verify, but its
  certificate only has to be trusted if `--identity`/`--issuer` also ask for a signer. So
  "our auditors vouched for this" can be required without caring who built it, or
  together with a sigstore identity, so that no single trust root decides.
- Proofs are fetched with `com.atproto.sync.getRecord` and checked with `node:crypto`
  alone: the commit's signature against the DID's key, and the Merkle tree path to the
  record. `verify`, `run`, `install`, `update` and `installed` fetch the proofs they need;
  mounting, which cannot wait for the network, checks a cache that `bundle trust` keeps
  current. A cached proof counts for `--max-age` (default 7 days), which is how long a
  withdrawn attestation can still be honoured by a machine that has not refreshed.
- **Signing in is OAuth**, against the account's own PDS. It asks for write access to
  attestation records and nothing else (`repo:com.pipobscure.bundle.attestation`). It falls
  back to general write access only on a server that does not support that, and says
  so. Nothing is kept: the session is revoked when the command finishes, so every
  attestation is approved in the browser by whoever it speaks for. Several archives
  named in one command share one sign-in. In CI, where there is no browser, an app
  password from `BUNDLE_ATPROTO_PASSWORD` or `--password-file` is used instead.
- **Verdicts can be bad.** `--verdict bad` warns everyone who installs the file,
  and `--kind` says why (`malware`, `vulnerable`, …). Bad verdicts never count
  towards a requirement. A stranger's is a warning, because anyone can publish
  one. One from someone you trust forces a question. One from an attester you
  `--block` on, or the policy blocks on, refuses the file: at install, and at
  mount time through the cache. Attesters in the policy's `ignore` list are not
  shown at all.
- **Install finds attestations nobody named,** through a backlink index
  (Constellation, by default). The index only says whom to ask: each attestation
  is fetched from the attester's own PDS and verified. See [`install`](#install)
  for what is accepted, what is asked and what is refused.

The design, and what an attestation does and does not prove, is in
[proposals/atproto-attestations.md](proposals/atproto-attestations.md).

### `audit`

```sh
bundle audit [--baseline <archive>] [--verdict <file>] [--check|--approve] <archive>
```

The gate described above. Exits non-zero when `--check` finds no verdict, a verdict over
different bytes, a verdict reached against a different baseline, or one that failed.

### `run`

```sh
bundle run --root ca.pem app.signed.nzip --your --app --args
```

Checks the archive, mounts it through the verifying provider, and runs what is inside — in
this process, the way a verifying runtime does. Every member is re-hashed against its signed
digest as it is read, for as long as the process lives.

**`run`'s own options come before the archive, and everything after it belongs to the
program** — flags included, since `run` has already had its turn. A `--` is accepted there
too, for the habit, but it is not needed.

There is no child and no preload: the provider is already registered in the process doing
the mounting. What that costs is isolation — the application shares the process, with this
package's modules loaded in it. For a process of its own, spawn one with the arguments
[`mountArgv`](#using-it-from-code) names.

### `install`

```sh
bundle install https://example.com/tool.nzip     # fetch, verify, put on PATH
bundle install tool.example.com                 # whatever its TXT record names, as `tool`
bundle install                                  # this package, from its own release
```

`curl | sh` with the two dangerous parts removed: nothing is executed to install
it, and nothing lands on disk that did not verify first. The archive is fetched,
checked, and renamed into place — an archive that fails verification never
exists at its destination.

The name comes from the server's `Content-Disposition`, or the last segment of
the URL, reduced to a bare file name: a suggestion from somebody else's server
names a file, never a path. `--name` overrides it. The file goes to
`~/.local/bin` (`%LOCALAPPDATA%\bundle\bin` on Windows, `BUNDLE_INSTALL_DIR`
anywhere), is made executable, and you are told if that directory is not on your
`PATH`. On Windows it also registers `.nzip` for the current user and adds it to
`PATHEXT` — written to `HKCU\Environment` rather than through `setx`, which
would freeze a copy of the machine's value into your environment — and then
broadcasts `WM_SETTINGCHANGE` so a new terminal sees it without a sign-out.
Both halves are checked before they are written, so installing twice changes
nothing, and an `.nzip` default set in Windows' app settings is reported rather
than silently overridden. One Windows quirk worth knowing: cmd runs an archive
by name, or by an unquoted path, but refuses a *quoted* path — quoted, it looks
for a program rather than a document. See
[examples/echo-argv/windows](examples/echo-argv/windows/).

**A domain works in place of a URL.** `bundle install tool.example.com` looks up
the TXT records of `tool.example.com` for one of the form

```
nzip:<url>
```

and installs what `<url>` points at, named after the domain's first label —
`tool`. The URL is either a full `https:` URL or a reference resolved against
`https://tool.example.com/`, so a publisher can give people one short thing to
type. For instance, a TXT record `nzip:/app/npm.nzip` on `npm.npmjs.org` would
make `bundle install npm.npmjs.org` fetch `https://npm.npmjs.org/app/npm.nzip`
and install it as `npm`.

The record says *where* to fetch from and nothing more. DNS is not
authenticated, so the archive is verified exactly as a URL's would be, the
same people are asked about, and only `https:` is accepted. More than
one differing `nzip:` record on a domain is refused rather than guessed between.
`--name` still overrides the name, and `bundle uninstall tool.example.com`
removes what it installed.

**With neither, it installs this package itself**, from its own published release,
accepting without a question the identity its [publish workflow](.github/workflows/publish.yml)
signs with. So

```sh
npx @pipobscure/bundle install
```

is the whole bootstrap: npm fetches it once, and what stays behind is a signed archive on
your PATH — called `bundle`, or `bundle.nzip` on Windows — that keeps itself current.

**Everything that vouches for the archive is shown, and whom to believe is your
decision.** That is its signature, if it has one, and every attestation of its
hash: from attesters this machine knows, and from anyone the backlink index says
has attested it (see [`attest`](#attest)). Each one is verified before it is shown.

```
* tool: sha256:3f1a… (signed)
   1 signed by   https://github.com/acme/tool/.github/workflows/release.yml@refs/heads/main via https://token.actions.githubusercontent.com — new
   2 attested by audit.acme.com (did:web:audit.acme.com) as audited, 2026-10-01T… — trusted by policy
     WARNING     scanner.example (did:plc:…) as malware — marked it bad
* tool: … accept which? numbers (1,2), 'all', or Enter to decline:
```

- **Accepted without asking:** a signer or attester accepted for this install
  before, one the [policy](#policy) trusts, one a flag demands, or a certificate
  anchored in the trust store.
- **Otherwise you are asked.** On a terminal you pick what to accept, and that is
  remembered for later updates. Elsewhere it stops with exit code **4** ("needs a
  decision") unless `--yes` accepts everything shown. A bad verdict from someone
  you trust or accepted always produces a question.
- **Refused outright:** bytes or a signature that do not verify; a missing
  `--identity`, `--issuer` or `--attester`; a policy requirement that is not met;
  a bad verdict from someone `--block` or the policy blocks on.

Only flags and the policy file make anything mandatory. A signer recorded at
install time is *accepted* on later versions, not *required*.

### `update`

```sh
bundle update            # check everything installed
bundle update tool       # check one
```

Each check is a conditional request carrying the ETag recorded at install time,
so a server with nothing new answers `304` and nothing is downloaded. When there
is something new it is reviewed exactly as an install is, against what has been
accepted for it so far. Evidence from someone accepted before proceeds. A new
signer, or attestations from people nobody accepted, is a question, not a
failure: publishers move their releases, and auditors do not review every
version. To make a signer or attester mandatory, say so in the policy, for
example `"require": { "sameIssuer": true }`. One install that is refused or
waiting on a decision does not stop the others.

### `installed`

```sh
bundle installed          # what is here, and whether it still is what it was
bundle installed --json
```

Lists what is installed — where from, who signed and attested it, when — and
re-checks each one against its record: the file is there, its bytes are still
the bytes that were installed, someone accepted for it still vouches for it, the
policy still holds, and nobody it blocks on has marked it bad. Attestations are
fetched fresh first, discovery included, so a warning published since the
install shows up here.

The hash is the cheap check and the interesting one. `update` is the only thing
that should ever replace an installed archive, so a file whose hash has moved
without the record moving with it was changed by something else — which a
signature check alone would not notice, because the replacement may be perfectly
well signed. That case reports `CHANGED`.

It exits non-zero when anything is not `OK`, so a script can gate on it.

### `validate`

```sh
bundle validate                      # every install: what has changed since the last look
bundle validate tool                 # just one (a name, URL or domain, as for uninstall)
bundle validate --quiet --every 1d   # for a shell profile: silent unless something needs attention
```

`installed` says what *is*; `validate` says what is *new*. It re-checks each install
exactly as `installed` does. Attestations are fetched afresh and discovery is asked
again, so attesters nobody knew about at install time are found too. It then compares
the result with what the install saw last time: a new attestation, one that was
withdrawn, and above all a new warning (someone marking it bad). Afterwards it
remembers what it saw, so each change is reported once.

It is made to run unattended, at login or on a timer, so you hear about a warning
published after you installed something:

The easiest way is `bundle shell` (below), which does this in every new interactive
shell. By hand:

```sh
bundle validate --quiet --every 1d --timeout 5s
```

`--every` leaves alone any install validated more recently than that, so opening a
terminal does not ask the network each time. `--timeout` is one deadline for all of
its requests together, after which the cache answers, so a shell never waits long
on a missing network.

| exit | meaning |
|---|---|
| 0 | nothing needs attention (new good attestations are reported, but are not a problem) |
| 1 | a new warning, or nobody accepted for an install vouches for it any more |
| 2 | an install is changed, missing or invalid, or someone the policy blocks on has marked it bad |
| 3 | an install is unsigned and nothing vouches for it |

### `shell`

```sh
eval "$(bundle shell bash)"      # in ~/.bashrc
eval "$(bundle shell zsh)"       # in ~/.zshrc
bundle shell fish | source       # in ~/.config/fish/config.fish
```

Prints what to load when a shell starts:

- **Tab completion** for commands, their options, the values those take
  (`--verdict good|bad`, `--flow`, …), installed names for `update`, `uninstall` and
  `validate`, and file names wherever a file goes. Options come from the same table
  the commands parse with, so what Tab offers is what a command accepts. fish shows
  each option's description. fish also ships completions for Ruby's Bundler, which
  is called `bundle` too; this replaces them.
- **`bundle validate --quiet --every 1d --timeout 5s`** in interactive shells, so a
  warning about something you installed is the first thing a new terminal says.

`--no-validate` and `--no-complete` leave either half out.

What decides is the shell, not the platform: Git Bash on Windows is bash, and gets the
bash setup. There, bundle is installed as `bundle.nzip` (Windows needs the extension)
and Git Bash runs it by its `#!` line, so the setup completes and runs it under that
name. In general it uses whatever name bundle was installed under. cmd.exe has no
programmable completion; PowerShell is not supported yet.

**`bundle install` sets this up for you.** When it installs bundle itself, it offers to
add the line to the startup file of the shell it is run from, asking first. The line
is a marked block, guarded so a shell still starts if `bundle` is gone. Run
`bundle install` again once installed and it fetches nothing; it only offers the
same for the current shell. After switching from fish to bash, `bundle install` is
all it takes. `bundle uninstall` takes the block out of every startup file again.

### `policy`

```sh
bundle policy              # the rules in force, and the files they came from
bundle policy --app tool   # including the apps.tool section
bundle policy init         # write a starter file for you (--system: for the machine)
bundle policy show         # print the files themselves
bundle policy check f.json # check a file the way an install will read it
```

The rules this machine installs by, in JSON, from two files that both apply:
the machine's (`/etc/bundle/policy.json`, `/Library/Application Support/bundle/`
on macOS, `%ProgramData%\bundle\` on Windows) and the user's
(`~/.config/bundle/policy.json`, or `BUNDLE_POLICY`).

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
  "apps": { "tool": { "require": { "sameIssuer": true } } }
}
```

Requirements from every file and section apply together, and trust adds up.
Unknown settings are an error, so a typo cannot quietly loosen anything.

**The format is described by a JSON Schema**, [`schemas/policy.schema.json`](schemas/policy.schema.json),
which is also the full reference for every setting. Each release attaches the schema
for that version, and the files `bundle policy init` writes, and the ones `bundle
policy show` prints, start with a `$schema` pointing at it:

```json
{
  "$schema": "https://github.com/pipobscure/bundles/releases/download/v0.0.13/policy.schema.json",
  "require": {}
}
```

So an editor that understands JSON Schema, VS Code among them, completes settings,
shows what each one means, and flags mistakes as you type. The schema ships in the
npm package as `@pipobscure/bundle/policy.schema.json` too, and a test holds it to the
checker `bundle` itself uses: the same settings, the same patterns, the same verdict
on every document.

### `uninstall`

```sh
bundle uninstall tool                        # by name
bundle uninstall https://example.com/tool.nzip   # by where it came from
bundle uninstall tool.example.com                # by the domain it was installed by
bundle uninstall                             # this package's own install
```

Deletes the file and forgets the record. With no argument it removes what
`bundle install` left behind — found by the URL it came from, whatever it ended
up called. The `.nzip` association on Windows is left alone:
other archives may need it, and it is not this one's to take away.

### `skill`

```sh
bundle skill                 # -> .claude/skills/audit-bundle/SKILL.md
bundle skill --list          # what this package carries
bundle skill --dir <dir> --force
```

Never overwrites a file that is already there unless forced, so local edits survive.

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

### Environment

A preload takes no arguments, so the mount is configured through the environment:

| | |
|---|---|
| `BUNDLE_MANIFEST` | where the recording provider writes the observed file list |
| `BUNDLE_ROOTS` | extra trusted roots, a path-delimiter-separated list of PEM files |
| `BUNDLE_ALLOW_UNTRUSTED` | mount an archive whose signature is good but unanchored |
| `BUNDLE_IDENTITY` / `BUNDLE_ISSUER` | require a particular sigstore signer at mount time |
| `BUNDLE_SIGSTORE_ROOT` | the sigstore trust root to check against, instead of the cache |
| `BUNDLE_ATTESTERS` | require attestations at mount time: space- or comma-separated `[kind@]did` |
| `BUNDLE_QUORUM` / `BUNDLE_ATTESTATION_MAX_AGE` | how many of them, and how stale a cached proof may be |
| `BUNDLE_BLOCK` | refuse at mount time what any of these DIDs has marked bad |
| `BUNDLE_ATTESTATIONS` | where the attestation cache is, instead of the state directory |
| `BUNDLE_POLICY` / `BUNDLE_SYSTEM_POLICY` | the user's and the machine's policy file, instead of the defaults |
| `BUNDLE_PLC_DIRECTORY` | the PLC directory `did:plc` resolves against |
| `BUNDLE_ATPROTO_IDENTIFIER` | the account `attest` signs in as |
| `BUNDLE_ATPROTO_PASSWORD` | an app password, for CI: `attest` uses it instead of signing in through the browser |
| `BUNDLE_OAUTH_CLIENT_ID` | a hosted OAuth client metadata URL, instead of the loopback development client |
| `BUNDLE_NO_BROWSER` | never try to open a browser when signing; use the device flow |
| `BUNDLE_AUDIT_VERDICT` | where the audit skill writes its verdict, when CI asks for one |

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
| **`"vfsArchive"`**, a ZIP as a SEA's file system — `bundle sea` only | open — [nodejs/node#65810](https://github.com/nodejs/node/pull/65810) |

v26.9.0 already had everything a program needs to *be* an archive: it reads ZIP archives,
turns one into a file system, resolves modules out of it, and loads native addons from it.
v26.10.0 added the way to ask for that mount from *outside* the program, which is the whole
hinge: **`--vfs-load`** makes a mounted tree the thing a program resolves and runs from, and
the same pull request brings `vfs.registerProvider()` — the extension point that lets a
preload decide what backs a mount, and therefore the one that makes a *verifying* mount
possible from userland at all.

**`--vfs-load` is the only flag.** v26.10.0 also shipped `--vfs-mount`, which mounted a source
without running it, and the next patch release removes it
([nodejs/node#66162](https://github.com/nodejs/node/pull/66162)): nothing needs more than one
mount from the command line, and a program that wants more mounts them through `node:vfs`,
where it also holds the instance. The same change reserves layer 0 for the `--vfs-load`
source, so it sits at the same mount point in every thread whatever else is mounted, and
mounts a program makes itself are numbered from 1. Nothing here uses `--vfs-mount`, and
mount points stay node's to assign: named mounts
([nodejs/node#66119](https://github.com/nodejs/node/pull/66119)) were closed rather than
merged.

[nodejs/node#65810](https://github.com/nodejs/node/pull/65810) is needed only to build an
executable. It lets a SEA's file system *be* a ZIP archive rather than a list of assets, which
is how this package gets inside one: `bundle sea` embeds the verifier bundle whole and node
mounts it. It is still open; everything else here works without it.

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
npm test               # 174 tests; generates a throwaway PKI into build/certs/ on first run
npm run typecheck
```

The suite needs Node 26.10 or later. The sixteen tests that build an executable also need
[nodejs/node#65810](https://github.com/nodejs/node/pull/65810); on a Node without it they skip
themselves and say why, and they run on the first Node that has it. [CI](.github/workflows/ci.yml)
runs the suite on every push to `main` and every pull request, on 26.10.0 — the floor
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
