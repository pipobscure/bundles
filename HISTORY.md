# bundles — the argument

> **This is the long-form document: why this project exists, what it is arguing about
> Node.js packaging and software supply chains, and how the design got to where it is.**
> It was the README for most of the project's life and is kept as the reasoning, which is
> worth more than the diff.
>
> For **using** the tool — install, commands, API, the four steps of building a bundle —
> see [README.md](README.md). For design decisions written down before they were built,
> and what departed from the plan, see [docs/design-notes.md](docs/design-notes.md).
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
  docs/           design notes: the reasoning, kept where the diff cannot carry it
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
