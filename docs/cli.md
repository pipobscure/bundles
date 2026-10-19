# 🌳 `bundle` command reference

Everything `bundle` does, command by command. `bundle <command> --help` prints one command's
options in brief, and `bundle --help` lists the commands; this is the long form. For what the tool is and how to get started, see the
[README](../README.md). For how it works underneath, see [design.md](design.md).

```
bundle <command> [options] [arguments]
bundle <command> [subcommand] --help     bundle help <command> [subcommand]
bundle --help                            bundle -v, --version
```

| Building and signing | |
|---|---|
| [`create`](#create) | 🌳 build an archive from a list of files, behind a launcher or a binary if asked |
| [`parts`](#parts) | print the parts an app declares: each archive's package, url and hash |
| [`audit`](#audit) | report what is about to be reviewed, and gate signing on the verdict |
| [`sign`](#sign) | 🔐 sign an archive as it is: `app.unsigned.nzip` into `app.nzip`, or in place |
| [`sea`](#sea) | build a node runtime that verifies an archive before running it, unsigned until signed |

| Checking and running | |
|---|---|
| [`verify`](#verify) | verify an archive and report its trust state |
| [`run`](#run) | verify an archive, mount it, and run what is inside |

| Vouching | |
|---|---|
| [`attest`](#attest) | ✍️ vouch for archives from an atproto account, warn against them, or withdraw that — with a note and a post for context |
| [`like`](#like) | ★ like an app: a star for it, and a post saying so |
| [`likes`](#likes) | who likes an app |
| [`lexicon`](#lexicon) | show, check or publish the atproto lexicons attestations and listings are written in |

| Publishing and finding | |
|---|---|
| [`publish`](#publish) | list an archive's URL under a name, so others can find and install it |
| [`unpublish`](#unpublish) | take a listing down again |
| [`search`](#search) | search the listed archives by name, description and publisher |
| [`listings`](#listings) | every listed archive, from a local index kept in step with the network |

| Installing and keeping current | |
|---|---|
| [`install`](#install) | fetch an archive from a URL, a domain or a listing, or take a file, review it, and put it on your PATH, with its parts |
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
| [`node`](#node) | say which node runs bundles here, or install one where there is none |
| [`shell`](#shell) | print what to load at shell start: Tab completion, and a quiet re-check |
| [`links`](#links) | make `nzip:` links open bundle, or say whether they do |
| [`skill`](#skill) | install the bundle-auditing skill into a project |

## Conventions

- **`--help` (or `-h`) after a command prints that command's help**, and nothing else on the
  line is read, so it is what to add when unsure what the rest should be. After a
  subcommand (`bundle policy init --help`), it prints that subcommand's. After a `--`, and
  after `run`'s archive, it belongs to the program instead.
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
- **A server that says to slow down is waited for.** A 429, or a 503 that says when, from a
  PDS, a sign-in server, the PLC directory, the backlink index, Fulcio or a download, is asked
  again once the time it names has passed: `Retry-After` (seconds or a date), else atproto's
  `ratelimit-reset`, else a short backoff, up to five times. Each wait is said on stderr. A wait
  longer than ten minutes is not waited for: the command fails, saying until when
  (`BUNDLE_RATE_LIMIT_WAIT` allows longer). Rekor and the timestamp authority are retried with
  a backoff, since their client reads no `Retry-After`. Only requests that are safe to repeat
  are repeated: records are written at a key of their own, so a write sent twice is one write.
- **Errors go to stderr**, results to stdout. `--json`, where offered, prints a machine-readable
  result on stdout and nothing else there.
- **On a terminal, the output is formatted for people.** When stdout or stderr is a terminal,
  what goes there is marked up: 🌳 marks bundles and apps, 🔐 signatures, ✍️ attestations, and
  colour shows states. Piped or redirected, it is the plain, stable, line-oriented text shown in
  this reference, and that is what scripts should parse. Each stream decides for itself, so
  `bundle installed | less` pipes plain text while prompts on stderr stay formatted. `NO_COLOR`
  turns the colour off, and `TERM=dumb` turns the formatting off altogether. A Windows console
  other than Windows Terminal gets no emoji, which it would draw as boxes.
- **Nothing is done without asking that is not yours to decide.** A signer or attester nobody
  has accepted is a question; editing your shell's startup file is a question. With no
  terminal to ask on, those commands stop and say so (exit 4) rather than assume a yes.

## Exit codes

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

## Building and signing

### `create`

```
bundle create [options] < file-list
bundle create --base ./app --files app.manifest --launcher --output app.unsigned.nzip   # runs by name
bundle create --base ./app --files app.manifest --output app.unsigned.nzip              # a plain archive, for a mount
```

Builds an archive from a newline-separated list of files, read from `--files` or from stdin,
relative to `--base`. Each member records the digest of its own content, an `AUTHORITY.PEM`
member declares the algorithms, and the archive records its whole-file hash
(`UNSIGNED:<hash>` in its end comment). So even unsigned, it says what its bytes should be,
and anything that hashes it notices if they are not.

**This is where an archive's shape is decided.** `--launcher` puts this package's
`#!/bin/sh` launcher in front, so the result runs by name. `--prefix` puts something else
there: a launcher of your own, or a verifying node built by [`sea`](#sea). Without either it
is a plain archive, to be run from a mount. The prefix runs before anything in the archive
does, so it is part of what [`audit`](#audit) reviews, and [`sign`](#sign) keeps it as it is.

**The launcher finds a node new enough for the app.** It runs the `node` on `PATH` whenever
that is new enough, so the node you chose always wins. Otherwise it runs the newest one a
version manager has installed: nvm, fnm, volta, asdf, mise or n, each looked for where it keeps
its versions (`NVM_DIR`, `FNM_DIR`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `MISE_DATA_DIR`, `N_PREFIX`,
or their defaults), and then the nodes bundle downloaded itself ([`node`](#node)). It only
reads their directories; nothing is installed or switched. With none to be found, it exits
`69` and says what it found and what to install:

```
mdview: needs node 27.1.0 or newer, and none was found
  on PATH: node v26.11.1 at /usr/bin/node
  version managers (nvm, fnm, volta, asdf, mise, n), and bundle's own: none has one installed
  install node 27 or newer — 'bundle node install', or e.g. 'nvm install 27' or 'fnm install 27', or from https://nodejs.org — and run this again
```

**An app that asks for an entry in the desktop's applications** (`bundle.app` in its
`package.json`, see [`install`](#install)) is told here whether it will get one: the title,
which icon formats it carries, and anything that will keep an install from making it, such as an
unknown field, an icon missing from the file list or not in its format, or a platform with no
icon.

"New enough" is the app's `engines.node` in the `package.json` at `--base`, written into the
launcher's `need=` line when the archive is created, and never below 26.11.1, the first node
that can run a bundle at all. Only the lower bound is checked: a range with an upper one
(`^27`, `<29`) gets a warning, and runs on any node from its minimum on. A range the tool
cannot read stops `create`. A pre-release counts as coming before its release, so `27.0.0-rc.1`
does not satisfy `>=27.0.0`. The check costs one `node --version` when the node on `PATH`
will do. Windows runs no launcher; see [`install`](#install) for how it picks a node.

**The same files make the same archive.** Members are in the order of the sorted file list,
each dated with its file's own modification time, never the time of the build, and
`AUTHORITY.PEM` is dated as the newest member. A fresh checkout dates every file at the
moment of the checkout, so set `SOURCE_DATE_EPOCH` (seconds, e.g.
`SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)`) and no member is dated later than that.
`--date` gives every member one time instead, whatever the files say: what a rebuild passes
to make the archive it made before. [`sign`](#sign) keeps every member's time. Build with
`TZ=UTC` too: node writes ZIP times in
local time, so the same files built in two timezones differ in those bytes. With `--date`,
`create` warns when the timezone is not UTC. Another timezone is fine if every rebuild uses
it, and then the warning is only a reminder.

The result is **unsigned**, and that is a bundle in its own right: one that attestations can
vouch for, or that [`sign`](#sign) signs. Every bundle is an `.nzip`. While both an unsigned
and a signed copy are around, call the unsigned one `app.unsigned.nzip`: signing then writes
`app.nzip`.

| Option | |
|---|---|
| `-b, --base <dir>` | the directory the file list is relative to (default: `.`) |
| `-f, --files <file>` | read the file list from here (default: stdin) |
| `-o, --output <file>` | write the archive here (default: stdout) |
| `-l, --launcher` | put this package's `#!/bin/sh` launcher in front, so the result runs by name, with a node new enough for the app's `engines.node`. The usual way to make a program. |
| `-p, --prefix <file>` | put this in front instead: a launcher of your own, or a verifying node |
| `--date <iso8601>` | date every member with this one time: `2024-05-01T12:00:00Z`, `2024-05-01T14:00:00+02:00`, or a date alone (`2024-05-01`, midnight UTC). ISO 8601 only, with an offset whenever there is a time. Overrides the files' times and `SOURCE_DATE_EPOCH` |
| `-k, --key <file>` | sign as it is built, with this private key (PEM) — only with `--chain` |
| `-c, --chain <file>` | the certificate chain for `--key` (PEM, leaf first) |
| `--hash <alg>` | the digest for the whole-file hash and the member digests (default: `sha256`) |
| `--sign <alg>` | the digest the signature uses (default: `sha256`) |

Signing at build time is for a certificate authority of your own, and skips the review in
between. To review first, or to sign through sigstore, create unsigned and use [`sign`](#sign).

### `parts`

```
bundle parts [options] <archive>...
bundle parts auth.nzip mail.nzip                       # print what the app declares
bundle parts --write suite/package.json dist/*.nzip    # or put it in the app's package.json
```

An app can be made of **parts**: archives that ship beside it, each holding a package, which
installing the app installs as plugins in its scope (see [`install`](#install)). The app
declares them in its `package.json`, and this prints that declaration for the archives given:

```json
"bundle": { "parts": [
  { "package": "@acme/auth", "url": "auth.nzip", "hash": "sha256:3f1a…" },
  { "package": "@acme/mail", "url": "mail.nzip", "hash": "sha256:9c04…" }
] }
```

- **`hash` is the part's whole-file hash**, as `<alg>:<hex>`: the hash attestations name,
  `verify --json` reports and `create` prints. It is not the sha256 of the file. That also
  covers the archive's trailing comment, which is where a signature goes, and it is not what
  anything else in bundle names an archive by.
- **`url` is resolved against the app's own URL**, so a part beside the app is just its file
  name: what this writes, unless `--base` says where the app will be, when it is the archive's
  path from there.
- Every archive must hold together (its hash and every member's digest), and carry a package
  name, which is what the part is installed as and what the app imports.

So the order of a build is: build the parts, write the list into the app's `package.json`, then
create, audit and sign the app. Its signature, or an attestation of it, then covers the hash of
every part, and that is what makes a part trusted.

| Option | |
|---|---|
| `-b, --base <dir>` | where the app will be, so each `url` is the archive's path from there (default: the archive's own name) |
| `-w, --write <file>` | put the list into this `package.json` as `bundle.parts`, rather than printing it |

### `audit`

```
bundle audit [options] <archive>
bundle audit app.unsigned.nzip                                   # what is about to be reviewed, and how
bundle audit --baseline last-release.nzip app.unsigned.nzip      # ...as a diff against what was approved before
bundle audit --check app.unsigned.nzip && bundle sign …          # the gate
bundle audit --approve --note 'read every member' app.unsigned.nzip
```

The review itself needs judgement, so no command performs it. `audit` does the two mechanical
halves around it.

- **On its own**, it reports the archive's hash and members, and how to run the review: the
  [`audit-bundle`](../skills/audit-bundle/SKILL.md) skill (see [`skill`](#skill)), or reading it
  yourself. It shows the **prefix** too, because it runs first: a `#!` launcher line by line,
  a binary by size and hash. With `--baseline`, it says what was added and removed since an
  archive you approved before, and whether the prefix changed, so the review can be of the
  difference.
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

### `sign`

```
bundle sign [options] <archive>
bundle sign app.unsigned.nzip                               # -> app.nzip, signed through sigstore
bundle sign app.nzip                                        # signs it in place
bundle sign --key leaf.key --chain chain.pem app.unsigned.nzip   # your own CA
```

Signs an archive as it is: the same members, behind the same prefix it was created with, so
what is signed is what was reviewed. The certificate chain goes into `AUTHORITY.PEM`, and the
signature covers the **whole file**: the prefix, every member, and the central directory.

**Where the result goes.** `app.unsigned.nzip` is signed into `app.nzip` (and an executable
`app.unsigned` into `app`), leaving the unsigned copy as it was. Any other name is signed in
place. Either way the result is written beside its destination and moved over it only once
it is complete, so a sign that fails leaves everything as it was. `--output` names somewhere
else, and `--output -` is stdout. The result is made executable when the archive has a
prefix.

A shape is never chosen here. The old `--launcher` and `--prefix` options moved to
[`create`](#create), where the prefix is part of what gets reviewed.

**Through sigstore by default.** The signing certificate is issued for an identity you sign in
as. In CI that is the workflow's own token; elsewhere it is a browser sign-in, or a device
code. It is valid for about ten minutes, so there is no long-lived key to steal. A
transparency-log entry and a timestamp, recorded with the signature, are what let it verify
afterwards. Or sign against a certificate authority of your own with `--key` and `--chain`.

| Option | |
|---|---|
| `-o, --output <file>` | write the signed archive here; `-` for stdout (default: `app.unsigned.nzip` → `app.nzip`, otherwise in place) |
| `-x, --executable` | make the output executable (implied when the archive has a prefix) |
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

### `sea`

```
bundle sea --output <file> [options] [archive]
bundle sea --output app.unsigned --identity '<workflow>' --issuer '<issuer>' app.unsigned.nzip
bundle sign app.unsigned                                                        # -> app
bundle sea --output node-verifying --root my-root.pem                           # a verifying node
```

Builds a node runtime with this package's verifier inside it.

- **With an archive, the result is that application:** one executable that verifies its own
  signature before running anything. It is built **unsigned**, and refuses to run until
  [`sign`](#sign) signs it: the same create, audit, sign order as any archive, so the
  executable is reviewed as it will run. The signature covers the runtime and the verifier
  too. Any prefix the archive had is replaced by the runtime.
- **Without one, the result is a verifying node:** a runtime that takes an archive on its
  command line (`./node-verifying app.nzip --args`), verifies it, and runs it. `--verify`
  reports the trust state without running anything. It needs no signature of its own.

The policy flags given here (`--root`, `--identity`, `--issuer`, `--attester`, `--quorum`,
`--max-age`, `--untrusted`) are **baked in**, and a runtime with a policy is **sealed**: its
command line cannot loosen that policy. `--block` only ever tightens, so the runtime accepts
it at any time. Attestations are checked against the cache [`trust`](#trust) keeps, never the
network.

| Option | |
|---|---|
| `-o, --output <file>` | where to write the executable (required) |
| `--hash <alg>` | the digest for the whole-file hash and the member digests (default: `sha256`) |
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

A verifying node turns into an application the same way as anything else gets a prefix:
`bundle create --prefix node-verifying …`, then `bundle sign`. See
[standalone executables](../README.md#standalone-executables).

## Checking and running

### `verify`

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

### `run`

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
For a process of its own, spawn node with the arguments [`mountArgv`](api.md#the-library)
returns.

## ✍️ Vouching

### `attest`

```
bundle attest [options] <archive>...
bundle attest --as audit.example.com --kind audited app.nzip app app.unsigned.nzip   # one sign-in for all three
bundle attest --as scanner.example --verdict bad --kind malware app.nzip
bundle attest --as audit.example.com --revoke app.nzip
bundle attest --as pipobscure.com --kind published --from listings.json               # what publish --from lists
bundle attest --as audit.example.com --kind audited --note 'Read every member of 2.1.' app.nzip
bundle attest --as audit.example.com --kind audited --note 'Read every member of 2.1.' --note-as-post app.nzip
bundle attest --as scanner.example --verdict bad --kind vulnerable --post https://bsky.app/profile/scanner.example/post/3l… app.nzip
```

An attestation is an atproto record, in the attester's own repository, saying *I vouch for the
archive with this whole-file hash*: the same hash a signature covers. It can say what kind of
claim it is (`published`, `audited`, `reproduced`), or it can say the opposite: `--verdict bad`
warns everyone who installs the file, with `--kind` saying why (`malware`, `vulnerable`, …).
Anyone with an atproto account (any `did:plc` or `did:web`) can attest, and only they can
withdraw their attestation.

- **Every archive named is checked first.** One whose bytes or signature do not hold
  together stops them all, before anyone signs in.
- **`--from` takes the file [`publish --from`](#publish) reads.** Each entry's archive is
  fetched from its `url`, or from the URL its `domain`'s `nzip:` record names, checked like a
  local one, and attested with the rest; the other fields are not used here. One file then
  both lists a release and vouches for it.
- **Then one sign-in covers them all.** It uses OAuth in the browser, against the account's
  own PDS. It asks for write access to attestation records and nothing else
  (`repo:com.pipobscure.bundle.attestation`). It falls back to general write access only on a
  server that does not offer that, and says so.
- **Nothing is kept.** The session is revoked when the command is done, so every attestation
  is approved by whoever it speaks for. In CI, where there is no browser, an app password
  from `BUNDLE_ATPROTO_PASSWORD` or `--password-file` is used instead, and its session is
  kept for a few minutes so commands in a row sign in once (see [Signing in](#signing-in)).
- **What it writes** is `at://<your DID>/com.pipobscure.bundle.attestation/<hash>`: one record
  per account per file, so attesting again replaces the old record.
- **All of them go in one request**: atproto's `applyWrites`, up to 200 records each, rather
  than a request per archive, since every request counts against the account's rate limits.
  If some were attested before, the PDS refuses to create those, so the account's attestations
  are listed once and the batch is sent again, replacing them. `--revoke` works the same way.
- **Nothing is read back.** The PDS saying it wrote the records is taken as written. Your
  attestations reach the local cache, verified, the next time something fetches them:
  [`trust`](#trust), [`verify --attester`](#verify), an install.

**An attestation can say why.** Both parts are optional, and either or both can be given:

- **`--note`** is context in your own words, kept in the attestation itself: why you vouch for
  the file, or what is wrong with it. 300 characters at most.
- **`--post`** links a post that gives the context: yours or anyone's, a thread, an advisory.
  It takes the post's `https://bsky.app/profile/…/post/…` link or its `at://` address. The post
  is fetched from its author's PDS and verified first, and the attestation pins the version there
  now, by its CID.
- **`--note-as-post`** posts the note from the same account too, and links that post. The
  sign-in then asks to create (and, should the attestation fail, delete) posts as well as
  attestations. A post made for an attestation that cannot be written is taken down again.
- **`--note-from-post`** takes the note from the linked post's text, so the context travels with
  the attestation even where the post cannot be fetched.

The note and the post are shown wherever the attestation is: to whoever reviews the file in
[`install`](#install) and [`update`](#update), by [`verify`](#verify), and by
[`validate`](#validate) when the attestation is new. A note is anyone's words, so it is shown
quoted, with anything that could steer the terminal taken out. Neither decides anything: an
attestation counts, or refuses a file, exactly as it would without them.

How attestations are used, and what they do and do not prove, is in [`install`](#install),
[`verify`](#verify), the [policy](#policy) and
[proposals/atproto-attestations.md](../proposals/atproto-attestations.md).

| Option | |
|---|---|
| `--as <handle or did>` | the account to attest as (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--kind <kind>` | what is being said: `published`, `audited`, `reproduced`, or with `--verdict bad`, `malware`, `vulnerable`, … |
| `--verdict <good or bad>` | `good` (the default) vouches for the file; `bad` warns against it |
| `--note <text>` | context, in your own words; 300 characters at most |
| `--post <link or at://>` | a post that gives the context, linked from the attestation |
| `--note-as-post` | also post the note from the account, and link that post |
| `--note-from-post` | take the note from the `--post`'s text |
| `--from <file>` | attest these too: the JSON file [`publish --from`](#publish) reads, each entry's archive fetched from its `url` or `domain` |
| `--revoke` | withdraw your attestations of these archives instead |
| `--password-file <file>` | use an app password from this file instead of signing in (`BUNDLE_ATPROTO_PASSWORD` works too). Never take a password as an argument. |
| `-r, --root <file>` | an extra trusted root, for checking the archives first; repeatable |

Different shapes of one release are different bytes. Attest each one you publish.

### `like`

```
bundle like [options] <installed app | @account/name | nzip:link | at://>
bundle like --as you.example @alice.example/tool
bundle like --as you.example --note 'Saved my Sunday.' tool
bundle like --as you.example --yes tool
bundle like --as you.example --revoke tool
bundle like --as you.example --revoke --all tool
```

A like is a star for an app, from an Atmosphere (atproto) account. It is of the app's listing,
not of one release, so it stays with the app as it is released again. The app must be published
(see [`publish`](#publish)). An app installed from its listing can be named as it is installed.

**Liking again is fine.** An account has one like of an app, and each time it likes it again,
that like counts one more and lists the new post, so a second like is a second recommendation to
the people who follow you, not a second star. It is reviewed in your editor like the first.
Two machines liking at once lose neither like: each writes over the like as it read it, and one
that finds it changed meanwhile reads it again.

**Every like comes with a post** from the same account: your `--note`, or else
`🌳 I like <title>: <description>` from the app's listing, and then the app's `nzip:` link, so
whoever reads it can install the app in one click. bundle itself is the one exception: its likes
link to its page, https://bundle.pipobscure.com/, since an `nzip:` link opens bundle, and whoever
reads about it may not have it yet. The sign-in asks to write likes and to create and delete
posts, and nothing else.

**`--revoke` takes the like back and leaves its posts up**: they are ordinary posts, and say what
they said; bundle says how many stay. `--revoke --all` takes down every post the like lists that
is in your own repository too, as far as it can, and says how many went. A post in anyone else's
repository is never touched, and `--all` without `--revoke` is refused before signing in.

**You read the post before it is made**, the way you read a commit message: it opens in your
editor (`BUNDLE_EDITOR`, else `VISUAL`, else `EDITOR`, else `vi`, or `notepad` on Windows,
started through the shell so that `code --wait` works), under comment lines saying what it is,
which account posts it, and which app it likes. Save and close, and it is posted as it stands:
the whole text is yours, the link too, which is made a link wherever you put it — taken out, the
post goes without one, and bundle says so. Close without saving, or leave nothing but comments,
and nothing is liked. Lines that start with `# `, or are `#` alone, are left out; a line like
`#nodejs` is a hashtag, and stays. A post over 300 characters opens the editor again, with your
text as you left it and how long it is. All of this happens before signing in, so stopping costs
nothing. Liking again, the comment lines say which like of the app from this account it is. Not
on a terminal, `like` stops with exit code 4 and the post it would make, unless `--yes` posts
that as it is. `--revoke` opens no editor.

What it writes is `at://<your DID>/com.pipobscure.bundle.like/<sha256 of the listing's address>`:

```json
{ "$type": "com.pipobscure.bundle.like",
  "subject": "at://<publisher>/com.pipobscure.bundle.listing/tool",
  "count": 3,
  "posts": [{ "uri": "at://<your DID>/app.bsky.feed.post/…", "cid": "…" }, …],
  "createdAt": "<the first like>", "updatedAt": "<the latest>" }
```

`posts` is oldest first, and keeps the newest 100; `count` counts on past them, and
`--revoke --all` can take down only the posts listed. A like written by 0.2.0 or 0.2.1 has one
`post` and no `count`; it reads as liked once, with that post, and is written in the shape above
when liked again. Likes decide nothing: nothing is installed or refused by them.
[`search`](#search) and [`listings`](#listings) show how many accounts like each app, however
often each has liked it, and [`likes`](#likes) who, and how often.

| Option | |
|---|---|
| `--as <handle or did>` | the account to like it from (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--note <text>` | what the post says, in your own words, before the link |
| `-y`, `--yes` | post it as proposed, without opening an editor (needed off a terminal) |
| `--revoke` | take the like back; its posts stay up, as posts |
| `--all` | with `--revoke`, take down the like's posts in your own repository too |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |

### `likes`

```
bundle likes [options] <installed app | @account/name | nzip:link | at://>
bundle likes @alice.example/tool
```

Who likes an app, the latest like first: each account with how many times it has liked the app
(said when it is more than once), what its latest post says and a link to it, and how many
earlier posts there are. The likes are found through the backlink index the [policy](#policy)
names (`discovery`), then each is fetched from its author's own PDS and verified. The count at
the top is of accounts, as the index keeps it, so one account counts once however often it likes
the app, or however many records it writes; when those shown liked more often than that, how
often is said beside it.

| Option | |
|---|---|
| `--limit <n>` | show at most this many (default: 25) |
| `--json` | print `{ listing, total, likes: [{ did, handle, createdAt, updatedAt, count, posts, post, text }] }`: `total` is accounts, `posts` oldest first, `post` the latest of them, and `text` its text |

### `lexicon`

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
  name (unless `--force`), and writes them all in one `applyWrites`. Nothing is read back;
  `check` does that, verified, whenever it is wanted.

This is for whoever owns the lexicons' domain; using attestations or listings needs none of it.

| Option | |
|---|---|
| `--as <handle or did>` | the account to publish from (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--dry-run` | say what `publish` would write, and stop before signing in |
| `--force` | publish even though DNS does not name that account yet |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |

## Publishing and finding

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

### `publish`

```
bundle publish [options] <name> <url | domain> [<name> <url | domain>]...
bundle publish --as pipobscure.com --description 'blink an LED' bled https://github.com/pipobscure/bled/releases/latest/download/bled.nzip
bundle publish --as pipobscure.com dns https://…/dns.nzip desec https://…/dns-desec.nzip      # several, one batch
bundle publish --as pipobscure.com --from listings.json                                        # each with its own description
bundle publish --as pipobscure.com --description 'blink an LED' bled bled.pip.fyi     # the URL is the TXT record's to say
bundle publish --as alice.example --for @pipobscure.com/bled bled-gpio https://…/bled-gpio.nzip   # a plugin for bled
```

Writes `at://<your DID>/com.pipobscure.bundle.listing/<name>`, naming the URL, or the domain.
It prints how to install what it listed, and the `nzip:` link to put on a page so that one
click installs it (see [`install`](#install)).
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
- **Several are one batch.** Give several `<name> <url | domain>` pairs, or `--from` a JSON
  file: an array of `{ "name", "url" or "domain", "title", "description", "for" }`, where only
  the name and one of url or domain are needed. Every one is checked first, and one that fails
  stops them all, before anyone signs in. Then there is one sign-in, one read of the account's
  listings (to keep when each was first listed), and one `applyWrites` for all of them.
  `--title` and `--description` describe a single listing; for several, put them in the file.
- **Nothing is read back.** The PDS saying it wrote the listings is taken as written, since
  every request counts against the account's rate limits.
- **A plugin is listed against its app.** With `--for`, the listing's `subject` is the
  `at://` address of the app's listing, not the concept hash. So it never appears among apps,
  and `search --for` and `listings --for` find exactly that app's plugins. It installs, and its
  `nzip:` link works, with no `--for`: into the app installed from the listing it names, wherever
  that is installed. An app installed
  from a URL or a domain has no listing for plugins to name, so its plugins can't be listed.
  They still install with `install --for`, from a URL or a domain.

| Option | |
|---|---|
| `--as <handle or did>` | the account to publish from (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--for <app>` | list it as a plugin for this app: an app installed from its listing, `@<handle or did>/<name>`, or an `at://` address |
| `--title <text>` | a display name (default: the name) |
| `--description <text>` | what it is, in a sentence or two (at most 300 characters) |
| `--from <file>` | list these too: a JSON array of `{ "name", "url" or "domain", "title", "description", "for" }`. `--for` applies to entries that do not name their own |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |
| `-r, --root <file>` | an extra trusted root, for checking the archive first; repeatable |

### `unpublish`

```
bundle unpublish [options] <name>...
bundle unpublish --as pipobscure.com bled bled-gpio
```

Deletes the listings, as one batch after one read of the account's listings. Exits `1` if one
of them was not there; the others are still taken down. Installs made from it keep working, and keep
checking the URL it last named; [`update`](#update) says the listing is gone.

| Option | |
|---|---|
| `--as <handle or did>` | the account the listing is in (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |

### `suite`

```
bundle suite add [options] <listing>...         # add to a spec, asking what to require of each
bundle suite remove [options] <listing>...
bundle suite update [options] [listing]...      # ask again what to require
bundle suite validate [options] [suite]         # consistent, and does everything published still meet it?
bundle suite show [options] [suite]
bundle suite publish [options]                  # write it to an atproto account
bundle suite unpublish [options] <name>
bundle suite attest [options] [suite]           # vouch for it, or prohibit it, as a whole

bundle suite add --suite devtools.json @pipobscure.com/bled
bundle suite add --suite devtools.json --for @pipobscure.com/bled @alice.example/bled-gpio
bundle suite validate --suite devtools.json
bundle suite publish --suite devtools.json --as pipobscure.com
bundle install @pipobscure.com/devtools
```

A **suite** is a set of listings installed together. `bundle install @<account>/<suite>` installs
each member as `bundle install` would install it by itself, and [`update`](#update) keeps the
installed suite in step with it: members added are installed, members taken out are removed.

**A suite vouches for nothing.** Each member is reviewed and verified on its own, under the
installing machine's policy. What a suite can do is set a **minimum** for each member: a signer,
attesters. A member that does not carry its minimum is refused, at install and at every update,
and [`installed`](#installed) says so. Meeting it accepts nothing by itself.

**Asked once.** Because the suite says up front whom it expects its members to carry, installing
it shows all of them together, once:

```
* suite devtools expects its members to carry:
   1 signed by   https://github.com/pipobscure/bled/.github/workflows/publish.yml@refs/heads/main via https://token.actions.githubusercontent.com — for bled
   2 attested by published@did:plc:… — for bled-gpio
  accept which, for those members? numbers (1,2), 'all', or Enter to decide each on its own:
```

Whoever you accept counts as accepted for each member that names them, so the rest installs
without asking, and later updates remember it. A member that carries something else is still a
question of its own. `--yes` accepts everything shown.

#### The spec

A suite is written as a JSON file, its **spec**: the record as it will be published, plus its
name. [`schemas/suite.schema.json`](../schemas/suite.schema.json) describes it, and `suite add`
writes a `$schema` that points at the released copy, so an editor can complete and check it.

```json
{
  "$schema": "https://github.com/pipobscure/bundles/releases/download/v0.1.0/suite.schema.json",
  "name": "devtools",
  "members": [
    {
      "listing": "at://did:plc:…/com.pipobscure.bundle.listing/bled",
      "label": "@pipobscure.com/bled",
      "require": {
        "identity": "https://github.com/pipobscure/bled/.github/workflows/publish.yml@refs/heads/main",
        "issuer": "https://token.actions.githubusercontent.com"
      }
    },
    {
      "listing": "at://did:plc:…/com.pipobscure.bundle.listing/bled-gpio",
      "label": "@alice.example/bled-gpio",
      "for": "at://did:plc:…/com.pipobscure.bundle.listing/bled",
      "require": { "attesters": ["published@did:plc:…"] }
    }
  ]
}
```

- **`listing`** is the member's listing, by its `at://` address with the publisher's DID.
- **`for`** installs it as a plugin. It names either the listing of the app it is for, which
  installs it into that app's scope wherever the app is installed from that listing, or a scope
  directly (a package name, such as a suite's shared one). Without it, an app installs onto the
  PATH, and a plugin's listing says which app it is for. Apps are installed before plugins,
  whatever the order in the file.
- **`require`** is the member's minimum: `identity` and `issuer` of the sigstore signature,
  `attesters` as `[kind@]<did>`, and `quorum`, how many of those must have attested (default:
  all).
- **`label`** and **`forLabel`** are what was typed, kept for whoever reads the file. They are
  not published.

Any other setting is an error, so a typo cannot quietly drop a requirement.

#### Subcommands

- **`add <listing>...`** adds listings, given as `@<handle or did>/<name>` or `at://`
  addresses. Each listing is fetched from its publisher's PDS and verified, the archive it names
  is fetched, and everything that vouches for it is shown, numbered, as an install shows it.
  Then you're asked which of that the suite should require. The signature and good attestations
  can be required. `--yes` requires all of it. `--for` adds them as plugins, for an app's listing
  (`@<handle or did>/<name>`, or an `at://` address). Adding a member again replaces it. A spec
  that is not there yet is made, named after the file.
- **For now, a plugin goes in only with its app.** Add the app first, then its plugins. `add`,
  `validate` and `publish` refuse a plugin for an app that is not in the suite, and anything
  for a shared scope. How suites of plugins alone should work is not settled yet, and a suite
  published now would be a precedent to support. This is a rule of these commands only: the
  lexicon and the schema allow more, and `install` installs a suite published some other way
  as it is. So lifting it later breaks nothing.
- **`remove <listing>...`** takes members out, by what they were added as, their address, or
  `@<handle or did>/<name>`. Exits `1` when one was not a member.
- **`update [listing]...`** asks again, for the members named or all of them, what to require.
  Each is fetched as `add` fetches it and shown with what is required now marked, and with
  anything required that it no longer carries. Enter keeps what is required now.
- **`validate`** checks that the file holds together. Every member's listing, and every app one
  is for, must be there, a plugin must be for the app its listing says, and (for now) every
  plugin's app must be in the suite. Then it fetches what
  each listing serves now and checks that it carries what the suite requires of it. That is
  judged by the suite's requirements alone, not this machine's policy. Each member's line names the
  URL and the hash of what it serves now. It exits `1` when anything does not hold, so it can gate
  a release. Given a published suite (as `install` takes one) it checks that instead of a spec,
  which is what to run before permitting one.
- **`show [suite]`** prints the suite, a spec or a published one: its hash (what an attestation
  of it names), and each member with what it requires. `--json` prints it as a spec.
- **`publish`** writes the spec as `at://<your DID>/com.pipobscure.bundle.suite/<name>`. First it
  checks that every member's listing, and every app one is for, is there, and (for now) that
  every plugin's app is in the suite, before signing in with
  write access to suite records only. A suite can't share its name with a listing on the same
  account, because `@<account>/<name>` installs the listing. Publishing again replaces it, keeping
  when it was first published, and every install of it follows on its next update.
- **`unpublish <name>`** takes it down. Installs keep what they have, and their updates say it
  is gone.
- **`attest [suite]`** attests a suite: the spec, or a published one named as `install` takes it.
  See [Attesting a suite](#attesting-a-suite).

#### Publishing without atproto

The spec is also what a suite is when it is served by itself. Put the file at an `https:` URL,
and `bundle install <url>` installs it: what comes back starting with `{` is a suite, not an
archive. Or name that URL in a TXT record on a domain:

```
devtools.example.com.  TXT  "nsuite:https://example.com/devtools.json"
```

Then `bundle install devtools.example.com` installs it. As with `nzip:`, a relative URL is
resolved against `https://<domain>/`, and the record only says where. A domain that publishes
both an `nzip:` and an `nsuite:` record is refused, since it would not be clear which is meant.
An installed suite remembers the URL or domain, and `update` asks it again.

#### Attesting a suite

A suite has a hash: the sha256 of the DAG-CBOR encoding of `{ members }`, each member as it is
published. Its title and description are left out. It is the same wherever the suite is
published, and any change to what it says makes another. `bundle suite attest` writes an
ordinary `com.pipobscure.bundle.attestation` of that hash, so discovery, the cache and
withdrawal all work as they do for archives.

- **A good attestation carries over.** Installing a member of the suite, it counts as an
  attestation of the member, shown as `via suite <name>`, so a policy that requires
  `permitted@<did>` is met by a suite that DID attests `permitted`. It holds only while the
  suite is as it was attested, and only for members that carry what the suite requires, which
  is what was reviewed.
- **What is said of a bundle itself wins.** An attester's attestation of the member is used
  instead of theirs of the suite. So a suite can be permitted while one bundle in it is
  prohibited, and the bundle is refused where the policy blocks on that attester.
- **A bad verdict stays with the suite.** Attested bad (`--kind prohibited --verdict bad`), the
  suite is refused by any machine whose policy blocks on that attester, at install and on update,
  and its members are left as they are. It does not carry over: a bundle in a prohibited suite
  can still be permitted, and installed, on its own.

This is what an IT department needs to push out one rule:

```json
{ "require": { "attesters": ["permitted@did:web:it.example.com"] }, "block": ["did:web:it.example.com"] }
```

Then it permits whole suites, or single bundles, from its own account, and prohibits either.

| Option | |
|---|---|
| `-s, --suite <file>` | the spec (default: `suite.json`) |
| `--for <app>` | `add`: install them as plugins, for the app installed from this listing (`@<handle or did>/<name>`, or an `at://` address). For now, the app must be in the suite |
| `-y, --yes` | `add`, `update`: require everything shown that can be |
| `-r, --root <file>` | an extra trusted root, for checking archives; repeatable |
| `--no-discover` | do not ask the backlink index who has attested an archive |
| `--json` | `show`: print the spec as it is |
| `--as <handle or did>` | `publish`, `unpublish`, `attest`: the account (default: `BUNDLE_ATPROTO_IDENTIFIER`) |
| `--password-file <file>` | an app password instead of signing in, for CI (`BUNDLE_ATPROTO_PASSWORD` works too) |
| `--kind <kind>` | `attest`: what is vouched for: `permitted`, `prohibited`, … |
| `--verdict <good or bad>` | `attest`: vouch for it, or warn against it (default: `good`) |
| `--note <text>` | `attest`: context, in your own words; 300 characters at most |
| `--post <link or at://>` | `attest`: a post that gives the context, linked from the attestation |
| `--note-as-post` | `attest`: also post the note from the account, and link that post |
| `--note-from-post` | `attest`: take the note from the `--post`'s text |
| `--revoke` | `attest`: withdraw the account's attestation of it |

### `search`

```
bundle search [options] <words>...
bundle search led
bundle search --json bled
```

```
@pipobscure.com/bled   ★ 12  blink an LED
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
app's listing, so plugins for apps you don't have are never fetched. The first column installs a plugin as it is,
into the app installed from the listing it names, with no `--for`.

Nothing is installed from the index. `install` fetches the listing again, from the publisher's
own PDS, and verifies it.

**★ is how many accounts like the app** (see [`like`](#like)), as the backlink index counts
them, asked for each listing shown. It is left out with `--offline`, when discovery is off, or
when the index does not answer; a search never fails for want of it.

| Option | |
|---|---|
| `--for <app>` | search the plugins listed for this app instead |
| `--refresh` | sync first, however recent the index is |
| `--offline` | answer from the index as it is, without the network |
| `--json` | print `[{ install, did, handle, name, title, description, url, domain, for, createdAt, likes }]` |

### `listings`

```
bundle listings [options]
```

Every listing in the index, by name, synced first exactly as for [`search`](#search), with how
many accounts like each.

| Option | |
|---|---|
| `--for <app>` | the plugins listed for this app instead |
| `--refresh` | sync first, however recent the index is |
| `--offline` | answer from the index as it is, without the network |
| `--json` | print the listings as JSON, as `search --json` does |

## Installing and keeping current

### `install`

```
bundle install [options] [url | domain | @account/name | nzip:link | ./file.nzip | ./folder]
bundle install https://example.com/tool.nzip     # fetch, review, put on PATH
bundle install ./tool.nzip                      # a file, without the network
bundle install --system https://ordner.fyi/bundles/suite/suite.nzip   # for the machine, with its parts
bundle install tool.example.com                 # whatever its TXT record names, as `tool`
bundle install @pipobscure.com/bled             # whatever that listing names, as `bled`
bundle install @alice.example/bled-gpio         # a plugin's listing: into the scope of the app it names
bundle install --for bled @alice.example/bled-gpio   # a plugin for bled, into bled's scope
bundle install @pipobscure.com/devtools         # a suite: every listing in it
bundle install --window nzip:pipobscure.com/devtools   # what clicking that link runs
bundle install --window 'nzip:alice.example/bled-gpio?for=bled'   # a plugin's link, saying its app
bundle install                                  # this package, from the release its listing names
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
Windows, where it is what makes the file runnable. The command goes in `~/.local/bin`
(`%LOCALAPPDATA%\bundle\bin` on Windows; `BUNDLE_INSTALL_DIR` or `--dir` anywhere), and you are
told if that directory is not on your `PATH`.

**🌳 On macOS and Linux the archive is kept apart from the command.** The archive itself goes
to `$XDG_DATA_HOME/bundle/apps/<name>.nzip` (`~/Library/Application Support/bundle/apps/` on
macOS; `BUNDLE_APPS` anywhere), made executable, and what goes on the `PATH` is a symlink to
it. So the archive keeps its `.nzip`, and with it the file type and its icon, while you call it
by its bare name. An update replaces the archive, and every link to it runs the new one. You can
rename the link, or add another, without changing the archive: `update` keeps working through
it, `installed` lists every link in that directory under *runs as*, and `uninstall` removes
them all. A link moved to some other directory is not found again. An install made before
this layout moves into it on its next `update`, keeping its command as a link. On Windows the
archive is the command, as `<name>.nzip` on the `PATH`.

On Windows it also registers `.nzip` for the current user, adds it to `PATHEXT`, and
broadcasts the change so a new terminal sees it. The association names one node for every
`.nzip`, chosen as a launcher would choose it: the `node.exe` on `PATH` when it is 26.11.1 or
newer, else the node running the install, else the newest a version manager has installed
(nvm-windows, fnm, volta, mise). So installing this package from npm under an older node still
leaves `.nzip` opening with one that runs it. With none to be found, the association is left
as it is, and the install says what to do. It writes `HKCU\Environment` directly rather
than through `setx`, which would freeze a copy of the machine's value. Both halves are checked
before they are written, so installing twice changes nothing. An `.nzip` default set in
Windows' app settings is reported rather than overridden. cmd runs an archive by name, or by an
unquoted path, but refuses a *quoted* path. See [examples/echo-argv/windows](../examples/echo-argv/windows/).

**🌳 `.nzip` files get the bundle icon**, on every system, for the current user and without
administrator rights. On Windows, `NodeBundle`'s `DefaultIcon` points at a copy in
`%LOCALAPPDATA%\bundle\icons\nzip.ico`, and Explorer is told to redraw. On Linux and other
freedesktop systems, `$XDG_DATA_HOME/mime/packages/pipobscure-bundle-nzip.xml` declares
`application/x-nzip` for `*.nzip`, with its icon in `$XDG_DATA_HOME/icons/hicolor`, and
`update-mime-database` is run. On macOS, a small app at
`~/Library/Application Support/bundle/NodeBundle.app` declares the type
`com.pipobscure.bundle.nzip` and its icon, and is registered with Launch Services; it never
opens files itself. Each part is checked before it is written, so installing twice changes
nothing, and a part that fails is reported without failing the install. Plugins do none of
this. `uninstall` leaves it in place, since other archives may rely on it.

**An app can ask for its own entry in the desktop's applications**, with its own name and
icon, so people open it from the menu, Launchpad or Start rather than typing a command. This
suits an app with a window, such as one that opens a Chromium app window onto a page it
serves. The request is in the app's `package.json`, inside the signed archive, so the name and
icon a menu shows are covered by the same signature and the same decision as the code:

```json
"bundle": {
  "app": {
    "title": "davsync",
    "description": "Two-way sync of folders with WebDAV",
    "args": [],
    "categories": ["Network", "FileTransfer"],
    "icons": { "svg": "public/icon.svg", "icns": "public/icon.icns", "ico": "public/icon.ico" }
  }
}
```

Only `title` is required. `args` go after the command, `categories` are freedesktop category
names, and each icon is a file in the archive in the format its key names (`svg`, `png`,
`icns`, `ico`). Nothing is converted at install: Linux shows the SVG, else the PNG; macOS the
`.icns`; Windows the `.ico`; a platform whose format is missing shows none. A field bundle does
not know, or an icon that is not what it says, is reported rather than ignored, and
[`create`](#create) reports it at packing time. What each platform gets, for the current user
only:

- **Linux** and the other freedesktop systems: `$XDG_DATA_HOME/applications/bundle-<name>.desktop`,
  with its icon in `$XDG_DATA_HOME/bundle/icons/`, named by absolute path.
- **macOS**: `~/Applications/<title>.app`, holding the `.icns`, an `Info.plist`, and a
  two-line script that runs the installed archive. It is registered with Launch Services. It
  stays out of the Dock (`LSUIElement`), because a script that becomes node never checks in
  there and its icon would bounce for as long as the app runs; the window it opens has its
  own icon.
- **Windows**: a Start menu shortcut that starts a hidden PowerShell, which runs the node the
  `.nzip` association names with the archive mounted. node is a console program, and an app
  opened from Start should not bring a console window with it. The script is in
  `%LOCALAPPDATA%\bundle\apps\`, the icon in `%LOCALAPPDATA%\bundle\icons\`.

What an entry runs is always the installed archive with the declared `args`, quoted for
where it goes, never a command line the app wrote. An entry is never made over anything bundle
did not make: an app of the same title from elsewhere keeps its place, and this one gets none,
with a note saying so. [`update`](#update) keeps the entry current, renaming it with its title,
and [`uninstall`](#uninstall) takes it away. `--no-menu` declines it for this install and its
updates, and `BUNDLE_NO_DESKTOP_SETUP` makes no new ones. A failure is a note, never a failed
install. Plugins never get one.

**One click installs from an `nzip:` link.** An author puts a link on their page:

```html
<a href="nzip:alice.example/devtools">Install devtools</a>
```

When bundle installs itself, it registers to open such links for the current user. Clicking
one, the browser asks whether to open bundle, and bundle runs `install --window` with the
link: the same install as `bundle install @alice.example/devtools`, with every decision made
in a window instead of at a terminal. Someone who never opens a terminal sees the same review
and answers the same questions.

- **A link names something published, and nothing else**: `nzip:<handle or did>/<name>` for a
  listing or a suite, or `nzip:at://<did>/<collection>/<name>`. It is never a URL or a domain,
  so a page cannot point bundle at an arbitrary download. A link carries no trust of its own.
  What it names is fetched, verified and reviewed as any install is, and what a suite requires
  of its members comes from the suite's signed record. Any page can make a link, so it is read
  strictly: anything after the name but `?for=`, or anything that is not one of those forms, is
  refused before anything is fetched. [`publish`](#publish) and [`suite publish`](#suite) print
  the link for what they publish, a plugin's listing included.
- **A link to a plugin's listing installs the plugin into its app**, as `bundle install` does
  (see `--for` below): the app installed here from the listing the plugin's listing names. If
  that app is not installed here, the window says so, with the app's own link to install it
  first. A link may also say the app, `nzip:alice.example/bled-gpio?for=bled`, with what
  `--for` takes that a page can know: a package name (`bled`, `@acme/editor`), or an app's
  listing (`@<handle or did>/<name>`, or its `at://` address), percent-encoded or not. That is
  one parameter, once: `for` with anything else, twice, empty, or in another form is refused.
  It is only ever checked against the plugin's listing, never in place of it: when the listing
  names an app installed here, the two must agree, as `--for` must. With `--for` given as well,
  they must agree too, and neither wins. It places a plugin's listing and nothing else: on an
  app's listing it is refused rather than turning the app into a plugin, and on a suite it is
  refused, as `--for` is. The review, and the window's title and log, say which app it goes in.
- **How each system hands it over**: the link is always passed as one argument, after `--`,
  never into a command line anything parses.
  - Linux: a hidden desktop entry, `$XDG_DATA_HOME/applications/bundle-nzip-links.desktop`, for
    `x-scheme-handler/nzip`, made the default with `xdg-mime`.
  - macOS: links arrive as an Apple Event, which a script cannot receive. The handler is
    therefore a small AppleScript applet, `~/Library/Application Support/bundle/NodeBundleLinks.app`,
    compiled with `osacompile`, told its scheme with `plutil`, signed ad hoc again, and
    registered with Launch Services.
  - Windows: the `nzip` URL protocol in `HKCU\Software\Classes`, which runs
    `%LOCALAPPDATA%\bundle\links.ps1` in a hidden PowerShell.

  Uninstalling bundle takes the handler away again.
- **The window** is a page served by bundle on `127.0.0.1`, at a path holding a random token,
  with a Content-Security-Policy that allows only itself. It opens as a Chromium app window
  when Chrome, Edge, Chromium or Brave is installed, and in the default browser otherwise. Only
  that address and port answer, so a page elsewhere cannot reach it through a DNS name pointed
  at the loopback address. Answers are taken only as JSON from its own origin. Closing the
  window declines whatever is still being asked, once a minute has passed. The URL is printed
  too, and with `BUNDLE_NO_BROWSER` set nothing is opened.

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
the app loads by package name, with `@pipobscure/bundle/plugins` (see [Plugins](../README.md#plugins)).
`--for` takes the app as it is installed (`bled`), or as it is listed
(`@pipobscure.com/bled`, or its `at://` address: the app installed here from that listing),
either mapped to its package name, or that package name itself. A listing no installed app came
from is refused: install the app first. A plugin's listing needs no `--for` (see below). The plugin goes into that app's **scope**: a directory of the app's own
(`~/.local/share/bundle/plugins/<scope>/`; see [Files and directories](#files-and-directories)),
under the package name inside it. It is not made executable and is never on the PATH.

It is reviewed like any install, under the policy's global rules and its `scopes` section for
that app, never the app's own `apps` section, because a plugin's author is not the app's.
A listing that says it is a plugin for an app (see [`publish`](#publish)) names the app's
listing, so it installs into the scope of the app installed here from that listing, without
`--for`, and `--for`, if given, must name that app. If no app here was installed from that
listing, it is refused, saying how to install the app first; an app installed from a URL or a
domain is named with `--for`, since then the person installing is the one who knows. If the app
was installed from its listing more than once, as different packages, `--for` says which.
Its record is `<scope>:<package>`, which `update`, `installed`, `validate` and `uninstall`
take like any other name. What was typed to install it is kept beside it, and is the name
`list()` tells the app it goes by. An update that carries another package name is refused, because it
is a different plugin.

**`--for` with a folder links it**, for developing a plugin: `./bled-gpio`, `../x`, an absolute
path, `~/…` or a `file:` URL (a bare word is never taken for a folder). The scope notes the
folder (`@alice/bled-gpio.link`), and the app loads the plugin from it as it is, so a change is
there on its next run. Nothing is reviewed or verified, and anything that verifies plugins
refuses it, so run the app with plain node (`node --experimental-vfs --vfs-load <app>`) to use
it. `installed` reports it as linked, and as `changed` if the folder stops being that package.
`update` leaves it alone. Installing the plugin replaces the link, and linking replaces the
installed plugin. `uninstall` removes the link and never the folder.

**A suite installs every listing in it** (see [`suite`](#suite)). That is `@<account>/<name>`
where the account has a suite of that name and no listing of it; a domain whose TXT record is
`nsuite:<url>`; or a URL that serves a suite's JSON rather than an archive. Everyone the suite
expects its members to carry is shown once, and whom you accept counts for each member that
names them. Then each member is installed as it would be by itself, reviewed on its own. A
member that does not carry what the suite requires is refused, and one that is refused or
declined does not stop the others. A suite that an attester the policy blocks on has marked bad
is refused as a whole. `--dir` applies to its apps; `--name` and `--for` do not apply.

**A file is installed as it is**: `./tool.nzip`, an absolute path, `~/…` or a `file:` URL that
names a file rather than a folder. Nothing is fetched; it is reviewed exactly as a download
would be, and installs under its own name, or `--name`. For an install without the network, an
image build or a test. An update reads the file again; with `--source <url>`, the URL it stands
for, it fetches that instead, and its parts are found beside that URL. From code,
`install({ file | bytes, name, source })` does the same, and takes bytes too.

**An app can bring its parts.** When its `package.json` declares `bundle.parts` (see
[`parts`](#parts)), each part is fetched from its `url`, resolved against the URL the app was
fetched from, or its file, and only by the same means: an app from a server cannot name a file
on this machine. Then:

- **A part is trusted because the app is.** It must be the archive the app pins (its whole-file
  hash), hold together, and carry the package it is declared as. It needs no signature and no
  attestation of its own. The app's signature or attestations cover the pin, so whoever
  vouches for the app vouches for exactly these bytes. Only a bad verdict from someone the
  policy, or `--block`, blocks on refuses a part besides.
- **The policy is the app's.** The app is reviewed under the global rules and its `apps`
  section, as any app. A part is held to its pin instead; the `scopes` section for the app's
  package, which is about plugins someone else wrote, does not apply to it.
- **All of them, or nothing.** Every part is fetched and checked before anything moves; then
  the app and its parts are put in place together. A part that cannot be had, or is not what
  the app pins, refuses the app, and leaves everything as it was.
- **Each part is a plugin in the app's scope**, recorded as `<scope>:<package>` and as a part
  of the app. It is never installed, updated or uninstalled by itself: `update` and
  `uninstall` of the app take care of it, and installing a plugin of the same name for that
  scope is refused. An app with parts is installed once, under one name.

**`--system` installs for the machine.** Everything goes under one root: commands in `bin/`,
archives in `apps/`, plugins in `plugins/`, records and caches in `state/`, the sigstore trust
root in `cache/`. The root is `/var/lib/bundle` on Linux, `/Library/Application Support/bundle`
on macOS and `%ProgramData%\bundle` on Windows, beside the machine's policy file
(`BUNDLE_SYSTEM_ROOT` overrides it); `BUNDLE_ROOT=<dir>` puts the same layout anywhere else.
The policy files read are the same as always, the machine's and the user's. Nothing on a
desktop is touched. `update`, `installed`, `validate`, `uninstall` and `trust` take `--system`
too. A program loading plugins finds a scope the machine has when its user has none of its
own (see [`@pipobscure/bundle/plugins`](api.md#plugins-pipobscurebundleplugins)), so a service
running as a user of its own needs nothing set.

**With neither, it installs this package itself**, from its own GitHub release, accepting
the identity its [publish workflow](../.github/workflows/publish.yml) signs with. Where the
release is, bundle's own listing says, as any listed app's does: `@pipobscure.com/bundle`, which
the install then follows. When the listing cannot be asked, it says so in one line and fetches
the release URL instead. The listing only says where: the trust is with the release URL, so a
listing that named somewhere else would get a question, not a trusted install. Downloading
[`bundle.nzip`](https://github.com/pipobscure/bundles/releases/latest/download/bundle.nzip) and
running its `install` (`node --experimental-vfs --vfs-load ./bundle.nzip install`) is
therefore the whole bootstrap. It makes `nzip:` links open the installed bundle (see
[`links`](#links)), and then offers to set up the shell it is run from (see [`shell`](#shell)). Run it again once installed and it fetches
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
| `--for <app>` | install a plugin for this app: an installed name, the listing it was installed from (`@<handle or did>/<name>`, or an `at://` address), or its package name. A plugin's listing needs none |
| `-d, --dir <dir>` | install here (default: `~/.local/bin`, or `%LOCALAPPDATA%\bundle\bin`) |
| `--no-shell` | installing itself, do not offer to set up the shell |
| `--no-menu` | give the app no entry in the desktop's applications, though it asks for one, nor on its updates |
| `--window` | ask in a window rather than at the terminal; what an `nzip:` link opens |
| `--source <url>` | with a file: the URL it stands for, which updates fetch, and which its parts are found beside |
| `--system` | install for the machine, under one root (see above) |

### `update`

```
bundle update [options] [name]
bundle update            # everything installed, and every suite
bundle update tool       # one
bundle update devtools   # a suite, and its members
```

**Suites are asked first.** Each installed [suite](#suite) is fetched again from where it was
found: its repository, its URL, or its domain's `nsuite:` record. Members added are installed,
with the one question about whom to accept. Members taken out are removed if the suite brought
them and no other suite has them, and kept otherwise. A suite that cannot be asked, has been
taken down, or is now prohibited by an attester the policy blocks on is reported, and its members
are left as they are. Then every install is updated as below; naming a suite updates its members.

Asks each install's source where the archive is now: a domain's `nzip:` record, or the
listing it was installed from, fetched and verified again. If the source cannot be asked, or a
listing has been taken down, it says so and checks the URL it last named. bundle itself,
installed from its release URL, moves to following its listing from the first update that can
ask it, and says so once; until then it is checked as before. Then it refetches,
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

**An app's parts follow it.** After the app, its parts are brought in step with what its
`package.json` declares now: new ones added, changed ones replaced, those it no longer declares
removed. Each that changed is reported under the app, with its hash. They are all fetched and
checked first, and put in place with the app as one step, so if one cannot be had, or is not
what the app pins, nothing changes, the app included. A part whose file is not what was
installed is fetched again, even when the app itself is unchanged. Naming a part updates its
app. An app updates while it runs, on Windows too: what is running keeps the version it
started with until it is restarted. From code, `update()` returns a result for each part (`unchanged`, `updated` with the hash
before and after, `added`, `removed`), so a program can tell which of its services to restart.

| Option | |
|---|---|
| `-y, --yes` | accept everything found for a new version, rather than asking |
| `--identity <san>`, `--issuer <url>` | require this sigstore signer of every new version |
| `--attester <[kind@]who>`, `--quorum <n>` | require attestations of every new version |
| `--block <who>` | refuse a new version this DID or handle has marked bad; repeatable |
| `--no-discover` | do not ask the backlink index who has attested it |
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `--system` | the machine's installs (see [`install`](#install)) |

### `installed`

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

**A part is checked against its app**: its file is the one installed; the app still checks out
as above, and still declares it, pinned to exactly these bytes; the bytes hold together; and
nobody the policy blocks on has marked them bad. An app that is no longer vouched for makes its
parts `VALID (UNTRUSTED)` too.

| Option | |
|---|---|
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `--json` | print the results as JSON |
| `--system` | the machine's installs (see [`install`](#install)) |

### `validate`

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

It asks attester by attester, not install by install: what one attester said about every
install is fetched together, as [`trust`](#trust) fetches it, and each DID document once. For
an attester `trust` has caught up with, whose repository is still at that head, one request
answers for every install: the cache already holds all they have attested.

| Option | |
|---|---|
| `-q, --quiet` | say nothing unless something needs attention |
| `--every <time>` | leave alone any install validated more recently than this, without touching the network |
| `--timeout <time>` | one deadline for all of its network requests, after which the cache answers |
| `-r, --root <file>` | an extra trusted root certificate (PEM); repeatable |
| `--json` | print the results as JSON |
| `--system` | the machine's installs (see [`install`](#install)) |

| Exit | |
|---|---|
| 0 | nothing needs attention (new good attestations are reported, but are not a problem) |
| 1 | a new warning, or nobody accepted for an install vouches for it any more |
| 2 | an install is changed, missing or invalid, or someone the policy blocks on has marked it bad |
| 3 | an install is unsigned and nothing vouches for it |

Installs made before `validate` existed have no record of what they had seen, so the first
run reports all their current attestations as new, once.

### `uninstall`

```
bundle uninstall [--system] [name | url | domain | @did/name]
bundle uninstall tool                              # by name
bundle uninstall https://example.com/tool.nzip     # by where it came from
bundle uninstall tool.example.com                  # by the domain it was installed by
bundle uninstall @did:plc:…/bled                   # by the listing it was installed from
bundle uninstall devtools                          # a suite, and what it brought
bundle uninstall                                   # this package's own install
```

**A suite takes away what it brought, and nothing else.** An install that was there before the
suite, or that you have since installed by hand, stays, and so does one another suite also has.
An install a suite has, uninstalled by itself, is left out of that suite from then on, until it
is installed again.

Deletes the archive, and on macOS and Linux every link to it in its directory, and forgets
the record. With no argument it removes what `bundle install`
left behind, found by the URL it came from whatever it ended up called, and also takes the
shell setup out of every startup file it was added to. The `.nzip` association on Windows is
left alone: other archives may need it.

**An app's plugins go with it**, since nothing can load them any more. The exception is
another install of the same app (the same package, under another name), which loads the same
scope, so they stay for that one. A scope no app is installed as, such as a suite's shared one,
belongs to no single app, and is only emptied plugin by plugin. **Its parts always go with
it**, and a part is never uninstalled by itself.

| Option | |
|---|---|
| `--system` | the machine's installs (see [`install`](#install)) |

## Trust and policy

### `trust`

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
- **An attester whose repository has not moved is not asked again.** Each refresh remembers
  the head it caught up with: the latest commit, which changes whenever anything in the
  repository does. While the head is the same and the DID's key unchanged, the cached proofs
  are re-confirmed as they are, from one `getLatestCommit`, and nothing is listed or fetched.
- **New ones come together.** Each proof is the signed commit, the tree nodes on the path to
  the record, and the record. Rather than a request per record, the tree is walked toward all
  of them at once, one level per request (`com.atproto.sync.getBlocks`), so the request count
  depends on the tree's depth, not on how many attestations there are. Every proof assembled
  this way is checked exactly as one fetched alone. With only a few records, or a PDS that
  will not hand out blocks, they are fetched one at a time.

This is what a sealed executable or the preload checks attestations against, and how stale
that may be is the policy's `maxAge` (default seven days). Exit `1` if any refresh failed.

| Option | |
|---|---|
| `--mirror <url>` | the TUF repository to refresh from (default: sigstore's) |
| `--attester <who>` | also keep this DID's or handle's attestations; repeatable |
| `--no-sigstore` | refresh only the attestations |
| `--system` | the machine's trust root and cache (see [`install`](#install)) |

### `policy`

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
scope's section applies there too (see [Plugins](../README.md#plugins)).

Requirements from every file and section apply together, and trust adds up. Unknown settings
are an error, so a typo cannot quietly loosen anything. The policy governs `install`, `update`,
`installed` and `validate`.

**The format is described by a JSON Schema**, [`schemas/policy.schema.json`](../schemas/policy.schema.json),
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

## Setting up

### `node`

```
bundle node [--minimum <version>]
bundle node install [--minimum <version>] [--via <how>]
```

With no subcommand, says which node a bundle runs with here and where it came from. On macOS and
Linux that is the node the [launcher](#create) picks; on Windows, the one the `.nzip`
association names. It also lists the nodes bundle has downloaded itself. Exits 1 when there is
no node new enough.

`install` makes sure there is one, and does nothing when there already is. Otherwise:

1. It chooses a release from nodejs.org's index: the newest LTS at or above the minimum, else
   the newest release at or above it.
2. It asks a version manager that is here for exactly that release: mise, fnm, nvm or asdf (with
   its nodejs plugin); nvm-windows, fnm or mise on Windows. Volta and n are never asked, since
   installing through either changes the node your shell runs.
3. With no manager, or none that manages it, it downloads the official build, checks it against
   the release's `SHASUMS256.txt`, and keeps only the `node` binary, in bundle's own directory
   (see [Files and directories](#files-and-directories)). That node is a runtime for bundles,
   not a development setup: it comes without npm, and nothing is put on your PATH, so it never
   takes the place of a node you chose. The launcher and the Windows association look there.

The checksum file comes from the same place as the download, so it shows the download arrived
whole, not who made it. The release's OpenPGP signature is not checked, because node has no
OpenPGP implementation. As with every other way of installing node, TLS to nodejs.org is what
is trusted.

Bundles built before 0.1.6 carry a launcher that does not look in bundle's directory. On a
machine whose only node bundle downloaded, they say they found none.

| Option | |
|---|---|
| `--minimum <version>` | the oldest node that will do (default: `26.11.1`, what running a bundle needs) |
| `--via <how>` | `install` only: `auto`, `download`, or a manager by name: `mise`, `fnm`, `nvm`, `asdf`, `nvm-windows` (default: `auto`) |

### `shell`

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

### `links`

```
bundle links            # check, and put right whatever is missing or points elsewhere
bundle links --check    # only say; exit 1 when links do not open bundle
```

Checks that `nzip:` links open the installed bundle (see [`install`](#install) for what a link
is and what clicking one does). If they don't, it registers the handler again for the
current user, doing every step even where something looks right already, then checks again:

- **Linux:** the desktop entry, and `xdg-mime`'s default for `x-scheme-handler/nzip`, which
  another application may have taken.
- **macOS:** the applet in `~/Library/Application Support/bundle`. Which app Launch Services
  prefers can't be asked from a command, so the applet is registered again rather than checked.
- **Windows:** the `nzip` URL protocol and its script, and a node to run it with.

[`install`](#install) does all of this when bundle installs itself, so this command is for
repairs. It needs bundle installed, because the links open the installed copy.

| Option | |
|---|---|
| `--check` | only say whether they do; exit 1 when not |

### `skill`

```
bundle skill [options] [name]
bundle skill                 # -> .claude/skills/audit-bundle/SKILL.md
bundle skill --list
bundle skill --dir <dir> --force
```

Installs the [Claude Code](https://claude.com/claude-code) skills this package carries,
[`audit-bundle`](../skills/audit-bundle/SKILL.md) among them, into a project. It never overwrites
a file that is already there unless forced, so local edits survive.

| Option | |
|---|---|
| `-d, --dir <dir>` | where to install (default: `.claude/skills`) |
| `-f, --force` | overwrite files that are already there |
| `-l, --list` | list the skills this package carries, and stop |

## Files and directories

Each of these is the user's, except under a root of its own: with `--system` or
`BUNDLE_ROOT=<dir>`, programs are in `bin/`, archives in `apps/`, plugins in `plugins/`, the
state directory is `state/` and the sigstore trust root is in `cache/`, all under that root.
The policy files are where they always are.

| What | Where | |
|---|---|---|
| Installed programs | `~/.local/bin`; `%LOCALAPPDATA%\bundle\bin` on Windows | `BUNDLE_INSTALL_DIR`, or `--dir` |
| Installed archives | `$XDG_DATA_HOME/bundle/apps/<name>.nzip` (`~/.local/share/…`); `~/Library/Application Support/bundle/apps/` on macOS; on Windows, the programs themselves | `BUNDLE_APPS` |
| Install records | `installed.json` in the state directory | |
| Installed suites | `suites.json` in the state directory: which install came from which member, and what each suite brought | |
| Attestation cache | `attestations/` in the state directory: each attester's DID document, and their verified proofs | `BUNDLE_ATTESTATIONS` |
| App-password sessions | `sessions/` in the state directory: one per account, encrypted with its password, for five minutes — see [Signing in](#signing-in) | `BUNDLE_ATPROTO_SESSION_TTL` |
| Listing index | `listings.sqlite` in the state directory: a cache, rebuilt from the network whenever it is missing or out of date | |
| Downloaded nodes | `$XDG_DATA_HOME/bundle/node/<version>/bin/node` (`~/.local/share/…`); `~/Library/Application Support/bundle/node/` on macOS; `%LOCALAPPDATA%\bundle\node\<version>\node.exe` on Windows — see [`node`](#node) | `BUNDLE_NODE_DIR` |
| Plugins | `$XDG_DATA_HOME/bundle/plugins/<scope>/` (`~/.local/share/…`); `~/Library/Application Support/bundle/plugins/<scope>/` on macOS; `%LOCALAPPDATA%\bundle\plugins\<scope>\` on Windows. An app's parts are plugins in its scope | `BUNDLE_PLUGINS` |
| The machine's root | `/var/lib/bundle`; `/Library/Application Support/bundle` on macOS; `%ProgramData%\bundle` on Windows — see [`install`](#install) | `BUNDLE_SYSTEM_ROOT` |
| The state directory | `$XDG_STATE_HOME/bundle` (`~/.local/state/bundle`); `~/Library/Application Support/bundle` on macOS; `%LOCALAPPDATA%\bundle\Data` on Windows | |
| Policy | see [`policy`](#policy) | `BUNDLE_POLICY`, `BUNDLE_SYSTEM_POLICY` |
| Sigstore trust root | `$XDG_DATA_HOME/sigstore-js` (`~/.local/share/sigstore-js`); `~/Library/Application Support/sigstore-js` on macOS; `%LOCALAPPDATA%\sigstore-js\Data` on Windows | `BUNDLE_SIGSTORE_ROOT`, `--sigstore-root` |
| Shell setup | `~/.bashrc`, `${ZDOTDIR:-~}/.zshrc`, `~/.config/fish/config.fish`, PowerShell's `$PROFILE`, only with your yes | `BUNDLE_SHELL`, `BUNDLE_POWERSHELL_PROFILE` |
| `.nzip` association | `HKCU\Software\Classes` and the user's `PATHEXT`, on Windows | `BUNDLE_NO_DESKTOP_SETUP` |
| Applications entries | `$XDG_DATA_HOME/applications/bundle-<name>.desktop` and `$XDG_DATA_HOME/bundle/icons/` on Linux; `~/Applications/<title>.app` on macOS; the Start menu's `Programs`, `%LOCALAPPDATA%\bundle\apps\` and `%LOCALAPPDATA%\bundle\icons\` on Windows — see [`install`](#install) | `--no-menu`, `BUNDLE_NO_DESKTOP_SETUP` |
| `nzip:` link handler | `$XDG_DATA_HOME/applications/bundle-nzip-links.desktop` and `xdg-mime`'s default on Linux; `~/Library/Application Support/bundle/NodeBundleLinks.app` on macOS; `HKCU\Software\Classes\nzip` and `%LOCALAPPDATA%\bundle\links.ps1` on Windows — see [`install`](#install) | `BUNDLE_NO_DESKTOP_SETUP` |
| `.nzip` icon | `%LOCALAPPDATA%\bundle\icons` on Windows; `$XDG_DATA_HOME/mime` and `$XDG_DATA_HOME/icons/hicolor` (`~/.local/share`) on Linux; `~/Library/Application Support/bundle/NodeBundle.app` on macOS | `BUNDLE_NO_DESKTOP_SETUP` |

The sigstore certificate's key and OAuth sessions are never stored. An app-password session
is, for a few minutes (`sessions/` in the state directory, above), encrypted with the password.

## Signing in

Every command that writes to an atproto account — `attest`, `publish`, `unpublish`, `suite
publish`, `suite unpublish`, `suite attest`, `lexicon publish` — signs in the same way: OAuth
in the browser, asking for the one collection it writes, revoked when the command is done; or,
with `BUNDLE_ATPROTO_PASSWORD` or `--password-file`, an app password.

An app-password session is kept for five minutes, so that a script running these one after
another signs in once: `createSession` is among the most tightly rate-limited calls a PDS has.
It is one file per account in `sessions/` in the state directory, readable only by you, and
encrypted (AES-GCM) with a key derived (scrypt) from the app password. The file is worth nothing
without the password, and with the password anyone could sign in anyway, so keeping it gives
nothing away; a changed or revoked password stops it working by itself. A session the PDS turns
down before then is dropped and signed in for again, once. `BUNDLE_ATPROTO_SESSION_TTL` sets
how long (`90s`, `10m`, never past the token's own expiry); `0` keeps none. OAuth sessions are
never kept: they are bound to a key that only ever exists in memory.

## Environment

| Variable | |
|---|---|
| `BUNDLE_INSTALL_DIR` | where `install` puts programs |
| `BUNDLE_APPS` | where `install` keeps the archives those programs link to, on macOS and Linux |
| `BUNDLE_PLUGINS` | where plugin scopes are, for `install --for` and the plugin loader alike |
| `BUNDLE_ROOT` | put everything under this one directory: `bin/`, `apps/`, `plugins/`, `state/`, `cache/` (see [Files and directories](#files-and-directories)) |
| `BUNDLE_SYSTEM_ROOT` | the machine's root, which `--system` puts everything under, and where the plugin loader finds a scope the user has none of |
| `BUNDLE_NODE_DIR` | where `node install` keeps the nodes it downloads, and where the launcher and the Windows association look for them |
| `BUNDLE_NODE_MIRROR` | where `node install` downloads node from, instead of `https://nodejs.org/dist` |
| `BUNDLE_SEA_THREAD` | set by an executable's main thread for its workers: what it verified and mounted. Not something to set yourself |
| `BUNDLE_SELF_SOURCE` | where `bundle install` (with no argument) fetches this package from: a mirror. Its publish workflow's identity is still the one accepted. A mirror has no listing, so the listing is not asked |
| `BUNDLE_SELF_LISTING` | the `at://` address of the listing `bundle install` (with no argument) asks, instead of bundle's own. It only says where: the trust stays with the release URL. For tests |
| `BUNDLE_NO_DESKTOP_SETUP` | do not register `.nzip` or its icon with the desktop, or touch `PATHEXT` on Windows. `BUNDLE_NO_WINDOWS_SETUP`, its old name, still works |
| `BUNDLE_POLICY` / `BUNDLE_SYSTEM_POLICY` | the user's and the machine's policy file |
| `BUNDLE_ATTESTATIONS` | the attestation cache directory |
| `BUNDLE_SIGSTORE_ROOT` | the sigstore trust root to check against, instead of the cache |
| `BUNDLE_EDITOR` | the editor `like` opens its post in, before `VISUAL` and `EDITOR`; run through the shell, so it may carry arguments, like `code --wait` |
| `BUNDLE_SHELL` | the shell `install` sets up and `shell` prints for, instead of detecting it |
| `BUNDLE_POWERSHELL_PROFILE` | the PowerShell profile `install` adds its setup to, instead of asking PowerShell |
| `BUNDLE_ATPROTO_IDENTIFIER` | the account `attest`, `publish`, `unpublish` and `lexicon publish` act as, without `--as` |
| `BUNDLE_ATPROTO_PASSWORD` | an app password: every command that writes to an account uses it instead of signing in, for CI |
| `BUNDLE_ATPROTO_SESSION_TTL` | how long an app-password session is kept for the next command (default `5m`; `0` keeps none) — see [Signing in](#signing-in) |
| `BUNDLE_OAUTH_CLIENT_ID` | a hosted OAuth client metadata URL, instead of the loopback development client |
| `SOURCE_DATE_EPOCH` | the latest time `create` dates a member with, in seconds: for reproducible builds from a fresh checkout |
| `BUNDLE_RATE_LIMIT_WAIT` | the longest a rate-limited request waits before asking again, in seconds (default: 600). `0` never waits |
| `BUNDLE_PLC_DIRECTORY` | the PLC directory `did:plc` is resolved against (default: `https://plc.directory`) |
| `BUNDLE_NO_BROWSER` | never open a browser: to sign in with sigstore, a device code instead; for `install --window`, only the URL is printed |
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
