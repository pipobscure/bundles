# bundles — the argument

> **This is the long-form document: why this project exists, what it is arguing about
> Node.js packaging and software supply chains, and how the design got to where it is.**
> It was the README for most of the project's life and is kept as the reasoning, which is
> worth more than the diff.
>
> For **using** the tool — install, commands, API, the four steps of building a bundle —
> see [README.md](README.md). Design decisions written down before they were built, and
> what departed from the plan, are the [implementation notes](#implementation-notes) at
> the end of this document.
>
> Paths and script names here are current as of writing; where the repository has since
> moved things, the commands have been updated but the narrative has not been rewritten.

---

A tool — **`bundle`** — for **bundling and distributing Node.js applications as single,
signed files**, and the experiment that produced it. It is one TypeScript package, published
as ESM, with four things in it:

- **`@pipobscure/bundle/record`** — a `node:vfs` provider you preload with `-r` that writes
  down every file a run actually reads, so the list of what to archive comes from
  observation rather than guesswork. It is the userland replacement for the
  `--vfs-manifest` flag.
- **`@pipobscure/bundle/register`** — a **verifying `node:vfs` provider** you preload with
  `-r` (or `--import`), so `node --vfs-load --vfs-mount app.bundle` mounts and runs an
  application *only* if it is properly signed, and checks each member against its recorded
  digest as that member is read.
- **`@pipobscure/bundle`** — the same operations as an API: `createBundle`, `signBundle`,
  `verifyBundle`, `inspectBundle`, `runBundle`. The CLI is a `parseArgs` wrapper over these
  and nothing else, so an embedder can do everything the command line can.
- **`bundle`**, the CLI — `create`, `sign`, `verify`, `run`, `sea`, `trust`, `skill`.

Plus **`@pipobscure/bundle/sea`**, which puts the verifying mount inside a single executable:
a Node runtime, this package as a mounted asset in its own SEA blob, and the application
appended as a signed archive — so the finished binary checks its own signature before
running anything, with the checker inside what is checked.

Signing is a step of its own rather than part of building, and that is what makes one build
serve every target. `create` produces an unsigned archive; `sign` re-emits it behind
whatever prefix you name and signs the finished bytes. So a single `app.bundle` becomes a
`#!` launcher, a self-contained executable and a plain mountable archive — each correctly
offset, each signed over itself.

That split is also what makes room for the step in the middle. Building a bundle goes:

```
1. observe   run the application, and write down every file it actually reads
2. create    archive exactly that list, unsigned
3. audit     review it — against the last release, if there is one
4. sign      only if step 3 came back clean
```

A signature is a claim about bytes you stand behind, so the review belongs *before* it,
not after. Step 3 is the [`audit-bundle` skill](skills/audit-bundle/SKILL.md), and it is
the same review whoever receives the bundle should run before trusting it — which is the
point: hold your own artifact to the standard you would hold someone else's.

A signature says who produced the bytes; it says nothing about whether they are safe.
Because a bundle is a closed set — nothing resolves later, nothing is fetched at install,
no lifecycle script pulls in more code — a review over one can actually be complete, which
is what makes step 3 worth doing at all.

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
code-cache support for it. That is why `bundle sea` is a single `node --build-sea` call and
not a build pipeline of its own.

---

## The experiment in this repo

The tool bundles itself. That is the demonstration: the same pipeline you would run over
your application is the one that produces the `bundle` command npm installs, and every
property this README claims is exercised by the way the tool arrives on your machine.

### The pieces

Everything is TypeScript under `src/`, compiled to ESM in `dist/`. The source is written in
erasable syntax only, so `node src/main.ts` runs it directly through node's type stripping —
the tests import the sources rather than the build for exactly that reason.

| File | Role |
|------|------|
| `src/manifest.ts` | The format: `buildManifest()` / `parseManifest()`, `parseSignature()` / `formatSignature()`, `signatureOf()`, and `verifySync()` — the staged check that decides one of four states. |
| `src/archive.ts` | The bundler: optionally writes a **prefix** (shebang stub or Node binary), then appends a ZIP of the listed files — each stamped with its content digest — with a `baseOffset` equal to the prefix size and an `AUTHORITY.PEM` manifest, then signs the whole file into the EOCD comment. `bundle()` builds from a directory; `rebundle()` re-emits an existing archive behind a new prefix, which is what `sign` runs. |
| `src/api.ts` | The programmatic drive — `createBundle`, `signBundle`, `verifyBundle`, `inspectBundle`, `runBundle` — with the file plumbing the CLI would otherwise be the only user of. |
| `src/cli.ts` | Argument parsing and reporting, and nothing else. `main(argv, io)` returns an exit code instead of exiting, so it is callable in-process; most of the CLI test suite does exactly that. |
| `src/main.ts` | The executable entry: `process.exitCode = await main(process.argv.slice(2))`. Also the package's `main`, which is what `--vfs-load` runs out of a mounted bundle. |
| `src/bin.ts` | What npm installs as `bundle`: a launcher that verifies and mounts the package's own signed CLI archive rather than running the loose files beside it. |
| `src/provider.ts` | The verifying VFS provider: verifies an archive before it becomes a filesystem, then hashes each member as it is fetched. `register()` installs it with `node:vfs`. |
| `src/register.ts` | The `-r` preload entry point — one call to `register()`, configured through the environment. |
| `src/recorder.ts` | The recording provider: wraps a provider class so every read through it is appended to a manifest. Replaces the `--vfs-manifest` flag. |
| `src/record.ts` | The `-r` preload for recording — set `BUNDLE_MANIFEST` and mount a directory. |
| `src/sea.ts` | The self-validating executable: `bootstrap()` at runtime, `createSeaBase()` / `buildSea()` at build time, and the generated CommonJS stub that ties them together. |
| `src/sigstore.ts` | Sigstore as one of the signers the format can carry: a two-phase signer (get the Fulcio certificate, *then* sign the finished hash), synchronous bundle verification, and the trust root. |
| `src/oidc.ts` | Getting an OIDC identity token — an ambient CI token, a browser sign-in through sigstore's Dex, or a device code. No dependencies of its own. |
| `src/files.ts` | Working out a member list the way observation cannot: a dependency closure resolved through `node_modules`, for code that is only required on a path a test run never takes. |
| `src/skill.ts` | The skills this package ships, and installing them into a project — what `bundle skill` runs. |
| `src/types/*.d.ts` | The `node:zlib` ZIP API and the `node:vfs` provider registry, neither of which `@types/node` carries yet. |
| `tools/observe.ts` | Drives the CLI through a recording mount of the package root, for the build's cross-check. |
| `tools/pack.ts` | Builds `build/cli.bundle`: computes the member list, checks it against an observation run, and writes the archive. |
| `tools/prepublish.ts` | The gate on `npm publish` — the signed CLI must exist, verify, and match a build of the current tree. |
| `test/*.test.ts` | 113 tests: the format, the archive, the two providers, the API, the CLI, the SEA, the skills, and the published package's own shape. |
| `shell-base` | The shebang prefix: `#!/usr/bin/env -S node --no-warnings --experimental-vfs --vfs-load --vfs-mount`. |
| `certs/` | A self-signed test PKI (root CA + leaf, `gen.sh`) used to sign and trust the demo archives offline. |
| `skills/audit-bundle/` | The audit skill: verify → extract → security-review every file. |

### The exports

```jsonc
{
  ".":          "./dist/index.js",     // create / sign / verify / inspect / run, from code
  "./register": "./dist/register.js",  // -r preload: mount only what is signed
  "./record":   "./dist/record.js",    // -r preload: write down what a run reads
  "./sea":      "./dist/sea.js",       // build and boot a self-validating executable
  "./provider": "./dist/provider.js",  // the verifying provider, and register(options)
  "./recorder": "./dist/recorder.js",  // the recording provider, and recording(Base, manifest)
  "./cli":      "./dist/cli.js",       // main(argv, io) -> exit code
  "./manifest": "./dist/manifest.js",  // the format on its own
  "./archive":  "./dist/archive.js",
  "./files":    "./dist/files.js",
  "./skill":    "./dist/skill.js",
  "./sigstore": "./dist/sigstore.js",
  "./oidc":     "./dist/oidc.js"
}
```

The package root deliberately does **not** re-export the two providers. Importing either
needs `node:vfs`, which exists only under `--experimental-vfs`, and creating or verifying an
archive does not — so `import '@pipobscure/bundle'` must not drag that requirement in. That
is what the separate entry points are for, and there is a test that holds the line.

### The scripts (`package.json`)

The four steps are four scripts, each runnable on its own, so the order is something you
can see rather than something the README asserts.

```jsonc
"build":          "tsc && chmod +x dist/main.js dist/bin.js",
// TypeScript to ESM in dist/, with .d.ts and declaration maps beside it.

// --- 1. observe -------------------------------------------------------------
"manifest:cli":   "node --experimental-vfs tools/manifest.ts",
// Writes build/cli.manifest: the file list, from a computed dependency closure
// cross-checked against a recording run of the CLI. Anything the run reads that the
// closure missed stops the build.

// --- 2. create --------------------------------------------------------------
"pack:cli":       "node dist/main.js create --base . --files build/cli.manifest --output build/cli.bundle",
// Plainly the CLI, over the list step 1 produced. Unsigned.

// --- 3. audit ---------------------------------------------------------------
"baseline:cli":   "node --experimental-vfs tools/baseline.ts --allow-missing",
// Fetches the currently published bundle and verifies it, to review the new one
// *against*. The first release has none, and then the audit reviews everything.
"audit:cli":      "node --experimental-vfs tools/audit.ts",
// Reports the archive's sha256, its member count and what changed against the baseline,
// then prints the exact skill invocation. The review needs judgement, so no script
// performs it.
"approve:cli":    "node --experimental-vfs tools/audit.ts --approve",
// Record a clean verdict reached by a person instead of by the skill.

// --- 4. sign ----------------------------------------------------------------
"sign:cli":       "node --experimental-vfs tools/audit.ts --check && node dist/main.js sign --output bundle.bundle build/cli.bundle",
// The gate runs first and exits non-zero without a clean verdict pinned to these bytes.
// Then sigstore — CI identity if there is one, otherwise a GitHub sign-in.
"sign:cli:local": "… --check && node dist/main.js sign --key build/certs/leaf.key --chain build/certs/chain.pem …",
// The same against the test PKI, for working offline.

"release:cli":    "npm run build && npm run manifest:cli && npm run pack:cli && npm run baseline:cli && npm run audit:cli",
// Steps 1-3, stopping at the gate. Step 4 is deliberately not chained on: it needs a
// verdict, and a verdict is not a script's to give.

"verify:cli":     "node dist/main.js verify bundle.bundle",
"trust":          "node dist/main.js trust",
// Refresh the sigstore trust root (over TUF) into the local cache. Verification never
// reaches for the network, so this is the explicit step that feeds it.

"test":           "npm run build && npm run typecheck && node --experimental-vfs --test test/*.test.ts",
"prepublishOnly": "node --experimental-vfs tools/prepublish.ts"
// Refuses to publish a package whose signed CLI is missing, unsigned, or stale.
```

**The gate.** `tools/audit.ts --check` is what makes step 3 a step rather than a
suggestion. It reads a JSON verdict the skill writes — `verdict: "pass" | "fail"`, the
findings, the **sha256 of the archive**, and the baseline's sha256 when the review was a
diff — and refuses unless the verdict passed *and* pins the bytes on disk. That pin is the
whole mechanism: an approval that could be carried to a later build is not an approval of
anything, so rebuilding invalidates it. A verdict naming a *different* baseline is refused
the same way; one naming none is accepted as a full review, with a note saying so.

```
$ npm run sign:cli
error: build/cli.bundle has not been audited — there is no verdict at build/cli.audit.json.
  run 'npm run audit:cli' to see how, or BUNDLE_SKIP_AUDIT=1 to sign anyway
```

`BUNDLE_SKIP_AUDIT=1` steps past it deliberately, and says what that means. It is the
publisher's own gate, not a runtime policy — the same reason `--identity` is something the
verifier chooses rather than something the format imposes.

Note the shape of the pipeline: **`create` once, `sign` many times.** `create` never needs a
key, and the archive it writes is the single input to every signed artifact. Drop `--root`
from `verify` to see how the same archive reads when its certificate isn't trusted; drop
`--prefix` from `sign` to produce a plain archive instead of a self-executing container.

`create` still accepts `--key`/`--chain` to sign at build time, which is convenient when you
only ever want one shape. It cannot be used with sigstore: a Fulcio certificate is bound to
an identity you have to authenticate for, so that path goes through `sign`.

### The three artifacts, and how each runs itself

All three come from `sign`, from one unsigned archive, differing only in the `--prefix` they
are re-emitted behind.

**The plain signed archive (needs Node and the preload).**
No prefix at all: just the ZIP, with its per-member digests, its `AUTHORITY.PEM` manifest
and the whole-file signature in the EOCD comment. It is run by mounting it:

```sh
node --experimental-vfs -r @pipobscure/bundle/register --vfs-load --vfs-mount app.bundle -- <args>
```

The preload registers the provider; `--vfs-mount` hands it the archive; the provider verifies
the signature and the chain **before** returning a filesystem, so an archive that fails is
never mounted and the entry point never runs. This is the mode where the *runtime* enforces
the signature rather than the application checking itself — the application needs no boot
code of its own at all. (The `--` matters: without it node claims any argument that looks
like one of its own flags, and the application never sees it.)

**`app.run` — the shebang archive (the same ZIP plus a one-line header; needs Node installed).**
It is literally the `shell-base` shebang line followed by the ZIP. When executed, the kernel
runs `env node --vfs-load --vfs-mount` and appends the file's own path, which becomes that
trailing flag's value — so it mounts **itself** as a read-only ZIP, whose `package.json`
main becomes the entry point. The archive's `baseOffset` was seeded to skip the shebang
bytes, so it stays a valid ZIP even though it doesn't start at byte 0. A whole application
in a file you can email — provided the recipient has a compatible Node.

> **Note:** this needs a Node whose provider selection recognizes a ZIP by locating its
> end-of-central-directory record rather than by sniffing `PK\x03\x04` at byte 0 — a
> prefixed container by construction has no `PK` at byte 0, and the leading-bytes test
> rejected it with `ERR_VFS_INVALID_TARGET` before anything else happened. The bundle
> provider never had that blind spot (it always scanned from the tail), so
> `node -r @pipobscure/bundle/register --vfs-load --vfs-mount app.run` mounts and verifies
> the same file either way.
>
> The shebang launcher runs the archive *without* the verifying provider — the kernel gives
> it no preload flag to carry one. It is the convenient shape, not the enforcing one. For a
> container that gates itself, use the SEA below.

**The native executable (~155 MB; needs nothing).**
`bundle sea` produces it: a Node runtime whose SEA blob carries this package as a mounted
asset, with the application appended as a signed archive. Running it verifies the whole
file — runtime, verifier and application alike, since the signature covers all of it — and
only then mounts the archive and runs what is inside. No Node on the target, no
`node_modules`, no extraction to disk. See [Self-verifying the SEA](#self-verifying-the-sea).

Same application, same archive format, three shapes — one where the **runtime** enforces
the signature (`.bundle`), one optimizing for **size** (reuse the user's Node), one for
**self-containment** (bring your own Node). And, because the prefix is chosen at *signing*
time rather than at build time, all three come from one `create` and differ by one flag.

### Try it

```sh
npm install
npm run build

# 1. observe what a run reads.
BUNDLE_MANIFEST=app.manifest node --experimental-vfs \
    -r ./dist/record.js --vfs-load --vfs-mount ./some/app > /dev/null

# 2. archive exactly that, unsigned.
node dist/main.js create --base ./some/app --files app.manifest --output app.bundle
node dist/main.js verify app.bundle                          # -> UNSIGNED

# 3. audit it, before putting your name on it.
node dist/main.js skill                 # install the skill, once per project
claude "/audit-bundle app.bundle"       # or however you drive Claude Code

# 4. sign it — offline here, against the repository's test PKI.
node dist/main.js sign --key build/certs/leaf.key --chain build/certs/chain.pem \
    --output app.signed.bundle app.bundle
node dist/main.js verify --root build/certs/root.pem app.signed.bundle    # -> VALID
node dist/main.js verify app.signed.bundle                          # -> VALID (UNTRUSTED)

# Run it through the verifying mount.
node dist/main.js run --root build/certs/root.pem app.signed.bundle -- <args>
node --experimental-vfs -r ./dist/register.js --vfs-load --vfs-mount app.signed.bundle
    # refuses: the test root is trusted by nothing

# The same archive behind a shebang, and inside a self-validating executable.
node dist/main.js sign --key build/certs/leaf.key --chain build/certs/chain.pem \
    --prefix shell-base --output app.run app.bundle
node dist/main.js sea --key build/certs/leaf.key --chain build/certs/chain.pem \
    --root build/certs/root.pem --output app.sea app.bundle
./app.sea <args>            # verifies itself, then runs

npm test                    # 131 tests: sign, verify, mount, run, SEA, the gate, and every refusal
```

Building the tool the way the tool says to build things — the same four steps:

```sh
npm run release:cli         # 1-3: observe, pack, fetch the baseline, stop at the gate
                            #   -> build/cli.manifest, build/cli.bundle (679 members)

npm run sign:cli:local      # 4: refuses, because nothing has been audited yet
BUNDLE_AUDIT_VERDICT=build/cli.audit.json claude "/audit-bundle build/cli.bundle"
npm run sign:cli:local      # 4: now allowed -> bundle.bundle

node dist/bin.js --help     # the launcher verifies it, mounts it, and runs it
```

To sign through sigstore instead — this opens a browser, or uses the CI identity when there
is one:

```sh
npm run trust               # fetch the sigstore trust root, once
npm run sign:cli            # -> bundle.bundle, signed by whoever you signed in as
npm run verify:cli          # -> VALID, with the identity that signed it
```

A launcher archive (`app.run`) cannot verify **itself** by its own path — the mount covers
that path, so it resolves to the archive's *interior*, not the raw bytes. Verify it under a
different name, or use the SEA, which mounts at a generated path and *can* self-verify.

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
says nothing about any message. So the two halves separate cleanly, and `src/sigstore.ts`
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

Every operation the CLI has is an export, and the CLI is a `parseArgs` wrapper over them:

```ts
import {
    createBundle, signBundle, verifyBundle, inspectBundle, runBundle, fileSigner,
} from '@pipobscure/bundle';

// Build unsigned. The archive this writes is the single input to every shape you ship.
await createBundle({ base: 'app/', files, output: 'app.bundle' });

// Sign it — once per shape, each correctly offset and each signed over its own bytes.
await signBundle({ source: 'app.bundle', output: 'app.signed.bundle', signer });
await signBundle({ source: 'app.bundle', output: 'app.run', prefix: 'shell-base', signer });

// Ask what it claims, and then whether any of it is true.
const { members, signed, hash } = inspectBundle('app.run');
const { state, reason, identity } = await verifyBundle('app.run', { roots: ['root.pem'] });

// Mount it through the verifying provider, in a child process, and run it.
const { status } = runBundle('app.signed.bundle', { roots: ['root.pem'], args: ['--help'] });
```

The layer underneath is exported too, for callers assembling members themselves rather than
from a directory:

```ts
import { buildManifest, verifySync } from '@pipobscure/bundle/manifest';
import { bundle, rebundle, createArchive, keySigner } from '@pipobscure/bundle/archive';
```

A **signer** is just `{ chain, signAlg, sign(digest) }`: the chain goes into `AUTHORITY.PEM`
before hashing, and `sign()` is called after, with the finished hash, returning a signature
and any unsigned-attribute fields. `keySigner()` is the offline-CA implementation and
`@pipobscure/bundle/sigstore`'s `signer()` is the other one — `rebundle()` knows about
neither, which is the point. Writing a third (an HSM, a KMS, a corporate signing service) is
a matter of implementing those three properties.

Working out *what* to bundle has two answers, and the build here uses both. `@pipobscure/bundle/recorder`
observes a run; `@pipobscure/bundle/files` computes a closure:

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

Observation is the honest answer — it produces exactly the set that was used — but it has one
blind spot that matters for a verifier: code loaded lazily on a path the run never took.
`sigstore.ts` requires `@sigstore/verify` only when it meets an archive with a `SIGSTORE=`
field, so a build that signs with a local key never touches it, and the resulting bundle
would be unable to check a sigstore signature it later met. So `tools/pack.ts` computes the
closure for completeness and uses the observation run as the *check* on it: anything read
that the closure missed is a hole, and the build stops.

`./provider` and `./recorder` are deliberately *not* re-exported from the package root:
importing them needs `node:vfs`, which only exists under `--experimental-vfs`, while
creating and verifying archives does not. `./sigstore` is namespaced rather than flattened
for a different reason: it is a signer implementation, not part of the archive format, and
an archive signed against an ordinary CA verifies with nothing but `node:crypto`. The
sigstore libraries' absence degrades a sigstore verification to `valid-untrusted` rather
than breaking it.

### Running only what is signed — the `.bundle` provider

`src/provider.ts` is where verification stops being something an application does to itself
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
| `BUNDLE_IDENTITY` | Require this sigstore signing identity — a machine configured to run only releases from one workflow. |
| `BUNDLE_ISSUER` | Require this sigstore OIDC issuer. |
| `BUNDLE_SIGSTORE_ROOT` | The sigstore trust root to check against, instead of the cache `bundle trust` fills. |

Demanding an identity is a demand about *who signed this*, and only a sigstore signature
carries an answer. An archive signed against an ordinary CA makes no such claim, so it reads
as `valid-untrusted` under such a policy rather than passing — otherwise `BUNDLE_IDENTITY`
would be a no-op in exactly the deployment that relies on it.

For anything more, call `register()` yourself from a preload of your own:

```js
// my-preload.js — node --experimental-vfs -r ./my-preload.js --vfs-load --vfs-mount app.bundle
import { register } from '@pipobscure/bundle/provider';

register({
  extensions: ['.bundle', '.app'],   // claimed by name
  claimSigned: true,                 // and anything carrying a SIGNED: marker, whatever it is called
  roots: ['/etc/ssl/my-root.pem'],   // PEM text or paths to PEM files
  allowUntrusted: false,
  deep: false,                       // recompute every digest at mount, not on fetch
  identity: 'https://github.com/me/app/.github/workflows/release.yml@refs/heads/main',
  issuer: 'https://token.actions.githubusercontent.com',
});
```

A preload runs under the CommonJS loader, so it must not contain a top-level `await` — but
ESM syntax is otherwise fine, and `--import` works as well as `-r`.

`bundle run <archive> [-- <args>]` is the same thing with the flags filled in: it re-execs
`node` with the preload and `--vfs-mount`, so what runs is what the child's own bootstrap
verified.

### Self-verifying the SEA

`bundle sea` produces a single executable that checks its own signature before it runs
anything. The file is three parts, in the order the loader meets them:

```
[ node runtime | SEA blob: stub + the verifier as a mounted asset ] [ app.bundle ]
  \____________________ the prefix, and part of the ______________/
   \___________________ archive's signed region _______/
```

The application is an ordinary signed `.bundle` appended to a node binary — the same
`sign --prefix` that produces a shebang launcher. What makes the result self-validating is
that the whole-file hash covers the prefix too, so the runtime and the verifier inside it
are signed by the same signature that covers the application. There is nothing to check the
checker against, because the checker is inside what is checked.

**Driving SEA through a VFS mount.** The bootstrap runs before anything is mounted, so it
cannot import this package the ordinary way. Rather than inlining a second copy of the
verifier into the stub — which is what this used to do, and which drifts — the package's own
files ride in the SEA blob as a single `.bundle` asset, and the stub mounts *that* with
`node:vfs` and requires the real library out of it. So there are two mounts: the verifier's,
from the blob, and then the application's, from the archive at the end of the file.

That mirrors [nodejs/node#65675](https://github.com/nodejs/node/pull/65675) (`"useVfs": true`),
which puts a SEA's own assets behind a VFS mount and runs the main script from its root, so
`__dirname`, relative `require()` and `node_modules` resolution all work inside the
executable. **That work is not merged and is in no released Node**, so the same thing is
done here in userland — with the difference that matters for this package: the mount that
runs the *application* is the signed archive appended to the file, not the blob. When
`useVfs` lands, the generated stub is the only piece that changes.

The startup, in order:

1. **verify** — the verifying provider from `./provider` recomputes the whole-file hash over
   `process.execPath` (itself, runtime and all), checks the signature over it against the
   chain in `AUTHORITY.PEM`, and anchors that chain. Anything short of acceptable exits
   non-zero here, before the archive is a filesystem.
2. **mount** — only then does the archive become the application's file tree, and `__filename`,
   `import.meta.dirname`, relative imports and `node_modules` all resolve inside it.
3. **run** — the archive's `package.json` `main`, `require()`d or `import()`ed as its `type`
   and extension say.

Because the mount is the *verifying* provider rather than a plain `ZipProvider`, this is not
merely a signature check at startup: every member is re-hashed against its signed digest as
it is first read, for the whole life of the process.

**What runs before the check.** The stub and the verifier execute before the signature has
been verified. That is not a hole so much as the place where trust has to start: both live
inside the prefix, which is inside the hashed region, so tampering with either invalidates
the signature over the application — and an attacker who could rewrite the executable's own
runtime could equally rewrite a verifier that ran first. The application never runs until
the check passes.

Building one, and configuring what the finished binary will accept:

```sh
bundle sea --output app.sea \
    --root /etc/ssl/my-root.pem \
    --identity 'https://github.com/me/app/.github/workflows/release.yml@refs/heads/main' \
    --issuer 'https://token.actions.githubusercontent.com' \
    app.bundle
```

Those become the executable's own policy, baked into the stub — which is the point, since a
binary run by its own name has no flags and no preload to configure it. Leave them off and
the policy comes from `BUNDLE_ROOTS` / `BUNDLE_IDENTITY` / `BUNDLE_ALLOW_UNTRUSTED` in the
environment instead, so one build can be decided about later. From code:

```ts
import { buildSea, createSeaBase } from '@pipobscure/bundle/sea';

// The base is the expensive half (a ~155 MB copy of node); build it once and reuse it.
await createSeaBase({ output: 'sea-base', bootstrap: { roots: ['root.pem'] } });
await buildSea({ app: 'app.bundle', output: 'app.sea', base: 'sea-base', signer });
```

An application can also ask about its own provenance without mounting anything:

```ts
import { verifySelf } from '@pipobscure/bundle/sea';

const { state, identity, signedAt } = verifySelf();
```

By contrast, the shebang launcher has no pre-mount stage of its own, so `app.run` executed
directly does not self-verify — the kernel gives it no preload flag to carry a provider, and
it hands straight off to the app. Mounting it with the provider preloaded
(`node -r @pipobscure/bundle/register --vfs-load --vfs-mount app.run`) is what closes that
gap, and is the one route by which `app.run` runs verified at all.

---

## Recording the manifest

Building an archive needs a file list, and the honest way to get one is to run the
application and write down what it read. That used to be `--vfs-manifest=<file>`, a flag
that poked an observer slot inside `node:vfs`. With mounting reduced to `--vfs-mount` and
provider selection the one place a mount can be influenced, the same job is better done by
a **provider** — which is what `src/recorder.ts` is:

```sh
BUNDLE_MANIFEST=app.manifest node --experimental-vfs \
    -r @pipobscure/bundle/record --vfs-load --vfs-mount ./app
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

```ts
// my-preload.js
import { BundleProvider } from '@pipobscure/bundle/provider';
import { recording, Manifest } from '@pipobscure/bundle/recorder';

const Recording = recording(BundleProvider, new Manifest('reads.txt'));
```

Two things it does not do. It records per *mount*, not per process, so several
`--vfs-mount` directories merge into one list — the flag only ever supported a single
directory target, so this is new ground rather than a regression. And node consults
registered providers when `--vfs-mount` is handed a *file*, but mounts a directory with its
own `RealFSProvider` without asking — so a directory mount cannot be influenced from a
preload alone, and `tools/observe.ts` makes the mount itself and resolves the entry point
against the path it is given back. That is the shape to copy for your own build.

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

Claude Code discovers skills under `.claude/skills/`, and the skill belongs next to whoever
is about to run an archive rather than in this repository — so the CLI writes it out:

```sh
bundle skill                        # -> .claude/skills/audit-bundle/SKILL.md
bundle skill --list                 # what this package carries
bundle skill --dir ~/.claude/skills # somewhere else
```

It never overwrites a file that is already there (`--force` if you mean to), so local edits
survive an upgrade. The same thing from code, if you are wiring it into a setup script:

```ts
import { installSkill, skills } from '@pipobscure/bundle';

const { written, skipped } = installSkill('audit-bundle', { dir: '.claude/skills' });
```

It also has a diff mode: verify and extract two archives, review only what changed against a
previously approved one, and call out any member added or removed. That is the realistic
repeat-use case, and considerably more valuable than a fresh full review each time.

Steps 1 and 2 are the existing CLI; only step 3 is new. That split is deliberate — the
policy layer is a library and a skill you can replace, not something the runtime does.

### Gating a release on the audit, in CI

The review needs judgement, so nothing here pretends a script can perform it. What a script
can do is refuse to proceed without one — and that needs the audit to produce something a
build step can read. So the skill writes a JSON verdict beside its prose report:

```json
{ "sha256": "f59a1a0a…", "baselineSha256": "e18542c9…", "mode": "sign",
  "verdict": "pass", "members": 679, "reviewed": 12, "findings": [],
  "summary": "12 members changed since 0.1.3; the sigstore tree is upstream and unmodified" }
```

`tools/audit.ts --check` reads it, re-hashes the archive, and exits non-zero unless the
verdict passed *and* names those exact bytes. That is the whole gate, and it works the same
locally and in CI.

[`.github/workflows/release.yml.disabled`](.github/workflows/release.yml.disabled) is that
pipeline as a workflow. It runs:

```
CI  →  pack  →  fetch the published release  →  audit the diff  →  gate  →  sign  →  publish
```

Step 3 is [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
in automation mode — a `prompt` input rather than an `@claude` mention — invoking this
repository's own skill:

```yaml
- name: Install the audit skill
  run: node dist/main.js skill          # into .claude/skills/, where the action looks

- name: Audit — review the difference before signing
  uses: anthropics/claude-code-action@833fb0f8c9f6686b33d963a8bae0a94f4936ab2a # v1
  env:
    BUNDLE_AUDIT_VERDICT: build/cli.audit.json
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: "/audit-bundle build/cli.bundle against build/baseline.bundle …"
    claude_args: |
      --max-turns 120
      --allowedTools "Bash,Read,Glob,Grep,Write"

- name: Gate on the audit verdict
  run: node --experimental-vfs tools/audit.ts --check
```

**Why a diff.** Re-reading 679 unchanged members every release is the kind of review that
decays into a rubber stamp; a small diff gets read properly. `tools/baseline.ts` fetches the
currently published package with `npm pack` — which downloads without installing or running
anything — pulls its `bundle.bundle` out, and **verifies it before using it**, optionally
requiring the release workflow's own identity. A baseline that cannot be placed would make
the diff lie by omission: everything it already contained would read as "unchanged" and
therefore go unread. With no baseline at all — the first release — it says so and the audit
reviews everything.

**Why the actions are pinned to commit SHAs.** A tag is a mutable pointer. Whoever can move
`v1` can change what runs inside a job holding an OIDC token that can sign releases and
publish to npm — which is precisely the attack this project exists to talk about, so the
workflow that publishes it should not be open to it. Update the SHAs deliberately and read
the diff when you do.

**Why signing and publishing use the same identity.** `permissions: id-token: write` gets
one OIDC token; Fulcio certifies it for the signature, and `npm publish --provenance` files
its attestation from it. Two attestations over one artifact, from one identity: npm's over
the registry copy, and this project's over the bytes inside it.

> **It cannot run yet.** Every step depends on the unmerged node work, so there is no
> `node-version` that would make it pass. The file is disabled two ways over — it does not
> end in `.yml`, so GitHub never parses it, and its body is commented out — and it carries
> the one-line command that turns it back into a live workflow. It is there to be read.

Two honest limits. An LLM review is a good reviewer, not a proof — it raises the cost of
slipping something past and does not reduce it to zero, which is what the `severity` and
`summary` fields are for: they leave a record of what was judged acceptable and why, so a
later reader can disagree with it. And the gate protects the *publisher's* pipeline; a
consumer who wants the same assurance runs the same skill over what they received, which is
the point of it being one review at two points rather than a build-only step.

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
  src/            the tool, in TypeScript; compiled to ESM in dist/
    index.ts        the package root: create / sign / verify / inspect / run, from code
    api.ts          the programmatic drive the CLI is a wrapper over
    cli.ts          parseArgs and reporting; main(argv, io) -> exit code
    main.ts         the executable entry, and the package `main` --vfs-load runs
    bin.ts          what npm installs as `bundle`: a launcher for the signed CLI archive
    archive.ts      bundle() builds unsigned from a directory; rebundle() re-emits behind a
                    new prefix and signs; keySigner() is the offline-CA signer
    manifest.ts     buildManifest() / parseManifest() / verifySync(): the format and its check
    provider.ts     BundleProvider + register(): verify at mount, hash every member at fetch
    register.ts     the `-r` preload; configured via BUNDLE_ROOTS / BUNDLE_ALLOW_UNTRUSTED / …
    recorder.ts     recording() + Manifest: the userland replacement for --vfs-manifest
    record.ts       the `-r` preload for recording; configured via BUNDLE_MANIFEST
    sea.ts          bootstrap() / createSeaBase() / buildSea(): the self-validating executable
    sigstore.ts     the sigstore signer (two-phase) and synchronous bundle verification
    oidc.ts         identity tokens: ambient CI, browser sign-in, or device code
    files.ts        dependency closures, for what an observation run cannot see
    skill.ts        the skills this package ships, and installing them into a project
    preload.ts      the shared plumbing the two `-r` preloads need
    types/          node:zlib's ZIP API and node:vfs's provider registry, until @types/node has them
  tools/          the build steps that are not just a CLI call:
                    manifest.ts   observe a run, close over the dependencies, write the list
                    observe.ts    the recording mount that run goes through
                    baseline.ts   fetch and verify the published release, to diff against
                    audit.ts      prepare the audit, and gate signing on its verdict
                    prepublish.ts refuse to publish a stale or unsigned CLI
  .github/workflows/release.yml.disabled
                  the release pipeline, inert until the node work lands
  test/           113 tests over the format, both providers, the API, the CLI, the SEA and the package
  skills/audit-bundle/
                  the audit skill: verify -> extract -> security-review every file.
                  `bundle skill` writes it into a project's .claude/skills/
  tools/testpki.ts  generates a throwaway PKI into build/certs/ on demand
  shell-base      shebang prefix for the portable archive
  tsconfig.json   strict, ESM, erasable syntax only — so `node src/main.ts` runs the sources
  package.json    the build / pack:cli / sign:cli / verify:cli / trust / test scripts
```

Build outputs — `dist/`, `build/cli.bundle` and the signed `bundle.bundle` — are generated
by those scripts and are not in the repository.

**Environment variables**

| | |
|---|---|
| `BUNDLE_MANIFEST` | where the recording provider writes the observed file list |
| `BUNDLE_ROOTS` | extra trusted roots for verification, path-delimiter separated |
| `BUNDLE_ALLOW_UNTRUSTED` | mount an archive whose signature is good but untrusted |
| `BUNDLE_IDENTITY` / `BUNDLE_ISSUER` | require a particular sigstore signer at mount time |
| `BUNDLE_SIGSTORE_ROOT` | path to the sigstore trust root, instead of the cache |
| `BUNDLE_NO_BROWSER` | never try to open a browser; use the device flow |


---

# Implementation notes

Design that was decided-enough to write down before it was built. These were kept in a
separate file for most of the project's life, on the theory that the reasoning is worth
more than the diff; they live here now because the reasoning and the argument are the same
document read at two zoom levels. Where an implementation departed from its plan, that is
recorded inline rather than edited away — a design note that only ever describes what
happened is a changelog, and the interesting part is usually the gap.

| | |
|---|---|
| **§1 signing-time attestation** | Built. The marker grammar is extensible, and the evidence rides in a `SIGSTORE=` field carrying a full sigstore bundle — transparency-log entry *and* RFC 3161 token — rather than a bare TSA token. |
| **§2 the audit skill** | Built, as `skills/audit-bundle/`. |
| **§3 the tool as a bundle of itself** | Built. The published package carries its own CLI as one signed archive and the `bundle` command is a launcher for it; the sigstore dependencies became members, as this section said they would have to. |
| **§4 the self-validating executable** | Built, as `src/sea.ts` and `bundle sea`. The VFS mount that drives a SEA, applied to the archive appended to it. |
| **§5 the audit as a build step** | Built, as `tools/audit.ts`, `tools/baseline.ts` and `.github/workflows/release.yml.disabled`. The review moves from something you do to an archive you received to something that happens between `create` and `sign`. |

---

### 1. Signing-time attestation, so short-lived certificates verify later

> **Built.** What follows is the reasoning; see the note at the end of this section for
> where the implementation differs.

#### The problem

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

#### The circular approach, and why it fails

The obvious move — put the Rekor transparency-log entry in the archive as a member — does
not work:

1. The archive is hashed and signed, producing `H` and `S`.
2. Submitting `(H, S, cert)` to Rekor yields a signed entry timestamp.
3. Adding that as a member changes the member list, so the central directory changes, so
   `H` changes, so `S` is invalid.
4. Re-signing produces a new `H`, so a new log entry, so back to 3.

Anything placed **inside the hashed region** has this problem. The timestamp is obtained
*after* the signature exists, so it can never be part of what the signature covers.

#### The resolution: the EOCD comment is already an unsigned-attribute region

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

#### Proposed change

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

#### Timestamp `S`, not `H`

A token over `H` proves *the archive* existed at `T`. A token over `S` proves *the
signature* existed at `T`, which is the question actually being asked about certificate
validity. CMS convention is to timestamp the signature value.

#### Why an unhashed comment is acceptable here

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

#### Cheaper alternatives, if this is too much machinery

- **Self-asserted signing time.** A `!signed <RFC3339>` directive in `AUTHORITY.PEM` sits
  *inside* the hashed region, so it is covered by `S` and is tamper-evident. But it is only
  as good as the signer's clock, and it gives back the bounded-damage property that
  short-lived certificates exist to provide. A convenience fallback, not an equivalent —
  and it should produce a distinguishable result state, not silently pass as `valid`.
- **Verify once at ingest, then pin the hash.** Sidesteps long-lived re-verification
  entirely. For many deployment models this is the right answer and needs no format change
  at all.

#### Open questions

- Which TSA to pin by default. Sigstore operates one; confirm the current endpoint and
  root distribution rather than hard-coding a hostname.
- Whether an archive with a good signature but *no* timestamp and an expired certificate
  deserves its own state/reason rather than collapsing into `valid-untrusted`.
- Whether to support Rekor inclusion proofs as an alternative to a plain TSA token. Same
  placement, strictly more verification work; only worth it if log transparency is wanted
  for its own sake.

#### What was actually built

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

### 2. An audit skill: verify → extract → review

> **Built**, as `skills/audit-bundle/SKILL.md`, following this shape closely —
> including the diff mode and the non-skippable verification step.

#### Why a bundle is the right shape for this

A signed archive answers *who produced these bytes*. It does not answer *are these bytes
safe*. Those are different questions, and every npm compromise of recent years shipped a
correctly published, correctly signed package from a legitimately compromised account —
provenance alone would have confirmed it came from the real maintainer and been useless.

What makes the second question tractable here is that a bundle is a **closed set**: nothing
resolves later, nothing is fetched at install, no lifecycle script pulls in more code. A
review over it can be complete in a way that a review of a dependency tree cannot.

#### Shape

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

#### Notes

- Steps 1 and 2 are the existing CLI; only step 3 is new work.
- The verification step must not be skippable — an audit that silently reviewed a
  tampered archive would be worse than no audit.
- Worth pairing with a diff mode: review only what changed against a previously approved
  archive, which is the realistic repeat-use case.

---

### 3. Shipping the tool as a bundle of itself

> **Built.** What follows is the reasoning; see the note at the end of this section for
> where the implementation differs.

#### The claim

`bundle` should not be installed from npm. It should be distributed the way it tells
everyone else to distribute: **one signed file**, verifiable by a copy of `bundle` you
already have, and auditable as a closed set before you run it.

That makes the tool its own best demonstration. Every property this project claims — a file
list discovered by observation, a whole-file signature, a mount that refuses what does not
verify, a closed set an audit can be complete over — is exercised by the way the tool
itself arrives on your machine. If the model does not hold up for `bundle`, it does not
hold up for anything.

#### Why this is the answer to "where is the lock file?"

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

#### The chain of custody

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

#### The wrinkle: the tool has dependencies now

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

#### Open questions

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

#### What was actually built

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

### 4. The self-validating single executable

> **Built**, as `src/sea.ts` and `bundle sea`.

#### The claim

Every shape this tool produces gates on something outside itself. A `.bundle` needs the
verifying provider preloaded; a shebang launcher has no preload at all and hands straight
off to the application. The SEA is the shape that can carry its own gate, because the
container *is* the runtime — and the interesting property is that the gate can be inside
what it gates.

#### The shape

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

#### Why the verifier is a mount rather than an inlined copy

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

#### What runs before the check

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

#### Configuration, and where policy lives

An executable run by its own name has no flags and no preload, so `createSeaBase()` bakes
the bootstrap options into the generated stub — trusted roots, a required sigstore identity
and issuer, whether an unanchored chain is acceptable. Leave them off and the same
`BUNDLE_ROOTS` / `BUNDLE_IDENTITY` / `BUNDLE_ALLOW_UNTRUSTED` variables the mount honours
apply, so one build can be decided about later. Both are legitimate; which one you want is
whether the policy belongs to the publisher or to the deployment.

#### Open questions

- **Cross-compilation.** `createSeaBase({ node })` takes the binary to embed, so building a
  container for another platform is a matter of having that platform's node to hand. Whether
  the tool should fetch one is a packaging decision it has so far declined to make.
- **Size, again.** The verifier asset is about a megabyte inside a 155 MB runtime, so the
  sigstore libraries are not what makes a SEA large. A verify-only verifier would save
  little and cost a build variant; `sigstore: false` exists for anyone who disagrees.



---

### 5. The audit as a build step, and a gate that can act on it

> **Built**, as `tools/audit.ts`, the verdict contract in `skills/audit-bundle/SKILL.md`,
> and `.github/workflows/release.yml`.

#### The claim

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

#### Why the ordering has to be create-then-audit, not audit-then-create

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

#### The gate

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

#### Reviewing the diff, not the archive

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

#### Running the review in CI

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

#### Pinning the actions

Every action is pinned to a full commit SHA rather than a tag. A tag is a mutable pointer,
and whoever can move `v1` can change what runs inside a job that holds an OIDC token able
to sign releases and publish to npm. That is not a hypothetical class of attack here; it is
the same class HISTORY.md's opening argument is about, and a workflow that publishes *this*
project while being open to it would be self-refuting.

The cost is real and worth naming: pinned SHAs do not pick up security fixes on their own,
so they have to be updated deliberately, with the diff read. That is the trade, and it is
the right one for a release pipeline specifically — less obviously so for ordinary CI.

#### Why it ships disabled

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

#### What this does not claim

An LLM review is a reviewer, not a proof. It raises the cost of slipping something past a
release and does not reduce it to zero, and a gate that implied otherwise would be worse
than no gate — which is what the `severity` and `summary` fields are for: they leave a
record of what was judged acceptable and by what reasoning, so a later reader can disagree
with it.

The gate also protects the publisher's pipeline only. A consumer who wants the same
assurance runs the same skill over what they received. That is not a gap being papered
over; it is the reason the skill is one review at two points rather than a build-only step.

#### Open questions

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
