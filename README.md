# bundles

A tool — **`bundle`** — for **bundling and distributing Node.js applications as single,
signed files**, and the experiment that produced it. It does five things:

- **`@pipobscure/bundle/record`** — a provider you preload with `-r` that writes down every
  file a run actually reads, so the list of what to archive comes from observation rather
  than guesswork. It is the userland replacement for the `--vfs-manifest` flag.
- **`bundle create`** — archive that list of files, optionally behind a prefix (a `#!`
  launcher, or a Node binary).
- **`bundle sign`** — sign an archive into a new file, through **sigstore** (a GitHub OIDC
  sign-in, or an ambient CI identity) or against a certificate authority of your own.
- **`bundle verify`** — validate an archive and report its trust state and signing identity.
- **`@pipobscure/bundle/register`** — a **`node:vfs` provider** you preload with `-r` (or
  `--import`), so `node --vfs-load --vfs-mount app.bundle` mounts and runs an application
  *only* if it is properly signed, and checks each member against its recorded digest as
  that member is read.

Signing is a step of its own rather than part of building, and that is what makes one build
serve every target. `create` produces an unsigned archive; `sign` re-emits it behind
whatever prefix you name and signs the finished bytes. So a single `app.bundle` becomes a
`#!` launcher, a self-contained executable and a plain mountable archive — each correctly
offset, each signed over itself.

There is also a **[Claude Code skill](skills/audit-bundle/SKILL.md)**
(`/audit-bundle`) that verifies an archive, extracts it, and security-reviews every file
in it. A signature says who produced the bytes; it says nothing about whether they are
safe. Because a bundle is a closed set — nothing resolves later, nothing is fetched at
install — a review over one can actually be complete.

The result is an application in one file that the runtime itself refuses to run when it
has been tampered with — either as a plain `.bundle` archive, as a small self-executing ZIP
that runs on any installed Node, or as a fully self-contained native executable that needs
no Node at all.

It is driven by a modified Node.js, in three additions on top of Node's existing
experimental **virtual file system** (`node:vfs`, by Matteo Collina):

1. **ZIP archive support in `node:zlib`** plus a **`ZipProvider`** that mounts such an
   archive through VFS as a file tree — proposed upstream as
   [nodejs/node#64339](https://github.com/nodejs/node/pull/64339).
2. A **`--vfs-mount` / `--vfs-load` module loader** that mounts directories and archives
   and resolves a program's entry point and all its `require()`/`import` against them —
   prepared as a follow-on in [pipobscure/node#3](https://github.com/pipobscure/node/pull/3).
3. **`vfs.registerProvider()`**, the extension point that lets a preloaded module
   decide which provider backs a mount — which is what makes a *verifying* mount, or a
   *recording* one, possible from userland at all.

Together they let the root a program runs from be a plain `.zip` embedded inside the
program's own file. Combined with Node's newer **Single Executable Application (SEA)**
tooling, this turns "an application plus its files" into "one file you can `chmod +x` and
run."

---

## Why this exists

Shipping a Node application to someone else is still awkward. The options today are all
compromises:

- **A directory of files + `npm install`.** The user needs the right Node, a working
  toolchain, and network access; `node_modules` is enormous and platform-specific for
  anything with native addons.
- **A bundler (esbuild/webpack/ncc).** Collapses JS into one file, but assets, addons,
  and anything that does `fs.readFile(__dirname + ...)` still leak out. You are shipping
  a JS blob, not an application.
- **`pkg` / SEA.** Produce a real executable, but historically SEA only took a **single
  CommonJS script**, code caching and asset handling were fiddly, and building one meant
  bolting a WASM copy of `postject` onto the side of your build to inject a blob into the
  binary.

The thing all of these dance around is that a real application is a *file tree*: an entry
point, sibling modules, a `package.json`, templates, static assets, maybe a native addon.
Node's module resolution and every `fs` call assume that tree lives on the real disk. If
you want to ship the tree *inside* a single file, you need Node to be able to treat
something-that-isn't-a-directory as the directory it resolves against.

That is exactly what the fork provides.

---

## What changed in node

Three layers matter here, and it's worth being precise about who wrote what and where each
one lives:

- **The `node:vfs` subsystem is pre-existing.** It was written and merged (as an
  experimental builtin) by **Matteo Collina** — not part of this work. It's summarized
  below only because it's the foundation everything else stands on.
- **The novel work is two additions to Node:**
  - **ZIP archive support in `node:zlib`** and the **`ZipProvider`** that mounts an archive
    through VFS — proposed upstream as
    [nodejs/node#64339](https://github.com/nodejs/node/pull/64339).
  - The **`--vfs-mount` / `--vfs-load` module loader** that makes a mounted tree the thing a
    program actually resolves and runs from, and the provider registry that decides what
    backs a mount — prepared as a follow-on in
    [pipobscure/node#3](https://github.com/pipobscure/node/pull/3).
- **The SEA group** is recent upstream Node functionality the experiment leans on, carried
  along so the whole pipeline works from one binary.

### 0. Foundation (pre-existing): `node:vfs` — a virtual file system with pluggable providers

*By Matteo Collina; here for context, not part of this fork's contribution.* An experimental
builtin (`--experimental-vfs` to enable) exposing a `node:fs`-shaped API backed by a
swappable **provider**:

- **`MemoryProvider`** — an in-memory tree (the default); supports symlinks and watching,
  and can be frozen read-only.
- **`RealFSProvider`** — wraps a real directory and maps every VFS path under it,
  rejecting paths (and symlinks) that resolve outside the root. It gives a subtree *path
  containment* it wouldn't otherwise have.

The full synchronous / callback / promise surfaces of `fs` are mirrored, and `Stats`
objects are real `fs.Stats`. Crucially, the docs are explicit that **VFS is not a sandbox** —
it redirects supported `fs` calls whose resolved path falls under a mount; it is not a
security boundary. That honesty matters for how it's positioned below.

### 1. ZIP support in `node:zlib` *([nodejs/node#64339](https://github.com/nodejs/node/pull/64339))*

`node:zlib` gains a small archive toolkit:

- **`ZipEntry`** — one immutable archive member (name, metadata, content), created from a
  buffer or stream, or read back from raw bytes.
- **`ZipFile`** — a ZIP on disk, opened read-only by default (`{ writable: true }` to
  mutate), with get/add/delete/stream-by-name and `compact()` to reclaim deleted space.
- **`ZipBuffer`** — the fully in-memory equivalent, serializable back to a `Buffer`.
- **`createZipArchive()` / `...Sync()`** — build a fresh archive from a list of entries,
  returned as a `Readable` you can pipe straight to a file or socket.

Two details make the whole single-file trick possible:

- **`baseOffset`** — an archive records internal offsets; seeding them with a base offset
  lets the archive stay valid even when it is **not at byte 0 of its file** — e.g. when
  it's appended *after* a shebang line or after an entire Node binary.
- Read paths enforce content-size limits and reject malformed records (zip-bomb / corrupt
  input guards), with dedicated `ERR_ZIP_*` codes.

### 2. `ZipProvider` — a VFS provider backed by a ZIP archive *([nodejs/node#64339](https://github.com/nodejs/node/pull/64339))*

The bridge between the two: a provider for Matteo's `node:vfs` that exposes the entries of
a `ZipFile` (on disk) or `ZipBuffer` (in memory) as a browsable, read/write file tree.
Directories are recognized both explicitly and implicitly; a file opened for write commits
as a new archive entry when its handle is closed. This is what lets a `.zip` be *mounted*
and treated like a directory.

### 3. `--vfs-mount` / `--vfs-load` startup flags — the keystone *([pipobscure/node#3](https://github.com/pipobscure/node/pull/3))*

This is what wires VFS into Node's *startup and module resolution* so a mounted tree
becomes the thing the program actually runs from. Mounting and running are two separate
flags, so a program can be given several mounts and still have one entry point:

- **`--vfs-mount <source>[=<target>]`** mounts `<source>` at `<target>`, defaulting to
  `<source>`'s own resolved path. Repeatable.
  - A **directory** source is mounted with `RealFSProvider`.
  - A **file** source is opened as a read-only ZIP (`ZipFile`) and mounted with
    `ZipProvider` — turning that one file into a virtual directory.
- **`--vfs-load`** runs the entry point out of the **last** `--vfs-mount`, resolving it
  *and all subsequent `require()` / `import`* against the mount instead of the real
  filesystem. `argv[1]` is then *unconditionally that mount point*, exactly as if you had
  run `node <mountPoint>`. The mount's own `package.json` `"main"` decides what runs; a
  positional argument is the program's own argument (shifted to `argv[2]+`), never an
  entry-point override.
- That rule is precisely what makes a **self-mounting shebang** work:
  `#!/usr/bin/env -S node --vfs-load --vfs-mount`. The kernel appends the script's own path
  as the value of the trailing `--vfs-mount`, so the script mounts *itself* and runs its
  embedded `package.json` main.
- To make this real, four module-resolution primitives (package.json reading,
  nearest-scope lookup, legacy main resolution, extensionless format sniffing) were
  changed to stop calling native bindings directly and instead go through a VFS-aware path
  — deferring unchanged to the real bindings whenever no mount is active, so non-mounted
  behavior is identical.
- **Native addons** work: directory mounts `dlopen` the real file; archive mounts extract
  the addon to a per-pid, content-hashed temp file first (there is no real file to point
  at). **Worker threads** inherit the active mount, so sandboxed code can't spawn an
  "escaped" worker.

Recording the path of *every file actually read through a mount* — by module resolution or
by the program's own `fs` calls — used to be a third flag, `--vfs-manifest`, implemented as
an observer hook inside `node:vfs`. It is now a **provider** instead, in this repo: see
[Recording the manifest](#recording-the-manifest). Either way it gives you a **dependency
manifest by observation**: run the app once, and you get the exact minimal set of files it
touches — the correct contents for the archive you're about to build.

### 4. `vfs.registerProvider()` — choosing what backs a mount

A mount source is not hard-wired to the built-in provider for its kind. `node:vfs` exposes
a small registry:

```js
vfs.registerProvider({ name, canHandle(resolvedPath, stats), create(resolvedPath, stats) });
```

Registered providers are consulted **before** the built-ins — the `RealFSProvider` for a
directory and the `ZipProvider` for an archive are themselves just the last two entries —
newest first, and selection happens *after* preload modules have run. That is the whole
point: a preloaded module can install a provider for the source about to be mounted.

```sh
node --experimental-vfs -r @pipobscure/bundle/register --vfs-load --vfs-mount app.bundle
```

`canHandle` receives the `statSync()` of the source, so a provider can claim archives, or
directories, or both — and because the built-ins are last, it can *wrap* either one rather
than only adding new formats.

Because a registered provider outranks the built-in one even for a file the built-in would
happily handle, it can also **vet** a file rather than merely add a format. That is exactly
what this repo does with `.bundle`: the provider claims the file, verifies it, and either
returns a filesystem or throws — and a throw during provider selection means the process
never reaches the entry point.

Two consequences worth stating plainly:

- **Either preload flag works, because mounting waits for both.** `-r` modules run during
  bootstrap; `--import` modules are only evaluated later, on the way into the entry point.
  Mounting is therefore deferred past *both* — when `--import` is present the mounts are
  made from `asyncRunEntryPointWithESMLoader`, and idempotently, so a registration from
  either flag is in place before any provider is chosen.
- **Claim by content, not just by name.** The built-in provider recognizes a ZIP by
  sniffing its leading bytes, so an archive can be called anything. A verifying provider
  that only claimed `*.bundle` could be bypassed by renaming the file, which is why the one
  here also claims anything carrying a `SIGNED:` marker.

### SEA support carried along

The fork also carries Node's newer SEA work so a single binary can build a SEA end-to-end:
`--build-sea <config.json>` generates a SEA directly from core (using LIEF instead of a
bolted-on WASM `postject`), plus **ESM entry-point support** in SEA (`"mainFormat"`) and
code-cache support for it. That's why `npm run sea` below is a single `node` invocation.

---

## The experiment in this repo

This repo is a minimal application (`lib/`) and a set of npm scripts that demonstrate three
end-to-end packaging pipelines built on the fork.

### The "application"

The bundled app is itself the tool that builds and checks these archives — it is at once
the **bundler**, the **verifier**, and an importable **library**:

```
lib/
  package.json   { "type":"module", "main":"app.js", "bin": { "bundle":"./app.js" },
                   "exports": { ".", "./manifest", "./archive", "./provider",
                                 "./register", "./recorder", "./record" } }
  app.js         parseArgs CLI with `create` / `verify` / `run`; re-exports the library
  archive.js     createArchive() / bundle() — streams files, then signs the whole file
  manifest.js    buildManifest() / parseManifest() / verifySync() — signing + verification core
  provider.js    BundleProvider + register() — the verifying node:vfs file provider
  register.cjs   the `-r` preload: registers that provider and nothing else
  recorder.js    recording() + Manifest — a provider that writes down what it reads
  record.cjs     the `-r` preload for manifest recording
```

Packaging the verifier *as* one of these archives is the point: the same artifact that
carries an application can validate its own integrity, and `sea.js` reuses that same logic
to refuse to boot a tampered container (see [Signing and verification](#signing-and-verification)).

### The pieces

| File | Role |
|------|------|
| `lib/app.js` | The application. A `parseArgs` CLI (`create` / `sign` / `verify` / `run` / `trust`); also the SEA and mounted entry point and the package's library root. |
| `lib/archive.js` | Bundler: optionally writes a **prefix** (shebang stub or Node/SEA binary), then appends a ZIP of the listed files — each stamped with its content digest — with a `baseOffset` equal to the prefix size and an `AUTHORITY.PEM` manifest, then signs the whole file into the EOCD comment. `bundle()` builds from a directory; `rebundle()` re-emits an existing archive behind a new prefix, which is what `sign` runs. |
| `lib/manifest.js` | The signing/verification core: `buildManifest(…)`, `parseManifest(…)`, `signatureOf(…)`, `parseSignature(…)`/`formatSignature(…)` and `verifySync(source)`. |
| `lib/sigstore.js` | Sigstore as one of the signers the format can carry: a two-phase signer (get the Fulcio certificate, *then* sign the finished hash), synchronous bundle verification, and the trust root. |
| `lib/oidc.js` | Getting an OIDC identity token — an ambient CI token, a browser sign-in through sigstore's Dex, or a device code. No dependencies of its own. |
| `lib/provider.js` | The verifying VFS provider: verifies an archive before it becomes a filesystem, then hashes each member as it is fetched. `register()` installs it with `node:vfs`. |
| `lib/register.cjs` | The `-r` preload entry point — one call to `register()`, configured through the environment. |
| `lib/recorder.js` | The recording provider: wraps a provider class so every read through it is appended to a manifest. Replaces the `--vfs-manifest` flag. |
| `lib/record.cjs` | The `-r` preload for recording — set `BUNDLE_MANIFEST` and mount a directory. |
| `test/bundle.test.js` | End-to-end tests: sign, verify, mount, run, and every way that should be refused. |
| `test/sign.test.js` | Tests for signing as its own step: one archive re-emitted behind several prefixes, the marker grammar, and a forged sigstore field. |
| `test/record.test.js` | Tests for the recording provider: what gets recorded, once, and what doesn't. |
| `sea.js` | The SEA program. **Verifies itself** (`process.argv[0]`, whole-file signature inlined from `manifest.js`), and only then opens it as a `ZipFile`, mounts it via `ZipProvider` at `/APP`, and `require`s the app. |
| `sea.json` | SEA build config: ESM-capable, runs with `--experimental-vfs`, outputs `node-base`. |
| `shell-base` | The shebang prefix: `#!/usr/bin/env -S node --no-warnings --experimental-vfs --vfs-load --vfs-mount`. |
| `app.manifest` | The observed file list (from the recording provider) that says what goes into the archive, plus the four files nothing imports at build time (`provider.js`, `register.cjs`, `recorder.js`, `record.cjs`). |
| `certs/` | A self-signed test PKI (root CA + leaf, `gen.sh`) used to sign and trust the demo archives offline. |
| `skills/audit-bundle/` | The audit skill: verify → extract → security-review every file. |

### The scripts (`package.json`)

```jsonc
"sea":      "node --no-warnings --build-sea sea.json",
// Build a self-contained SEA Node binary (`node-base`) whose entry is sea.js.

"manifest": "BUNDLE_MANIFEST=app.manifest node ... -r ./lib/record.cjs --vfs-load --vfs-mount lib/ help > /dev/null && printf 'provider.js\nregister.cjs\nrecorder.js\nrecord.cjs\n' >> app.manifest",
// Run the app with lib/ mounted behind the recording provider, writing every file it
// actually reads to app.manifest. This *discovers* the archive's contents by observation
// instead of static analysis — then adds the four files a run can't observe: the two
// providers are never imported by the CLI (they need node:vfs, which only exists under
// --experimental-vfs) and the two preloads are loaded by `node -r`, not by the app.

"create":   "node --no-warnings lib/app.js create --base lib/ --files app.manifest --output app.bundle",
// No prefix, no signature. Result: app.bundle — the unsigned archive every shipped
// shape is signed from. This is the one build.

"sign":     "node ... lib/app.js sign --key certs/leaf.key --chain certs/chain.pem --output app.signed.bundle app.bundle",
// No prefix. Result: app.signed.bundle — a signed archive, run with `--vfs-mount` + the provider.

"archive":  "node ... lib/app.js sign --key ... --chain ... --prefix shell-base --output app.run app.bundle",
// Prefix = shell-base (shebang). Result: app.run — a tiny self-executing ZIP app, signed.

"executable":"node ... lib/app.js sign --key ... --chain ... --prefix node-base --output app.sea app.bundle",
// Prefix = node-base (the SEA binary). Result: app.sea — a standalone executable, signed.

"sigstore": "node --no-warnings lib/app.js sign --prefix shell-base --output app.run app.bundle",
// The same, signed through sigstore instead: no --key, so it takes the identity from CI
// when there is one and otherwise opens a GitHub sign-in.

"trust":    "node --no-warnings lib/app.js trust",
// Refresh the sigstore trust root (over TUF) into the local cache. Verification never
// reaches for the network, so this is the explicit step that feeds it.

"verify":   "node --no-warnings lib/app.js verify --root certs/root.pem",
// Verify an archive against the test root, e.g. `npm run verify -- app.run`.

"build":    "npm run manifest && npm run create && npm run sign && npm run archive",
// The whole offline pipeline: observe -> archive -> sign -> sign again with a prefix.

"start":    "BUNDLE_ROOTS=certs/root.pem node ... -r ./lib/register.cjs --vfs-load --vfs-mount app.signed.bundle",
// Mount the signed archive through the verifying provider and run it, trusting the test root.

"test":     "node --no-warnings --experimental-vfs --test test/*.test.js"
```

Note the shape of the pipeline: **`create` once, `sign` many times.** `create` never needs a
key, and the archive it writes is the single input to every signed artifact. Drop `--root`
from `verify` to see how the same archive reads when its certificate isn't trusted; drop
`--prefix` from `sign` to produce a plain archive instead of a self-executing container.

`create` still accepts `--key`/`--chain` to sign at build time, which is convenient when you
only ever want one shape. It cannot be used with sigstore: a Fulcio certificate is bound to
an identity you have to authenticate for, so that path goes through `sign`.

### The three artifacts, and how each runs itself

All three are produced by `sign`, from the same `app.bundle`, differing only in the
`--prefix` they are re-emitted behind.

**`app.signed.bundle` — the plain signed archive (~37 KB; needs Node and the preload).**
No prefix at all: just the ZIP of `lib/`, with its per-member digests, its `AUTHORITY.PEM`
manifest and the whole-file signature in the EOCD comment. It is run by mounting it:

```sh
node --experimental-vfs -r ./lib/register.cjs --vfs-load --vfs-mount app.signed.bundle <args>
```

The preload registers the provider; `--vfs-mount` hands it the archive; the provider verifies the
signature and the chain **before** returning a filesystem, so an archive that fails is never
mounted and the entry point never runs. This is the mode where the *runtime* enforces the
signature rather than the application checking itself — the application needs no boot code
of its own at all.

**`app.run` — the shebang archive (the same ZIP plus a one-line header; needs Node installed).**
It is literally the `shell-base` shebang line followed by the ZIP of `lib/`. When executed,
the kernel runs `env node --vfs-load --vfs-mount` and appends the file's own path, which
becomes that trailing flag's value — so it mounts **`app.run` itself** as a read-only ZIP,
whose `package.json` main (`app.js`) becomes the entry point. The archive's `baseOffset`
was seeded to skip the
shebang bytes, so it stays a valid ZIP even though it doesn't start at byte 0. A whole
application in a file you can email — provided the recipient has a compatible Node.

> **Note:** this needs a Node whose provider selection recognizes a ZIP by locating its
> end-of-central-directory record rather than by sniffing `PK\x03\x04` at byte 0 — a
> prefixed container by construction has no `PK` at byte 0, and the leading-bytes test
> rejected it with `ERR_VFS_INVALID_TARGET` before anything else happened. The bundle
> provider never had that blind spot (it always scanned from the tail), so
> `node -r ./lib/register.cjs --vfs-load --vfs-mount app.run` mounts and verifies the same
> file either way.

**`app.sea` — the native executable (~155 MB; needs nothing).**
It is the SEA `node-base` binary followed by the same ZIP. Running it starts `sea.js`,
which opens `process.argv[0]` — the running executable — as a `ZipFile`, **verifies the
appended archive**, and only if it is fully valid and trusted mounts it at `/APP` and
requires the app out of it. No Node on the target, no `node_modules`, no extraction to disk
of the JS. The size is just "a Node runtime + your files," which is the honest floor for
*zero-dependency* distribution.

Because `sea.js` self-verifies before it will run, `./app.sea` **refuses to boot** unless the
embedded certificate chain is trusted. The demo signs with a self-signed test cert, so point
Node at the test root to trust it: `NODE_EXTRA_CA_CERTS=certs/root.pem ./app.sea`.

Same application, same archive format, three shapes — one where the **runtime** enforces
the signature (`.bundle`), one optimizing for **size** (reuse the user's Node), one for
**self-containment** (bring your own Node). And, because the prefix is chosen at *signing*
time rather than at build time, all three come from one `create` and differ by one flag.

### Try it

```sh
npm run manifest     # observe which files the app reads  -> app.manifest
npm run create       # archive them, unsigned             -> ./app.bundle
npm run verify -- app.bundle                     # -> UNSIGNED

npm run sign         # sign it, no prefix                 -> ./app.signed.bundle
npm run verify -- app.signed.bundle              # -> VALID
npm start -- help                                # mount through the provider and run it
node --no-warnings lib/app.js run --root certs/root.pem app.signed.bundle -- help   # the same, via the CLI
node --experimental-vfs -r ./lib/register.cjs --vfs-load --vfs-mount app.signed.bundle help  # refuses: untrusted

npm run archive      # sign the SAME app.bundle behind a shebang -> ./app.run
./app.run help       # mounts itself via the shebang (no gate of its own)
node --no-warnings --experimental-vfs -r ./lib/register.cjs --vfs-load --vfs-mount app.run help  # verified
./app.run verify --root certs/root.pem app.signed.bundle   # verify some other archive -> VALID

npm run sea          # build the SEA base binary          -> ./node-base
npm run executable   # sign the same app.bundle behind it -> ./app.sea
NODE_EXTRA_CA_CERTS=certs/root.pem ./app.sea verify app.run   # self-checks, then runs
./app.sea            # refuses: certificate not trusted (no NODE_EXTRA_CA_CERTS)

npm test             # sign / verify / mount / run, and everything that must be refused
```

Or the whole offline pipeline in one go: `npm run build`.

To sign through sigstore instead of the test PKI — this opens a browser:

```sh
npm run trust                                    # fetch the sigstore trust root, once
npm run sigstore                                 # sign app.bundle via a GitHub sign-in -> ./app.run
npm run verify -- app.run                        # -> VALID, with the identity that signed it
```

The app is a verifier, so it needs an archive to check. Note the shebang launcher
(`app.run`) cannot verify **itself** by its own path — the mount covers that path, so it resolves to the archive's *interior*, not the raw bytes; verify any other
archive, or use the SEA, which mounts at `/APP` and *can* self-verify.

---

## Signing and verification

A single-file application is only as trustworthy as the bytes inside it. Building on the ZIP
toolkit, every archive this repo produces is protected by a **staged** scheme: one hash covers
the **whole file** (prefix included), the leaf certificate signs *that hash*, and both are
written into the archive's end-of-central-directory comment. Each **member** additionally
carries its own content digest. The staging is the point — a verifier can prove the bytes are
intact *before* it commits to anything (a cheap, cert-free gate), and only then spend a
certificate check. This is an application-level feature — it uses `node:zlib`'s
`ZipEntry`/`X509Certificate` primitives; it is not a change to Node.

### The `AUTHORITY.PEM` manifest

**The `AUTHORITY.PEM` manifest** is a normal archive entry that declares the algorithms and
carries the certificate chain — the signing authority. Its name is a real, extractable
filename, so a plain zip utility can pull it out for auditing:

```
!manifest 2                        magic + format version
!hash sha256                       digest used for the whole-file hash and member digests
!sign sha256                       digest the signature (over that hash) uses
                                   (blank line — present only when signed)
-----BEGIN CERTIFICATE-----        full PEM chain, leaf first, embedded so a
…                                  verifier is self-contained
-----END CERTIFICATE-----
```

**Every member** (every entry except the manifest) also records the hex digest of its own
content in its ZIP **entry comment**, computed with `!hash`.

### The whole-file hash, and a signature over it

One hash covers the *entire file* — the prepended launcher or Node/SEA binary, every member,
the complete central directory (member digests included) and the fixed part of the EOCD
record — up to but **excluding the EOCD's 2-byte comment-length field**. The EOCD must be the
last structure in the file, so the hashed region is simply everything before its trailing
comment. The leaf certificate then signs **that hash** (not the file), and the EOCD comment —
which the hash deliberately stops short of — records both:

```
SIGNED:<hash-of-region-hex>:<signature-hex>[:<NAME>=<value>]*
```

Signing the hash rather than the file is what makes the stages cheap: a verifier hashes the
file once, matches it against `<hash>`, and can then check `<signature>` over that same hash
without touching the file again. Because the hash spans the whole file, nothing — a byte of
the runtime prefix, a member's bytes, a recorded digest in the central directory, the
algorithm lines, or the embedded chain — can be altered without changing it. The per-member
digests are that guarantee applied one file at a time, so an individual extracted member can
be checked on its own (and a member fetch can re-verify it).

The trailing `NAME=value` fields are the **unsigned-attribute region** every code-signing
scheme eventually grows. Anything obtained *after* the signature exists cannot be inside
what the signature covers, so it goes beside it instead — the same placement RFC 3161 gives
timestamp tokens in CMS `unsignedAttrs`, and Authenticode gives counter-signatures. Today
the only field is `SIGSTORE=`, carrying the transparency-log entry and timestamp that
establish *when* the archive was signed. Fields are optional and unknown ones are ignored,
so a two-field marker written before the grammar existed still parses.

### Signing with sigstore

`bundle sign` defaults to sigstore, which replaces "a signing key on someone's disk" with
"an identity you authenticate as". [Fulcio](https://github.com/sigstore/fulcio) issues a
certificate binding an OIDC identity to a keypair that exists only for the duration of the
command; there is no long-lived key to steal, because the certificate expires in about ten
minutes.

Where the identity comes from is a property of where the command runs, so it is not a flag
you have to remember:

| Where | What happens | The identity |
|---|---|---|
| GitHub Actions | `ACTIONS_ID_TOKEN_REQUEST_URL` is read directly (needs `permissions: id-token: write`) | the repository and workflow — `https://github.com/OWNER/REPO/.github/workflows/release.yml@refs/heads/main` |
| A workstation | a browser opens on sigstore's Dex, which redirects straight to GitHub | your email |
| A headless box | a device code to enter elsewhere | your email |

Override with `--flow ci\|browser\|device`, `--token <jwt>` to supply one yourself, or
`--connector google\|microsoft\|none` to sign in as something other than GitHub.

**The ordering problem.** `AUTHORITY.PEM` is a member, so it is inside the hashed region:
the certificate chain must be known *before* the hash exists. The signature must be made
*after*. Sigstore's own `BundleBuilder` does both in one call, which cannot work here — but
it does not have to, because a Fulcio certificate binds an *identity to a public key* and
says nothing about any message. So the two halves separate cleanly, and `lib/sigstore.js`
exposes them as a two-phase signer: sign in and get the certificate, then, once the archive
has been built around it and hashed, sign the hash and have that signature witnessed by
Rekor and the timestamp authority.

**Why the witnesses matter more here than usual.** A ten-minute certificate makes "is this
chain in date *now*?" the wrong question — it fails every archive older than lunchtime. The
right question is whether the certificate was valid *when the signature was made*, and
answering it needs a trustworthy assertion of when that was. That is exactly what the
transparency-log entry and the RFC 3161 token in the `SIGSTORE=` field provide, and it is
why a sigstore signature takes a different trust path from an ordinary one rather than an
additional check on the same path. `bundle sign` refuses to finish if neither witness could
be reached, because the result could never be verified again.

Two things are checked that the sigstore libraries do not check for you. The bundle must be
over *this* archive's hash — otherwise a valid bundle could be transplanted from another
archive — and the certificate it was verified against must be the same one `AUTHORITY.PEM`
names. Without the second, an attacker could pin a genuine bundle for their own identity to
an archive whose extractable manifest claims a different signer: the signature would check
out and the inspectable file would be a lie.

Verification never reaches for the network. The sigstore trust root is fetched by an
explicit `bundle trust` (over TUF — signed metadata with its own root of trust, not a plain
download) and cached; `verifySync()` then loads it synchronously, which it has to, because
the mount path decides whether to serve an archive before any of the program in it runs.

### The four verification states

`verify()` runs the stages in order and reports exactly one state:

| State | Meaning |
|-------|---------|
| **unsigned** | no `AUTHORITY.PEM` manifest, or no `SIGNED:…` marker in the EOCD comment |
| **invalid** | the recomputed hash doesn't match the recorded one, the signature doesn't verify over it, **or** a member's recorded digest doesn't match its content |
| **valid-untrusted** | hash + signature + digests are sound, but the certificate chain isn't anchored in the trust store — or, for a sigstore signature, the trust root is missing or the identity didn't match a required policy |
| **valid** | all of the above sound **and** the chain is trusted |

Note which side of the line the sigstore cases fall on. Not being *able* to check — no trust
root cached, the libraries absent — is `valid-untrusted`, not `invalid`: "I could not check"
and "this is forged" are different answers and conflating them is how people are trained to
click through warnings. A bundle that is present and fails to verify is `invalid`.

`verifySync()` is the implementation and `verify()` an `async` wrapper around it; both take
`{ extraRoots, now, deep, trustedRoot, identity, issuer }`. `identity` and `issuer` impose a
policy on a sigstore signature — "it must be *this* signer" — and a mismatch reports
`valid-untrusted`, since the signature is genuine and simply not the one demanded. `now` is
ignored on the sigstore path, which derives the signing time from the archive's own log
entry instead. With `deep: false` the member digests are checked for
*presence* but not recomputed — the right trade for a mount, which re-checks each member as
it is actually read (see below). The result also carries `hashAlg` and the `digests` map
read from the archive that was just hashed, so a caller that goes on to serve those members
checks them against what the signature covered rather than re-reading the comments later.

For a sigstore signature the result also carries `identity`, `issuer` and `signedAt`. Those
are the answer to "who signed this"; the certificate subject is an ephemeral Fulcio artifact
and says nothing useful, so `bundle verify` prints the identity instead when there is one.

The whole scheme is gated on the `SIGNED:` marker: only a signed archive is checked at all.
Because the hash covers the central directory, it fixes *which* members exist and every
member's digest, so editing *any* byte after signing yields **invalid**. Trust is evaluated
against the system CA store **plus** `NODE_EXTRA_CA_CERTS` (and any extra roots passed to
`verify`), so the trusted path is testable without touching the OS store.

### The library

`lib/` doubles as an importable package (the intended reuse point for the loader):

```js
import { buildManifest, verifySync } from '@pipobscure/bundle/manifest';
import { bundle, rebundle, keySigner } from '@pipobscure/bundle/archive';

// build the AUTHORITY.PEM manifest content (algorithms + chain); the whole-file
// signature is applied by bundle()/rebundle(), not here
const content = buildManifest({ hashAlg: 'sha256', signAlg: 'sha256', chain });

// verify an archive path or a Buffer of the whole file
const { state, reason, identity } = verifySync('app.run', { extraRoots });

// build unsigned, then sign into as many shapes as you ship
await bundle({ base: 'lib/', files, out: createWriteStream('app.bundle') });
await rebundle({
    source: 'app.bundle',
    prefix: 'shell-base',
    signer: keySigner({ key, chain }),
    out: createWriteStream('app.run'),
});
```

A **signer** is just `{ chain, signAlg, sign(digest) }`: the chain goes into `AUTHORITY.PEM`
before hashing, and `sign()` is called after, with the finished hash, returning a signature
and any unsigned-attribute fields. `keySigner()` is the offline-CA implementation and
`@pipobscure/bundle/sigstore`'s `signer()` is the other one — `rebundle()` knows about
neither, which is the point. Writing a third (an HSM, a KMS, a corporate signing service) is
a matter of implementing those three properties.

`./provider` and `./recorder` are deliberately *not* re-exported from the package root:
importing them needs `node:vfs`, which only exists under `--experimental-vfs`, while
creating and verifying archives does not. `./sigstore` is not re-exported either, but for a
different reason: it is the only part of the package with npm dependencies, and an archive
signed against an ordinary CA verifies with nothing but `node:crypto`. Its absence degrades
a sigstore verification to `valid-untrusted` rather than breaking it.

### Running only what is signed — the `.bundle` provider

`lib/provider.js` is where verification stops being something an application does to itself
and becomes a property of the mount. It is a `ZipProvider` subclass, registered ahead of the
built-in one, and it gates in two places:

**At mount.** `open()` recomputes the whole-file hash, checks the signature over it against
the leaf certificate in `AUTHORITY.PEM`, and anchors the chain in the trust store. Anything
short of `valid` throws `ERR_BUNDLE_UNTRUSTED` out of provider selection, which is *before*
the entry point is resolved — an archive that fails does not become a filesystem, so there
is no window in which its code could run.

**At fetch.** Every member is hashed as it is read and compared with the digest recorded for
it, and only then handed over; a mismatch throws `ERR_BUNDLE_INTEGRITY` instead of returning
content. The mount-time hash already covers every member's bytes — but it covers them *as
they were when the file was hashed*, and a `ZipFile` reads members lazily from an open file
descriptor. Rewriting the archive underneath a running program would otherwise serve the new
bytes unchecked. Verified content is kept in memory (members are an application's own files,
not the runtime), so each member is read and hashed at most once, and what later reads see is
the copy that was verified rather than a fresh read of the file.

A mounted archive is read-only regardless of how the underlying ZIP was opened: any write
would invalidate the signature the mount was granted on, so writes fail with `EROFS`.

Configure the preload through the environment, since `-r` takes no arguments:

| Variable | Effect |
|----------|--------|
| `BUNDLE_ROOTS` | Extra trusted roots, a path-delimiter-separated list of PEM files. |
| `BUNDLE_ALLOW_UNTRUSTED` | Accept a good signature whose chain is not anchored in the trust store. |

For anything more, call `register()` yourself from a preload of your own:

```js
// my-preload.cjs — node --experimental-vfs -r ./my-preload.cjs --vfs-load --vfs-mount app.bundle
require('@pipobscure/bundle/provider').register({
  extensions: ['.bundle', '.bundle'],  // claimed by name
  claimSigned: true,                 // and anything carrying a SIGNED: marker
  roots: ['/etc/ssl/my-root.pem'],   // PEM text or paths to PEM files
  allowUntrusted: false,
  deep: false,                       // recompute every digest at mount, not on fetch
});
```

`bundle run <archive> [-- <args>]` is the same thing with the flags filled in: it re-execs
`node` with the preload and `--vfs-mount`, so what runs is what the child's own bootstrap
verified.

### Self-verifying the SEA

`sea.js` is a single CommonJS file that runs *before* the archive is mounted, so it cannot
`import` the library — the verification logic is copied into it, and it makes the staging
concrete:

1. **precheck** — hash `process.argv[0]` (itself, prefix and all) and match it to the recorded
   hash. This is cert-free and runs **before mounting**; a tampered container is refused here.
2. **mount** — only a hash-intact container is mounted via `ZipProvider` at `/APP`.
3. **authenticate** — verify the signature over that hash against the chain in `AUTHORITY.PEM`
   and anchor it in the trust store.
4. **run** — `require` the app only once the container is `valid` *and* trusted.

An unsigned, tampered, or untrusted container exits non-zero without ever running. That
split is the same one `lib/provider.js` now makes for VFS mounts — with the per-member
digest checks folded into member fetches, which a SEA cannot reuse: the provider lives
inside the very archive `sea.js` has to vet before it can mount anything.

The shebang launcher, by contrast, has no pre-mount stage of its own, so `app.run`
executed directly does not self-verify — it hands straight off to the app. Mounting it with the
provider preloaded (`node -r ./lib/register.cjs --vfs-load --vfs-mount app.run`) is what
closes that gap, and is the one route by which `app.run` runs verified at all.

---

## Recording the manifest

Building an archive needs a file list, and the honest way to get one is to run the
application and write down what it read. That used to be `--vfs-manifest=<file>`, a flag
that poked an observer slot inside `node:vfs`. With mounting reduced to `--vfs-mount` and
provider selection the one place a mount can be influenced, the same job is better done by
a **provider** — which is what `lib/recorder.js` is:

```sh
BUNDLE_MANIFEST=app.manifest node --experimental-vfs \
    -r @pipobscure/bundle/record --vfs-load --vfs-mount ./lib
```

`recording(Base, manifest)` wraps a provider *class*, leaving its constructor signature
alone, and records every read that passes through it; `register()` installs
`recording(RealFSProvider)` for directory mounts. Paths are appended, VFS-relative and one
per line, **as they are read** rather than buffered until exit, so a killed process still
leaves a usable list — and worker threads, which inherit `execArgv` and so run this preload
too, append to the same file instead of truncating it (only the main thread starts a fresh
one; `O_APPEND` writes don't interleave).

It is a superset of what the flag recorded, in one respect. The flag hooked
`readFile()`/`readFileSync()`, where the module loader and ordinary `fs` reads converge —
but a `createReadStream()` goes through `open()` and a handle, and was never recorded. Here
read-only `open()`s count too: a file that was opened but never read is harmless in a
bundle, a streamed file missing from one is not.

Because it wraps a *class*, it composes — this records what a signed archive's own code
touches at run time:

```js
// my-preload.cjs
const { BundleProvider } = require('@pipobscure/bundle/provider');
const { recording, Manifest } = require('@pipobscure/bundle/recorder');
const Recording = recording(BundleProvider, new Manifest('reads.txt'));
```

One thing it does not do: it records per *mount*, not per process, so several
`--vfs-mount` directories merge into one list. The flag only ever supported a single
directory target, so this is new ground rather than a regression.

---

## Auditing a bundle

A signature answers *who produced these bytes*. It does not answer *are these bytes safe*.
Those are different questions, and the second one is the one the recent supply-chain
attacks actually exploited: every significant npm compromise of recent years shipped a
correctly published, correctly signed package from a legitimately compromised account.
Provenance would have confirmed it came from the real maintainer, and been useless.

What makes the second question tractable here is that a bundle is a **closed set**. Nothing
resolves later, nothing is fetched at install, no lifecycle script pulls in more code.
Unlike a review of a dependency tree, a review over a bundle can be complete.

`skills/audit-bundle/` is a [Claude Code](https://claude.com/claude-code) skill that
does it in three phases:

1. **Verify** — run `bundle verify --json` and report the state and signing identity. This
   phase gates the rest and is not skippable: it stops on `invalid`, and continues with a
   prominent warning on `unsigned` or `valid-untrusted`, since reviewing an archive you
   cannot place is precisely the useful case. An audit that silently reviewed a tampered
   archive would be worse than no audit.
2. **Extract** — `unzip` to a scratch directory. It is a real ZIP, so this needs no special
   tooling, and the extracted file list is reconciled against the signed member list.
3. **Review** — read every file, hunting what those attacks did: install and load-time
   hooks, obfuscated or encoded payloads, outbound network calls from modules with no
   reason to make them, environment and credential reads, CI token and cloud metadata
   endpoints, `child_process`/`eval`/dynamic `require`, and members nothing references.

```
/audit-bundle app.run
```

Claude Code discovers skills under `.claude/skills/`, which is ignored here (it is also
where local settings live), so the skill itself is kept at the top level and linked into
place. After cloning:

```sh
mkdir -p .claude/skills && ln -s ../../skills/audit-bundle .claude/skills/audit-bundle
```

It also has a diff mode: verify and extract two archives, review only what changed against a
previously approved one, and call out any member added or removed. That is the realistic
repeat-use case, and considerably more valuable than a fresh full review each time.

Steps 1 and 2 are the existing CLI; only step 3 is new. That split is deliberate — the
policy layer is a library and a skill you can replace, not something the runtime does.

### Where this ends up: the tool as a bundle of itself

Not built yet, and the point of everything above. `bundle` should not be installed from
npm — it should arrive the way it tells everyone else to ship: **one signed file**,
verified by a copy of `bundle` you already have, and auditable as a closed set before you
run it. Version *N* verifies version *N+1*, with the identity to pin being the release
workflow rather than a person:

```sh
bundle verify --identity 'https://github.com/pipobscure/bundles/.github/workflows/release.yml@refs/heads/main' \
              --issuer   'https://token.actions.githubusercontent.com' \
              bundle.bundle
```

This is also why you will not find a `package-lock.json` here. A lock file pins the bytes
of a dependency tree that is still fetched and executed at install time; a signed bundle
removes that step rather than pinning it. There is no install, no lifecycle script, and
nothing that resolves later — so "the same bytes" means literally the same bytes, and
`/audit-bundle` can read all of them. The lock file remains useful for contributors
reproducing a build, which is a different and orthogonal question.

The honest caveat is the first copy: it has to be trusted some other way, and that is
trust-on-first-use however it is dressed up. The mitigation is that it is TOFU over an
artifact you can read completely.

See [`docs/design-notes.md` §3](docs/design-notes.md) for the chain of custody, the
bootstrapping problem, and the one real obstacle — the sigstore dependencies have to
become members of the bundle, which is uncomfortable, correct, and exactly the
transparency being argued for.

---

## Why these changes to Node make sense

The through-line is: **let a single file be the file tree a program runs from.**

- **Distribution wants one artifact, but applications are trees.** ZIP is the obvious
  container for a tree, and `baseOffset` is the one small primitive that lets a ZIP live
  *inside* another file — after a shebang, after a binary — without ceasing to be a valid
  ZIP. That is what makes "append and go" possible instead of "carve out a section and
  inject with a separate tool."
- **Resolution has to believe the tree.** Bundlers fail at the edges because they rewrite
  *some* module loading but the rest of Node — legacy main resolution, `package.json`
  lookup, extension sniffing, and every user `fs.readFile` — still points at the real disk.
  Routing those primitives through a VFS-aware layer (that is a no-op when nothing is
  mounted) means the *whole* runtime, not just the bundler's slice, agrees on where files
  are. Assets and addons come along for free.
- **The self-mounting shebang is the elegant payoff.** Because the kernel appends the
  invoked script's own path to a trailing `--vfs-mount`, so the script mounts *itself*,
  a plain executable ZIP with a one-line header behaves
  like an installed program — no launcher, no wrapper, no unpacking. It's the Python
  zipapp / self-extracting-jar idea, but resolved natively by the runtime rather than
  bootstrapped by user code.
- **The manifest closes the "what do I even ship?" problem.** Static dependency analysis is
  perennially wrong for dynamic `require`, data files, and conditional imports.
  A recording provider answers it empirically: *these are the files this run touched.*
  Combined with the mount, build-time discovery and run-time resolution use the same
  mechanism — and once selection is an extension point, discovery doesn't need to be a
  flag in the runtime at all.
- **SEA is another delivery mode, not a different world.** By carrying `--build-sea`,
  ESM SEA entry points, and their code cache, the *same* archive that powers `app.run` also
  powers `app.sea`. You choose "small, needs Node" vs. "large, needs nothing" per target
  without changing how you package.
- **A pluggable provider registry turns "can mount an archive" into "can refuse to."**
  Selection happening after `-r` preloads, and registered providers outranking the built-in
  one, are what let a policy — verify this signature, or don't mount at all — sit *below*
  the entry point instead of in it. An application cannot forget to call its own checker if
  the checker is what produced its filesystem.

### Honest limitations

- **VFS is not a sandbox.** It redirects `fs`; it does not confine untrusted code. Real
  isolation still needs OS-level mechanisms. The fork's own docs say so.
- **A verified mount is an integrity gate, not a confinement.** It proves the code is the
  code that was signed, by someone whose chain you trust. Once that code runs it has the
  full authority of the process — the guarantee is about *provenance*, not privilege.
- **The gate is only as strong as how the runtime was launched.** Anyone who can change the
  command line can drop the `-r`, and `--vfs-mount` will mount the archive with the built-in
  provider, which verifies nothing. Registration is a userland opt-in, not a runtime policy.
- **Native SEAs are large** because they include a full Node. That's inherent to
  zero-dependency native distribution, not a flaw in the approach.
- **Signing proves provenance, and provenance is not safety.** Every significant npm
  compromise of recent years shipped a correctly signed package from a legitimately
  compromised account. A signature would have confirmed it came from the real maintainer
  and been useless. That is what the audit skill is for, and why it is a separate step.
- **A sigstore signature is only as private as the transparency log.** Signing puts your
  identity, the archive's hash and the time in a public append-only log. That is the
  mechanism working — it is what makes the ten-minute certificate verifiable later — but it
  is not something to discover after the fact.
- **Everything here is experimental** — a personal fork, `--experimental-vfs`, `REPLACEME`
  version markers. It's a proof of concept for a distribution model, not a supported
  product.

---

## Layout

```
bundles/
  lib/            the tool: bundler + signer + verifier + VFS providers + importable library
    app.js          parseArgs CLI (create / sign / verify / run / trust); SEA + mount entry; library root
    archive.js      bundle() builds unsigned from a directory; rebundle() re-emits behind a new
                    prefix and signs; keySigner() is the offline-CA signer
    manifest.js     buildManifest() / parseManifest() / verifySync(): signing + verification core
    sigstore.js     the sigstore signer (two-phase) and synchronous bundle verification
    oidc.js         identity tokens: ambient CI, browser sign-in, or device code
    provider.js     BundleProvider + register(): verify at mount, hash every member at fetch
    register.cjs    the `-r` preload; configured via BUNDLE_ROOTS / BUNDLE_ALLOW_UNTRUSTED
    recorder.js     recording() + Manifest: the userland replacement for --vfs-manifest
    record.cjs      the `-r` preload for recording; configured via BUNDLE_MANIFEST
    package.json    { type:module, main:app.js, bin:bundle, exports: { ".", "./manifest",
                      "./archive", "./provider", "./register", "./recorder", "./record",
                      "./sigstore", "./oidc" } }
  test/           bundle.test.js (mount / run), sign.test.js (signing), record.test.js (`npm test`)
  skills/audit-bundle/
                  the audit skill: verify -> extract -> security-review every file.
                  symlinked into .claude/skills/ (ignored) so Claude Code picks it up
  sea.js          SEA bootstrap: verify self (whole-file signature), then mount and require the app
  sea.json        --build-sea configuration
  shell-base      shebang prefix for the portable archive
  certs/          self-signed test PKI (root CA + leaf) and gen.sh
  app.manifest    observed file list (produced by `npm run manifest`)
  app.bundle      built: the UNSIGNED archive every signed shape is produced from
  app.signed.bundle  built: signed archive, mounted and verified by the provider
  app.run         built: self-executing ZIP app (needs Node)
  app.sea         built: standalone executable (needs nothing)
  package.json    the manifest / create / sign / archive / executable / sigstore / trust /
                  verify / build / start / test scripts
```

Build outputs (`app.manifest`, `app.bundle`, `app.signed.bundle`, `app.run`, `app.sea`,
`node-base`) are generated by the scripts above.

**Environment variables**

| | |
|---|---|
| `BUNDLE_MANIFEST` | where the recording provider writes the observed file list |
| `BUNDLE_ROOTS` | extra trusted roots for verification, path-delimiter separated |
| `BUNDLE_ALLOW_UNTRUSTED` | mount an archive whose signature is good but untrusted |
| `BUNDLE_IDENTITY` / `BUNDLE_ISSUER` | require a particular sigstore signer at mount time |
| `BUNDLE_SIGSTORE_ROOT` | path to the sigstore trust root, instead of the cache |
| `BUNDLE_NO_BROWSER` | never try to open a browser; use the device flow |
