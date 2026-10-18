# 🌳 Using `@pipobscure/bundle` from code

Everything the `bundle` command does is available as an API, and the plugin loader is only
available as one. This is the reference for both. For what the tool does, see the
[README](../README.md); for every command, [cli.md](cli.md); for how it works and why,
[design.md](design.md).

## The library

Everything the CLI does, as an API. The CLI is a `parseArgs` wrapper over exactly these
functions and holds no logic of its own.

```ts
import {
    createBundle, signBundle, verifyBundle, inspectBundle, runBundle, fileSigner,
} from '@pipobscure/bundle';

// Build it in its shape — here behind a launcher, so it runs by name. Unsigned,
// it records its whole-file hash; this is what gets reviewed.
await createBundle({ base: 'app/', files, output: 'app.unsigned.nzip', prefix: 'shell-base' });

// Sign it as it is: the same members, behind the same prefix. `output` may be
// the archive itself; the result replaces it only once it is complete.
const signer = fileSigner({ key: 'leaf.key', chain: 'chain.pem' });
await signBundle({ source: 'app.unsigned.nzip', output: 'app.nzip', signer });

// Ask what it claims, and then whether any of it is true.
const { members, signed, hash } = inspectBundle('app.nzip');
const { state, reason, identity } = await verifyBundle('app.nzip', { roots: ['ca.pem'] });

// Mount it through the verifying provider and run it, in this process.
const status = await runBundle('app.signed.nzip', { roots: ['ca.pem'], args: ['--help'] });
```

**Dates.** Each member is dated with its file's own modification time, never the time of the
build, and no later than `SOURCE_DATE_EPOCH` when that is set, so the same files make the same
archive. `date`, a `Temporal.Instant`, gives every member one time instead:
`createBundle({ …, date: parseDate('2024-05-01T12:00:00Z') })`. `parseDate()` takes ISO 8601
only: a date, or a date and time with its offset. Signing keeps every member's time.

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
[Environment](cli.md#environment) in the command reference.

## Installing from code: `@pipobscure/bundle/install`

What `bundle install`, `update`, `installed`, `validate` and `uninstall` do, as functions; the
commands are a thin layer over these. A program that is installed with bundle, and updates
itself or its parts, calls them directly:

```js
import { install, update, uninstall, installed, validate, records, partsOf } from '@pipobscure/bundle/install';

const app = await install('https://ordner.fyi/bundles/suite/suite.nzip', { decide });  // and its parts
await install({ file: '/media/usb/suite.nzip', source: 'https://ordner.fyi/bundles/suite/suite.nzip' });
await install({ bytes, name: 'suite' });                                                  // in an image build

for (const result of await update(app.name)) {
    if (result.partOf && result.state !== 'unchanged') restart(result.record.package);   // a part that changed
}
```

- **`install(target, options?)`** takes a URL, a domain, a listing (`@<handle>/<name>`), a path to
  a file, or a local archive `{ file | bytes, name?, source? }`. It returns the app's
  `InstallRecord`. `source` is the URL a local archive stands for: an update fetches it, and the
  app's parts are resolved against it, else against the file, so parts beside the file are
  found. Bytes with no source install, but an app that declares parts then has nowhere to find
  them. `options` are what the command's flags are: `roots`, `identity`, `issuer`, `attesters`,
  `quorum`, `block`, `name`, `dir`, `scope` (for a plugin), `discover`, and `decide` (asked when
  nothing known vouches for it; without it such an install stops with
  `ERR_BUNDLE_UNCONFIRMED`), `onReview` and `log`.
- **`update(names?, options?)`** returns an `UpdateResult` for each install, and after an app's
  own result, one for each of its parts: `{ record, state, partOf, hash, previousHash, previous,
  reason }`. `state` is `unchanged`, `updated` (`previousHash` and `hash` are the whole-file
  hashes before and after; `previous` the replaced file's sha256), `added` or `removed` for a
  part, or `declined`, `unconfirmed`, `refused` or `failed` with a `reason`. An app and its parts
  move together: if any part cannot be had or is not what the app pins, the app's result says
  why, and nothing changed.
- **`uninstall(which?)`** removes an install, and an app's plugins with it (`plugins` on the
  result); its parts always.
- **`installed()`** and **`validate()`** re-check every install against its record, as the
  commands do, parts against their app. **`records()`** is everything installed by name, and
  **`partsOf(name)`** an app's parts.

`BUNDLE_ROOT` (or `--system`, on the command line) puts everything these touch under one root:
see [Files and directories](cli.md#files-and-directories).

### Parts

An app declares its parts in its `package.json`:

```json
"bundle": { "parts": [ { "package": "@ordner.fyi/auth", "url": "auth.nzip", "hash": "sha256:3f1a…" } ] }
```

- **`hash`** is the part's whole-file hash, `<alg>:<hex>`: the hash attestations name and
  `verifyBundle()` reports as `hash`, which `pinOf()` (from `./integrity`) and `bundle parts`
  give. It is not the sha256 of the file, which also covers the archive's trailing comment.
- **`url`** is resolved against the URL the app was fetched from, and fetched only by the same
  means.
- **Installing the app installs each part** as a plugin in the app's scope, its package name.
  A part must be the bytes its pin names, hold together, and carry the package it is declared
  as; it needs no signature or attestation of its own. It is recorded with `partOf`, the app's
  install, and is installed, updated and removed only with it.
- **The policy is the app's.** The `apps` section for the app applies to the app. The `scopes`
  section for its package does not apply to its parts: that section is about plugins someone
  else wrote, and a part is the app's own, held to the app's pin. A bad verdict from someone
  the policy blocks on still refuses a part.

## Building executables

`@pipobscure/bundle/sea` builds what `bundle sea` builds. `createSeaBase()` makes the
expensive half, a ~155 MB copy of Node with the verifier inside it, and `buildSea()` appends
an application to a base, so one base serves any number of applications.
`@pipobscure/bundle/launch` is the entry point all of it runs through: `run()`, `runSelf()`,
`verify()`, `main()`. `verifySelf()` lets an application report on its own provenance ("signed
by X at Y").

## Plugins: `@pipobscure/bundle/plugins`

```js
import { use, list, runPlugin, Worker } from '@pipobscure/bundle/plugins';

use('bled');                                          // the scope: this app's package name
for (const plugin of list('bled')) await import(plugin.package);   // everything installed
use('/opt/bled/plugins');                             // or any directory of plugins
await runPlugin('@ordner.fyi/suite', '@ordner.fyi/auth', process.argv.slice(3));   // run one as the program
```

**`use(scope, options?)`** makes one scope's plugins resolvable in the calling thread. The
scope is the app's own package name, which is where `install --for` put its plugins. An
absolute path is also accepted, for plugins laid out the same way anywhere else.

- `use()` reads the scope's directory and each archive's `package.json` name. It runs nothing
  and, unless verifying or pinning, checks nothing.
- Two archives claiming one name, or an archive with no name, is an error.
- A folder linked for development (`bundle install --for <app> ./folder`) is loaded from where
  it is, as it is. Verifying refuses it, whoever asked for the verification: a folder has no
  signature to check. So does a pin.
- Calling it again for the same scope does nothing. Calling it again with other options throws.
- An app can `use()` several scopes: its own, and a suite's shared one.
- **When the app uses its own scope, its parts are pinned.** If the package that calls `use()`
  is called `scope` and declares parts in its `package.json` (`bundle.parts`, see
  [Parts](#parts)), each part must be installed and be exactly the bytes its hash names, or
  `use()` throws. This needs nothing passed: the pins are read from the app's own
  `package.json`, inside its own archive. See [Pins](#pins).

**`list(scope)`** returns one entry for each plugin in a scope, sorted by name, then package:

```js
list('bled');
// [ { name: '@alice.example/bled-gpio', package: '@alice/bled-gpio', file: '…/plugins/bled/@alice/bled-gpio.nzip',
//     manifest: { name: '@alice/bled-gpio', version: '1.2.0', main: 'index.js', bled: { pins: 40 }, … } },
//   { name: 'https://dl.example.com/gpio-mock.nzip', package: 'gpio-mock', file: '…', manifest: { … } } ]
```

- `name` is what `bundle install --for` was given, as typed: a listing, a URL or a domain. It
  tells a person which install it was, and only identifies: two plugins can share one. A part,
  or a plugin put in a scope by hand, is called by its package name.
- `package` is its package name: what to import.
- `file` is its archive (for a linked folder, the note naming it, and `link` the folder).
- `manifest` is its whole `package.json`, as it is: custom fields an app defines for its
  plugins (`ordner.section`), `main`, `exports` and `bin` included.

Nothing is mounted or run to answer it.

**The layout** is exported too, so no app works it out again: `pluginsDir()`, `scopeDir(scope)`,
`pluginFile(package)` (where in a scope a package's archive is) and `labelFile(archive)` (where
the name it was installed as is kept). `scopeDir()` is where the loader looks: the user's scope
when they have one, else the machine's (`bundle install --system`), never a mix of the two;
`BUNDLE_PLUGINS` or `BUNDLE_ROOT` say exactly where instead.

A plugin is mounted the first time something imports it, with node's own ZIP provider, so
the app runs with `--experimental-vfs`, as every bundle does. The loader itself needs nothing
of the sort to load, and imports nothing heavy. It goes into every host's bundle, so a host
that never verifies carries only it.

### Running a plugin as the program

**`runPlugin(scope, package, argv?, { bin }?)`** runs one plugin as if it were the main program:
what `ordner-suite run auth` is, for a suite of services that are each a part. The scope is
used first if it is not yet, so the app's parts are checked against their pins. Then:

- `process.argv` is what `--vfs-load` would make it: `[node, <the plugin's archive>, ...argv]`.
- Its entry point is loaded: `main`, else the `.` of its `exports`, else `index.js`; or, with
  `bin`, that entry of its `bin`. A CommonJS entry is required and an ES module imported, as
  node decides between them (`.cjs`, `.mjs`, or the package's `type`).
- It returns once the entry has loaded; the program carries on as it would by itself.

Inside it, **`import.meta.url`** (and `__filename`) is the entry's place in the plugin's mount,
`file:///dev/null/vfs/<n>/…`, not the archive's path, which is `process.argv[1]`. So
`new URL('./x', import.meta.url)` finds the plugin's own files, and a worker it starts from
there finds them too.

### Resolution

Plugins come **last**. A bare name resolves as it always would, and only a name nothing else
finds is looked for among the plugins:

1. **Builtins, and the app's own dependencies.** A plugin named `lodash` can never stand in for
   the app's `lodash`, and one named `fs` never for `node:fs`.
2. **Inside a plugin, its own bundled dependencies.**
3. **Inside a plugin, the app.** A name the plugin does not carry is resolved as the app
   module that imported the plugin would resolve it. So a plugin that imports the app's API
   package gets the same instance the app has, not a copy.
4. **The scopes**, in the order `use()` was called. The rest of the specifier is resolved
   against the plugin's `exports`, with the importer's conditions (`import`, `require`,
   `node`, `default`), or against `main` and plain files for a package without `exports`.

`import` and `require` both work, for CommonJS and ES module plugins alike, and a subpath the
plugin does not export fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, as it would in
`node_modules`.

### Workers

Mounts and module hooks belong to a thread. **A worker a plugin starts has its plugins**: a
plugin that imports `worker_threads` gets node's module with one difference, its `Worker`,
which starts a thread with every scope this one has used, with the same options, and every
plugin this one has mounted, mounted at the same place. So, inside a plugin,

```js
import { Worker } from 'node:worker_threads';
new Worker(new URL('./scan.js', import.meta.url));
```

works with nothing to change: `scan.js` is where the plugin has it, its own imports resolve,
other plugins and the app's API resolve as they do in the plugin, and a pinned or verified
plugin is checked again in the worker before anything loads. An app that wants its own workers
to have its plugins imports `Worker` from `@pipobscure/bundle/plugins`, or calls `use()` in the
worker itself.

- node gives each file system a mount point of its own as it is created, counting up in each
  thread, so the worker mounts the plugins in the order the parent did, before its script.
  A worker that has mounted something of its own first cannot, and says so.
- A worker started with `{ eval: true }` is an ordinary worker: node runs it without the module
  loader. So is one started from a thread that has used no scope.
- The `worker_threads` a plugin gets is a module of this package. A host bundle recorded from a
  run in which no plugin imported `worker_threads` does not carry it, and its plugins then get
  node's own: record the host from a run that starts its plugins' workers.

How the worker reaches the app's own files depends on how the app runs:

- under `bundle run`, the `register` preload or a launcher, node mounts the `--vfs-load` source
  in every thread, at the same path;
- in a SEA, the executable sets every worker up as its main thread before the worker's script
  loads (see [design.md](design.md#worker-threads)).

### Verifying plugins as they load

Plugins are checked when they are installed, and `installed` and `validate` check them again,
as they do apps. Checking them **as they load** is opt-in, as it is for apps:

```js
use('bled', { verify: true });                 // under what the runtime and the policy require
use('bled', { verify: {                        // and these as well
    identity: 'https://github.com/bled-dev/plugins/.github/workflows/release.yml@refs/heads/main',
    issuer: 'https://token.actions.githubusercontent.com',
    attesters: ['audited@did:web:bled.dev'], quorum: 1,
    block: ['did:web:scanner.example'],
    ca: certificatePem,
} });
```

| `verify` | |
|---|---|
| `identity` | the sigstore identity every plugin must be signed with |
| `issuer` | the sigstore OIDC issuer every plugin must be signed through |
| `attesters`, `quorum` | attesters (`[kind@]did`) that must have vouched for every plugin, and how many of them |
| `block` | DIDs whose bad verdict refuses a plugin |
| `ca` | a certificate (PEM text, or a path) every plugin's chain must lead to. A requirement, not an extra trusted root |
| `pins` | plugins by package name, each to its whole-file hash (`sha256:<hex>`): see [Pins](#pins) |

**A verifying runtime always verifies.** Under `bundle run`, the `register` preload or a SEA,
`use()` verifies whether it is asked to or not. Whoever chose a verifying runtime asked for
nothing unverified to be mounted in that process, and there is no `verify: false`.

**A plugin is judged as a plugin, not as the app.** It is, almost by definition, written by
someone other than the app's author, so a check that describes the app's author never applies
to it. Its rules come from three places, and all of them hold at once:

| From | What applies to plugins |
|---|---|
| the runtime that verified the app | that a signature is needed (unless attestations vouch); its `attesters` and `quorum`; its `block`. Never its signer identity, its issuer, its extra roots or `--untrusted`: those are about the app's author |
| the policy files' `scopes` section for this app | all of it |
| the app's code: `use(scope, { verify })` | all of it |

Attester groups add up, so each must be met, and blocks add up. A signer required by two
sources must satisfy both, and values that conflict mean nothing loads. Nothing can loosen
another source's rules. Plugins are anchored against the default trust store and any `ca`,
never against the roots the app was checked against. Attestations are checked offline,
against the cache `bundle trust` keeps fresh, so loading never reaches for the network.

**`use()` is where it fails.** With verification, every plugin in the scope is checked before
`use()` returns. If any is refused, none is loaded, and `use()` throws `ERR_BUNDLE_UNTRUSTED`,
whose `refused` lists each plugin's `name`, `file` and `reasons`:

```
ERR_BUNDLE_UNTRUSTED: 2 of 5 plugins for 'bled' were refused, so none are loaded:
  @alice/bled-gpio (…/plugins/bled/@alice/bled-gpio.nzip):
    0 of 1 required attestation: did:web:bled.dev as audited — no attestation of this file (required by this app)
  gpio-mock (…/plugins/bled/gpio-mock.nzip):
    unsigned, and a trusted signature is required (carried over from the runtime)
```

<a id="pins"></a>**Pins.** A plugin the app pins is held to its hash, and to nothing else but blocks: it
must be installed, its bytes must be the ones the hash names and hold together, and then it
needs no signature and no attestation. It is mounted through the provider that checks every
member against its digest as it is read, so a file changed after `use()` checked it is not
served unchecked. Pins come from the app's declared parts, which hold whether or not `verify`
is given, and from `verify.pins`; both must hold, and a plugin pinned to two hashes loads under
neither. The other rules in `verify` apply to the plugins it does not pin. A pin is the app's own
statement, from its own archive or code, which is what makes it enough: unlike a hash read from
this machine's install records, nothing outside the app can move it. Under a verifying runtime
the runtime's verifier checks the pin, and its blocks apply too; otherwise the loader checks it
with nothing but node's own modules, and never loads the verifier.

**Where the verifier comes from.** Under a verifying runtime, it is the runtime's own, so the
code and policy that checked the app check its plugins too. Otherwise the loader loads this
package's verifier the first time `use()` verifies. `bundle create` bundles what the recording
run read, so record a host that verifies its plugins from a run that does.

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
  "./integrity": "an archive's hash and member digests, and nothing to do with signatures",
  "./archive":  "bundling and re-emitting",
  "./files":    "dependency closures",
  "./skill":    "the shipped skills, and installing them",
  "./audit":    "the audit gate: prepare, check, approve",
  "./sigstore": "the sigstore signer and bundle verification",
  "./attestation": "attestation policies, and the cache they are checked against",
  "./policy":   "the machine's install policy file",
  "./review":   "what install and update find, and what they decide",
  "./install":  "install, update, uninstall, installed, validate: the installer, and its records",
  "./atproto":  "resolving DIDs, fetching and writing attestations",
  "./oauth":    "signing in to a PDS: atproto OAuth with PAR, PKCE and DPoP",
  "./lexicon":  "this package's lexicons, and publishing them",
  "./listing":  "listings: publishing, resolving, and the local search index",
  "./suite":    "suites: the record, the spec file, its hash, publishing and resolving",
  "./plugins":  "use(), list(), runPlugin(), Worker: load plugin bundles by package name, pinned or verified",
  "./oidc":     "identity tokens: CI, browser, or device code"
}
```

**`@pipobscure/bundle/integrity`** checks that an archive's bytes hold together, without
anything that has to do with signatures or attestations: `checkIntegrity(source, { deep })`
says whether the hash its comment records is its whole-file hash and, with `deep` (the
default), whether every member is what its digest says, and gives `pin`, the hash as
`<alg>:<hex>`; `pinOf(source)` and `wholeFileHash(source)` give the hash alone. It needs
nothing but node's own modules, where `./manifest` brings in sigstore and the attestation
code. It says nothing about who made an archive; compare `pin` with a hash you trust.

The package root deliberately does **not** re-export the two providers: importing either
needs `node:vfs`, and creating or verifying an archive does not, so `import
'@pipobscure/bundle'` must not drag that requirement in.

Written in TypeScript, published as ESM with declarations. The sources use erasable syntax
only, so `node src/main.ts` runs them directly under Node's type stripping.
