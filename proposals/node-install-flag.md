# `node --install <id>`: getting a package manager without shipping one

**Status:** draft, for discussion
**Author:** Philipp Dunkel
**Target:** Node.js core

## Summary

Add a startup flag that installs a package manager by name:

```console
$ node --install pnpm
pnpm 10.4.1 installed
  from    https://registry.example/pnpm/10.4.1/pnpm.nzip
  signed  https://github.com/pnpm/pnpm/.github/workflows/release.yml@refs/heads/main
          via https://token.actions.githubusercontent.com
  aliases pnpm, pnpx

$ pnpm install
```

One signed archive is downloaded, verified against the identity the entry names,
placed next to node, and given one link per command name it declares. Nothing is
extracted, no install script runs, and what gets executed afterwards is the file
that was verified.

The set of installable things is a list shipped with node:

```json
{
  "id": "pnpm",
  "source": "https://registry.example/pnpm/10.4.1/pnpm.nzip",
  "signer": "https://github.com/pnpm/pnpm/.github/workflows/release.yml@refs/heads/main",
  "binaries": ["pnpm", "pnpx"]
}
```

## Motivation

Node 26.10.0 ships `npm` and `npx` in its tarball and no corepack. That is a
defensible place to be, and it has two costs.

**It privileges one package manager by being the one in the box.** Every other
one is installed by a mechanism node has no opinion about: `npm i -g`, which
bootstraps a competitor through the incumbent; `curl … | sh`, which is a
supply-chain hazard the ecosystem keeps teaching people to accept; or an OS
package manager, which is not available everywhere and lags.

**It ties node's release cadence to npm's.** A security fix in the bundled
package manager is a node release, and the bundled copy is in every node
container image whether or not it is used.

The interesting option is not "bundle more" or "bundle less". It is to make
*acquiring* a package manager a first-class, verifiable operation that treats
every candidate the same — including the one node ships today.

## What makes this tractable now

Three pieces landed in node 26 that did not exist when corepack was designed:

- **`node:vfs`** (v26.4) and **ZIP support in `node:zlib`** (v26.8): an archive
  can be mounted and resolved from directly.
- **`--vfs-load`** (v26.10): a file can *be* a program. `node --vfs-load=app.zip`
  mounts it and runs its entry point, resolving every `require`/`import` inside
  it. `argv[1]` is the source path, so the file can read its own bytes.
- **Native addons from a mount** (v26.9) and `node:ffi`: the program inside the
  archive does not have to be JavaScript. A shared library loads straight out of
  a mount.

So "a package manager" can be exactly one file, and running it needs no
unpacking step, no `node_modules`, and no install-time code execution.

## The artifact

An installable entry points at a **single signed archive**: a ZIP whose
whole-file hash is signed, carrying a certificate chain as a member and the
signature in the end-of-central-directory comment, optionally behind a launcher
prefix. That shape is what [`@pipobscure/bundle`](https://github.com/pipobscure/bundles)
builds, and it has the properties this proposal needs:

- **It is a closed set.** Nothing resolves later and nothing is fetched at
  install time, so what you audited is what runs.
- **The signature covers everything**, including native code. One flipped byte
  anywhere makes the archive invalid.
- **It stays a valid ZIP.** `unzip -l` lists it; nothing proprietary is needed
  to look inside.
- **It has no install step to compromise**, because there is no install step:
  no lifecycle scripts, no postinstall.

Node needs to *verify* one of these, not to build one. Building is a userland
concern and should stay one.

## The list

A JSON document, shipped in the node tarball and updated with node releases:

```json
{
  "version": 1,
  "packageManagers": [
    {
      "id": "npm",
      "source": "https://registry.npmjs.org/…/npm-11.19.1.nzip",
      "signer": "https://github.com/npm/cli/.github/workflows/release.yml@refs/heads/main",
      "issuer": "https://token.actions.githubusercontent.com",
      "binaries": ["npm", "npx"],
      "version": "11.19.1",
      "sha256": "40336531528fbbadf2dc34b634718a327d50b2dd…"
    }
  ]
}
```

`id`, `source`, `signer` and `binaries` are the fields this proposal turns on.
Three more are worth having:

- **`issuer`** — a sigstore identity is only meaningful together with the OIDC
  issuer that vouched for it. `foo@example.com` signed via a provider anyone can
  register an account with is not the same claim as the same string from a
  pinned issuer.
- **`version`** — so `--install pnpm` can say what it installed, and so a
  mismatch between the list and the archive is detectable.
- **`sha256`** (optional) — pinning the exact bytes the node release was cut
  against. Belt and braces over the signature: it makes an install reproducible
  and makes a compromised-but-correctly-signed replacement visible.

**Who may be on the list** is a policy question for the TSC, not a technical
one, and it should be answered before the flag exists rather than after.
Something like: a package manager with a public release pipeline, signatures
from an identity tied to that pipeline, and a maintainer willing to keep the
entry current. The list is a curation surface and will be treated as an
endorsement whatever the docs say.

## Behaviour

```
node --install <id>            install the entry named <id>
node --install                 list what is installable, and what is installed
node --install <id>@<version>  install a specific version, if the list carries several
node --uninstall <id>          remove the archive and its links
```

Install does, in order:

1. **Resolve** `<id>` in the list. An unknown id fails with the available ids.
2. **Fetch** `source` over HTTPS into a temporary file. No redirect to a
   different origin without saying so.
3. **Verify**: the whole-file signature, the certificate chain, the signing
   identity against `signer`/`issuer`, and `sha256` if present. Any failure and
   the temporary file is deleted and nothing else happens.
4. **Place** the archive next to node's other tooling — the same directory npm
   lives in today — as `<id>.nzip`, atomically (write, fsync, rename).
5. **Link** one alias per `binaries` entry into node's `bin` directory.
6. **Report** what was installed, from where, and who signed it.

Nothing about step 3 is novel except where the code lives. Node already carries
X.509 verification in `node:crypto`; what it does not carry is a sigstore
verifier, which is the open question in *Trust*, below.

## Aliases, and why `binaries` is a list

The archive is started by `--vfs-load`, and `argv[1]` is the path it was invoked
as — **not** the resolved target of a link. So one archive can answer to several
names and dispatch on its own:

```js
switch (basename(process.argv[1], '.nzip')) {
    case 'pnpm': …
    case 'pnpx': …
}
```

That is how `npm`/`npx` can be one file rather than two, and it is already true
of node 26.10: verified through relative symlinks, absolute symlinks, links in
another directory, links found on `PATH`, and hard links.

**Unix:** a symlink per name into node's `bin` directory, pointing at the
archive. The archive carries the two-line `#!/bin/sh` prefix, so the links are
directly executable.

**Windows:** symlinks need Developer Mode or elevation, so **hard links**
(`mklink /H`, no rights required, same volume) are the right mechanism. Two ways
to make the target runnable, and the installer should pick one:

- **A `.cmd` prefix** on the archive — the batch equivalent of the shebang, with
  a Ctrl-Z before the ZIP. Works with nothing but the file, but relies on
  cmd.exe stopping at the batch code, which Microsoft does not document.
- **A file association**, which the node *installer* registers once:
  `assoc .nzip=NodeBundle` plus
  `ftype NodeBundle="…\node.exe" --experimental-vfs --vfs-load="%1" -- %~2`
  and `.NZIP` appended to `PATHEXT`. Then `pnpm` runs `pnpm.nzip`.

The association route is the better fit for this proposal: it makes **one
artifact work on every platform** — Unix uses the `#!` prefix and ignores the
extension, Windows uses the extension and ignores the prefix. Same bytes, same
digest, same signature everywhere, which is also what makes a `sha256` in the
list meaningful across platforms. Its cost is that it is machine setup, which is
precisely what a node installer is for.

## Trust

**What the signature proves** is provenance: these bytes came from the identity
the list names. It proves nothing about what the code does. The proposal should
say so in the docs rather than implying that a verified package manager is a
safe one.

**Where verification happens.** At install, necessarily. Optionally *also* at
every run, by mounting through a verifying provider rather than the plain ZIP
one — that is where this design gets its real value, because it turns "I checked
it once" into "it cannot have changed since". Node does not need to do that: the
provider registry (`vfs.registerProvider()`, v26.10) makes it a userland preload.
But `--install` could set it up, and that decision is worth making deliberately.

**What node would have to carry.** Two options, and they are not equal:

- **Sigstore verification in core.** Matches how the ecosystem actually signs
  things (npm provenance, GitHub Actions identities), and needs a TUF client and
  a trust root that must be refreshed. That is a real dependency surface for a
  runtime.
- **A key pinned per entry.** The list carries a public key; the archive is
  signed with it; `node:crypto` verifies. Much smaller, and much worse for
  rotation and for the "who is this" question — a key is not an identity.

A middle road: verify an X.509 chain with `node:crypto` against a root pinned in
the list entry, and treat sigstore as the way publishers *obtain* those
certificates rather than as something node speaks. Worth spelling out before
implementation.

**Revocation and downgrade.** The list is only as fresh as the node release that
carries it. An entry compromised after a release cannot be pulled without a new
node, and a user can install an old node to get an old entry. Mitigations worth
discussing: an optional online freshness check that fails *open* with a warning,
a minimum-version field per entry, and a documented process for pulling an entry
in a patch release.

**Environments without the network** — CI images, air-gapped builds, corporate
proxies. `--install` must be overridable: a `NODE_INSTALL_SOURCE`-style variable
or a `--install-from <file|url>` argument that still verifies against the same
`signer`. An install that cannot be mirrored will be worked around, and the
workaround will be `curl | sh`.

## It does not have to be JavaScript

A package manager written in Rust, Go or C++ fits this design unchanged: the
archive carries a shared library, and the entry point hands it `argc`/`argv`
through `node:ffi`, which loads it straight out of the mount. This is built and
working — see
[`examples/native-cli`](https://github.com/pipobscure/bundles/tree/main/examples/native-cli),
a 165 KB signed archive whose program is Rust, dispatching on `argv[0]` and
returning its own exit code.

That matters for the framing. `--install` is not "node ships alternative npms";
it is "node knows how to obtain and verify a tool, and is agnostic about what
that tool is written in".

## Prior art

- **Corepack** solved a neighbouring problem — pinning a project's package
  manager via `packageManager` in `package.json` — and shipped shims that
  downloaded from npm at first use. It is no longer in the distribution. Two
  lessons worth carrying: being in the tarball is not the same as being adopted,
  and downloading from the registry at *first use* puts a network dependency in
  everyone's critical path. `--install` is explicit and up-front instead.
- **`ensurepip`** (Python) is the closest analogue: the runtime carries the
  means to obtain the package manager rather than the package manager.
- **rustup**, **Deno** and **Bun** all install signed single files and link them
  into a bin directory; none of them ask the incumbent package manager to
  bootstrap a competitor.

## Open questions

1. **Who curates the list, under what criteria, and how does an entry get
   removed in a hurry?**
2. **Sigstore in core, or pinned X.509 per entry?** This decides the size of the
   change more than anything else here.
3. **Does `--install` also install the verifying mount**, so the archive is
   re-checked at every run, or is that left to userland?
4. **Where do the links go** when node is installed system-wide but run by an
   unprivileged user? Per-user install directory, or fail with a clear message?
5. **Does npm stay in the tarball** during a transition, and for how long? The
   flag is more interesting if `npm` is an entry in the list like any other.
6. **What does `--install` do when the alias name is already taken** by
   something else on `PATH`?

## What this asks for

Not agreement on the whole design — agreement that "obtain and verify a package
manager" is a thing node should know how to do, and that a signed, mountable,
single-file archive is the right shape for it. The mechanism exists in the
runtime already; what is missing is a flag, a list, and a verification step.
