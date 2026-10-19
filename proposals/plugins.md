# Plugins: signed bundles an app loads

**Status:** implemented (first cut).
**Author:** Philipp Dunkel

## Summary

A plugin is a bundle like any other: created, audited and signed the same way. Instead of
being run, it is loaded by a host app, which finds it by its package name through ordinary
`import` and `require`:

```js
import { use, list } from '@pipobscure/bundle/plugins';

use('bled');                                   // this app's plugins, for this thread
const gpio = await import('@alice/bled-gpio'); // ordinary resolution from here on
```

Plugins are installed into a directory that belongs to the host (its **scope**), not onto
the PATH:

```console
$ bundle install --for bled @alice.example/bled-gpio
```

They go through the full install review, the same as an app. Checking them again when they
are loaded is something the host opts into. A plugin is judged as a plugin: the checks that
describe the app's author (its signer, its CA) are never applied to it, and only
attestations and the need for a signature carry over from the app. On top of that, the host
can add rules of its own, but not remove any:

```js
use('bled', { verify: { attesters: ['audited@did:web:bled.dev'] } });
```

## Why this shape

**There is no new format.** A plugin is an archive that holds a package. Its `package.json`
`name` is what the host imports, its `exports` (or `main`) are its entry points, and its own
dependencies are bundled inside it. Plugins are signed as plain archives, with no launcher,
because nothing runs them by name.

**Plugins are found by ordinary resolution.** Today, plugins are usually npm packages in
`node_modules`, found by `require`. Host code written that way keeps working, because the
host resolves plugin names exactly as it resolved the npm packages before. What changes is
where a name is found and what it is.

**Plugins are the host's data, not commands.** A plugin is for one app, so it lives in that
app's scope, not on the PATH. This keeps two apps' plugins from colliding, and stops a
plugin from ever being run as a command.

**Checking at load time is opt-in, as it is for apps.** A `.nzip` run by name is not
verified as it starts. It was checked when it was installed, and runtime verification is
what `bundle run`, the `register` preload or a sealed SEA add. Plugins follow the same
split:

- **At install,** the full review: signature, attestations, policy, and the person's
  decision.
- **After install, outside the process,** `installed` and `validate` re-check every install
  record against its hash, its signers and any new warnings. Plugins are install records,
  so the daily check at shell start covers them with no extra work.
- **At load,** only when the host or the runtime asks for it.

## Installing

`bundle install --for <scope> <url | domain | @account/name>`

- **The scope is the host's package name** (`bled`, `@acme/editor`). It is not the name the
  host was installed as, because that changes with `--name`, and the package name is what
  the host knows about itself at runtime. `--for` also accepts an installed command name,
  and maps it to that install's package name.
- **The directory is per scope,** under the data directory:

  | Platform | Plugins for scope `bled` |
  |---|---|
  | Linux | `$XDG_DATA_HOME/bundle/plugins/bled/` (`~/.local/share/bundle/plugins/bled/`) |
  | macOS | `~/Library/Application Support/bundle/plugins/bled/` |
  | Windows | `%LOCALAPPDATA%\bundle\plugins\bled\` |

  Inside it, each plugin is stored under its package name, laid out as in `node_modules`:
  `@alice/bled-gpio.nzip`, `gpio-mock.nzip`. The installer reads the package name from
  the archive after review. A second archive with the same name in the same scope is an
  update of the first, never a second copy.
- **A plugin is not a command.** It keeps its `.nzip` extension and is not made executable.
  Nothing is added to the PATH, and Windows file associations are not touched.
- **Everything else is reused.** The review is the same, and so is what is remembered as
  accepted. Records are keyed `<scope>:<package name>` (`bled:@alice/bled-gpio`).
  `update` follows each plugin's source (URL, domain or listing). `installed`,
  `validate` and `uninstall` all work on plugins. Uninstalling a host takes its plugins
  with it, since nothing can load them any more, unless another install of the same app
  (the same package, under another name) still loads that scope. A scope no app is
  installed as, such as a suite's shared one, is only ever emptied plugin by plugin.
- **A plugin is installed as its package name.** An update that carries another package
  name is refused: it is a different plugin, not a new version of this one.
- **A folder is linked, for development.** `bundle install --for bled ./bled-gpio` notes
  the folder in the scope (`@alice/bled-gpio.link`) rather than copying anything, and the
  loader loads the plugin from it as it is. A developer can then write and debug a plugin
  against the installed app, without the app's source, by running it with plain node. A
  folder has nothing to verify, so anything that verifies plugins refuses it, which keeps
  links out of every verified run. Installing the plugin replaces the link, and linking
  replaces the installed plugin.

## Loading

`use(scope, options?)` makes one scope's plugins resolvable in the calling thread. Calling it
again for the same scope does nothing. A host can use several scopes: its own, and a suite's
shared one (see [Shared libraries](#shared-libraries)).

`list(scope)` returns `{ name, package, file, manifest }` for each plugin in a scope. `name` is
what `bundle install --for` was given, as typed, kept beside the archive; it tells a person which
install it was, and two plugins may share one. `package` is the package name, what to import,
`file` its archive, and `manifest` its whole `package.json`. A host that loads everything
installed imports each `package`. One that shows its users what is installed has what it needs
to say so, and one that defines fields of its own for its plugins (a section to show it in, a
kind) reads them there.

*First cut:* `list()` gave `[name, package]` pairs, with `package` reduced to an allowlist of
describing fields, so that nothing new would leak out as packages grew fields. In practice the
host is exactly who needs the rest: its own fields, and `main`, `exports` and `bin` to decide
how to run a plugin. A plugin's `package.json` is not a secret from the host that loads it.

The layout is exported with it (`pluginsDir()`, `scopeDir()`, `pluginFile()`, `labelFile()`),
so that no host works out where plugins are on its own.

### Resolution order

A `module.registerHooks()` resolve hook answers the names in a scope. It answers them
**after** everything else, so a plugin can never take the place of something the host
already resolves:

1. **Builtins, and the host's own dependencies,** resolve first, as usual. A plugin named
   `lodash` cannot replace the `lodash` inside the host.
2. **Inside a plugin, the plugin's own bundled dependencies** resolve first, as usual.
3. **If the importer is inside a plugin, the host comes next.** A name the plugin does not
   contain is resolved as if the host had imported it. This is how a plugin reaches the
   host's API as the same instance the host uses.
4. **Then the scopes,** in the order `use()` was called. A name in a scope is mounted (see
   below), and the rest of the specifier is resolved against its `exports`, or `main`, with
   the conditions the importer used (`import`, `require`, `node`, `default`). The hook
   returns the resulting URL itself.

The hook resolves `exports` itself rather than handing the name back to node with a parent
inside the mount. That is what makes `require()` work as well as `import`. Tried against
`node:vfs` on node 27: handing the name back works for `import` but not for `require`;
answering with the URL works for both, for CommonJS and ES module plugins alike, subpath
exports included.

### Mounting

`use()` indexes the scope cheaply: it opens each archive and reads its `package.json` name.
Two archives claiming one name is an error, because guessing between them is not something
a loader should do quietly.

When verification is off, a plugin is mounted on first import with node's built-in
`ZipProvider`, and nothing else is done. That needs only `node:vfs`, so a host that does
not verify carries only the loader.

### Workers

Mounts and module hooks are per thread: a worker does not see the main thread's mounts
(also tried). So a worker a plugin starts from its own archive,
`new Worker(new URL('./scan.js', import.meta.url))`, found nothing at that URL, and a plugin
with a worker pool (a virus scanner, a mail filter) could not have one.

The loader closes that for plugins. The resolve hook answers `worker_threads`, imported from
inside a plugin, with node's module and one difference: its `Worker`, which starts a thread with
every scope the current one has used, with the same options, and every plugin it has mounted,
mounted at the same place, before the worker's script runs. node numbers mount points per
thread as file systems are created (`/dev/null/vfs/<n>`), and takes no say in where one goes, so
the worker creates them in the same order, filling the gaps, and checks it got the same place.
A pinned or verified plugin is checked again there. The worker starts from a small `data:`
module that imports the loader, sets the thread up, and imports the worker's script, so nothing
is added to its environment, its `workerData` or its argv.

- An app that wants its own workers to have its plugins imports the same `Worker` from
  `@pipobscure/bundle/plugins`.
- A worker that has mounted something of its own first cannot have the same places, and its
  setup says so.
- `new Worker(code, { eval: true })` is left alone: node runs it without the module loader.

A worker can still set itself up instead, with the same `use()`:

```js
// worker.js
import { use } from '@pipobscure/bundle/plugins';
use('bled', { verify: true });
const gpio = await import('@alice/bled-gpio');
```

Each thread mounts, and if asked, verifies, on its own. Verifying in every thread is what
per-thread mounts cost.

## Verification

```js
use('bled');                    // whatever the process does
use('bled', { verify: true });  // verify, under what carries over (see below)
use('bled', { verify: {         // verify, under what carries over, and these
    identity: 'https://github.com/bled-dev/plugins/.github/workflows/release.yml@refs/heads/main',
    issuer: 'https://token.actions.githubusercontent.com',
    attesters: ['audited@did:web:bled.dev'], quorum: 1,
    block: ['did:web:scanner.example'],
    ca: certificatePem,          // must chain to this
} });
```

### Plugins are judged as plugins, not as the app

A plugin is, almost by definition, written by someone other than the app's author. So a
check that describes **who made the app** says nothing about a plugin, and is never applied
to one. These come from the app and stay with it:

- the signer identity and issuer the app had to be signed by (`--identity`, `--issuer`, a
  sealed SEA's built-in policy);
- the extra trusted roots it was checked against (`--root`, `BUNDLE_ROOTS`), and
  `--untrusted`, which accepted the app's unanchored chain;
- everything in the policy file's section for the app (`apps.bled`).

What carries over is what holds whoever the author is: **attestations, and that it must be
signed.** A runtime that requires attesters, a quorum or blocks for the app requires the
same of each plugin. A runtime that would not mount an unsigned app will not mount an
unsigned plugin either, unless the attestations it requires vouch for it, as for an app.

A plugin's signature is anchored against the default trust store, and against the `ca` the
host or the scope names, never against the roots the app was checked against.

### Where a plugin's rules come from

| Source | What applies to plugins |
|---|---|
| The runtime that verified the app: `BUNDLE_*`, a sealed SEA | that a signature is required; `attesters` and `quorum`; `block` |
| The policy files' section for the scope: `"scopes": { "bled": { … } }` | all of it. It is written about these plugins: signers, issuers, `ca`, attesters, blocks |
| `use()`: `verify: { … }` | all of it. The host's statement about its plugins |

All of them apply at once. Attester groups add up, so each must be met. Blocks add up.
Signer requirements from the scope and from code must both hold; values that conflict mean
nothing loads, and the error says why. Code can add to what carries over and to what the
scope requires, but not take anything away from either. There is no way to ask from code for
a plugin to be judged by less than that.

The scope's section is also what `bundle install --for bled` uses, next to the policy's
global rules. The app's own `apps.bled` section does not apply to plugins at install either,
for the same reason.

There is no `verify: false`. When the process is already verifying, because the host runs
under `bundle run`, the `register` preload or a SEA, its plugins are verified with whatever
carries over, whatever `use()` says. Whoever chose a verifying runtime asked for nothing
unverified to be mounted in that process. A loader that mounted plugins with the plain
provider anyway would undo that without anyone noticing. So the default is whatever the
process does, and `verify` only turns checking on or adds to it.

Attestations are checked offline, against the cache `bundle trust` keeps fresh, as mounts
already are. Loading never reaches for the network.

### `use()` is where it fails

With verification on, `use()` verifies every plugin in the scope before it returns, and
throws if any is refused. A host that opted in then has one place to handle failure, at
startup, instead of a failed `import` at some later point. The error says everything at
once:

```
ERR_BUNDLE_UNTRUSTED: 2 of 5 plugins for 'bled' were refused, so none are loaded:
  @alice/bled-gpio (…/plugins/bled/@alice/bled-gpio.nzip):
    requires attestations from audited@did:web:bled.dev (required by this app): no attestation of this file
  gpio-mock (…/plugins/bled/gpio-mock.nzip):
    unsigned, and the runtime requires a signature (carried over from the runtime)
```

Each reason names the rule that failed and where it came from: carried over from the
runtime, the scope's section of the machine's or the user's policy, or "required by this
app". It also points at the file, so whoever runs the host knows what to remove or update.

With verification off, there is nothing to evaluate. `use()` only indexes, and fails only
for an index it cannot build: a duplicate name, or an archive that does not open.

Where the verifier comes from: if the process runs under a verifying runtime, `use()` uses
that one. Otherwise it loads this package's own verifier, the first time it verifies. A host
whose bundle was recorded from a run that never verified does not carry it, and gets an
error saying exactly that, rather than an unverified mount.

### Under a SEA

A SEA's bootstrap is what loads the verifying mounter, so plugins in its main thread are
verified with no extra work. Workers turned out to need more than the flag this section first
proposed, because node starts a SEA's worker with nothing mounted. That means neither the
executable's own file system nor the application the main thread mounted, so the worker's
script, a path into that application, does not even resolve. Nothing of ours runs in the
worker unless the executable arranges it.

It does, with node's own means. The executable's `execArgv` carries an `--import` preload,
and every thread inherits `execArgv`. In the main thread the preload does nothing. In a
worker it:

1. mounts this package out of the executable (`node:sea` hands any thread the embedded
   archive),
2. verifies and mounts the container the main thread did, under the same policy, at the same
   path, which also installs the plugin verifier,

before the worker's script loads. The main thread passes on what it mounted in
`BUNDLE_SEA_THREAD`, a copy of which every worker inherits. A self-validating executable's
workers run only its own application, whatever that says, and a sealed runtime's policy holds
over it.

Classic inline workers (`new Worker(code, { eval: true })`) are the gap. Node runs them
without the ESM loader, so without preloads. They get nothing mounted, which means they can't
load the application's modules or this loader, so nothing unverified runs through them. If
node mounted a SEA's archive in every thread, as it does the `--vfs-load` source since
nodejs/node#66162, the preload could live in that archive, and this gap would close too.

Under `bundle run` and the `register` preload, workers need none of this. They inherit the
preload, and node re-mounts the `--vfs-load` source in them at the same path after it has
run.

## Listing plugins

A plugin can be listed, like an app ([proposals/atproto-listings.md](atproto-listings.md)),
but against its app: its listing's `subject` is the `at://` address of the app's listing,
instead of the concept hash every app's listing carries.

```console
$ bundle publish --as alice.example --for @pipobscure.com/bled bled-gpio https://…/bled-gpio.nzip
$ bundle search --for bled gpio
$ bundle install @alice.example/bled-gpio
```

- **Plugins never appear among apps.** The backlink index is asked what links to the concept
  hash for apps, and what links to an app's listing for its plugins.
- **The index follows only the plugins of apps installed here** from a listing, plus the
  one `--for` names. Plugins for apps nobody here has are never fetched.
- **A plugin listing installs into its app's scope, with or without `--for`.** It names the
  app's listing, so it goes into the app installed here from that listing, and a `--for`
  given must name that app. If no app here came from that listing, it is refused, with how to
  install the app first. An app installed some other way (from a URL or a domain) is named
  with `--for`: then the person naming the scope is the one who knows. An app installed from
  its listing more than once, as different packages, is also `--for`'s to pick.
- **A link to a plugin's listing installs it too.** `nzip:alice.example/bled-gpio` is
  `bundle install @alice.example/bled-gpio`, in a window, like any link. It may say the app,
  `?for=bled`, with what `--for` takes that a page can know (a package name, or an app's
  listing), read strictly, and checked against the listing exactly as `--for` is. It places
  a plugin's listing and nothing else.

  *First cut:* a plugin listing installed only with `--for`, to make the person say where it
  went. But when its app was installed from its listing, `--for` could only ever name that
  one scope; anything else was refused. Asking for it added nothing but a step, and it made
  links to plugins impossible: a page cannot know what the app is called here, and a link that
  installs differently from the command it stands for would be a second set of rules. Where
  the listing does not settle it, `--for` is still required.
- **An app installed from a URL or a domain has no listing for plugins to name.** It can
  still have plugins, installed with `--for` from a URL or a domain. They are just not
  listed or searchable.

## Shared libraries

A suite of apps that shares code installs it into a shared scope:

```console
$ bundle install --for @acme/suite @acme.dev/suite-core
```

Each app in the suite calls `use('@acme/suite')` in addition to its own scope. Because
scopes come last in resolution, every app gets the one installed copy, and none can be
overridden by a plugin.

That is as far as it goes, deliberately. This is not a way to bundle npm packages one at a
time:

- **One version per name per scope.** There are no version ranges and no dependency
  resolution.
- **Bundles are written to be loaded.** A bundle in a scope is a plugin, or a suite library
  with an API of its own, never a re-wrapped third-party package. Third-party code stays
  bundled inside whatever uses it.
- **Dependencies are not installed automatically.** A missing shared bundle is a failed
  import whose message names the `bundle install --for …` that provides it.

## Where the code lives

- **`@pipobscure/bundle/plugins`** (`src/plugins.ts`) is what a host imports: `use()`,
  `list()`, the resolve hook, and mounting with the built-in provider. Scope directories
  are in `src/scopes.ts`. It is part of this package rather than a package of its own. On a
  development machine the tool is there anyway, and `bundle create` bundles only the files
  the recording run read. So a host that never verifies carries only the loader. That
  makes the loader's imports part of its contract: nothing heavy, and nothing that needs
  `--experimental-vfs` to load. A test holds it to that.
- **`src/plugin-verifier.ts`** is the verifying half: policy merging, `ca`, and mounting
  through the verifying provider. A verifying runtime leaves its own verifier on the global
  object, and the loader prefers that one, so the code and policy that checked the app check
  its plugins too. Otherwise the loader loads this module the first time `use()` verifies.
  It needs no import of its own: an installed app run by name has no verifying runtime, so
  `verify` must work from what the app's own bundle carries. A host recorded from a run that
  verifies carries it.
- **`bundle install --for`** and the per-scope policy sections belong to this package's
  install and policy code.

## Pins

A plugin the host pins by hash is held to that hash, at every load, whether or not the host
asked to verify: it must be installed, be the bytes the hash names (the whole-file hash,
`sha256:<hex>`), and hold together; it is then mounted through the verifying provider, which
checks each member as it is read. It needs no signature and no attestation.

```js
use('@ordner.fyi/suite');                                         // its parts, from its package.json
use('bled', { verify: { pins: { '@alice/bled-gpio': 'sha256:…' } } });   // or named in code
```

The host's own parts ([parts.md](parts.md)) are pinned with nothing passed: when the package
that calls `use()` is the scope and declares parts, they are read from its `package.json`.

Pins are not the `verify: 'hash'` rejected below. That was a hash from this machine's install
records, which the loader would have had to trust, and which anything that can write them can
move. A pin is the host's own statement, from its own archive or its own code, covered by
whatever vouched for the host. It is also why a pin is enough under a verifying runtime that
requires attestations: the host it comes from was verified under them, and says these exact
bytes. Blocks still apply, the runtime's and the host's: a block is a claim that bytes are
harmful, which no pin answers. A plugin pinned twice, to two hashes, loads under neither. The
host's other rules apply to the plugins it does not pin.

Without a verifying runtime, pins are checked by `plugin-pinned.ts`, which needs nothing but
node's own modules, so a host that pins its parts carries no sigstore and no atproto code.

## System-wide scopes

A server installs for everyone, and its services run as users of their own: `bundle install
--system` (or `BUNDLE_ROOT=<dir>`) puts apps, plugins, state and caches under one root, beside
the machine's policy file, and reads the same policy files as always.

The loader finds a scope in one place, never two: where this process installs plugins
(`BUNDLE_PLUGINS`, `BUNDLE_ROOT`, or the user's own directory) when the scope is there, or when
either variable says where to look; otherwise the machine's, when the scope is there. The
question this section's earlier "not doing" raised, which comes first, has that answer: the
user's whole scope, or the machine's whole scope, never a mix. Who updates it: whoever installed
it, with the same flag.

## Not doing

- **Verification by default.** As for apps, it is opted into. Pins are checked always, since
  they are the host's own.
- **Applying the app's signer, roots or `apps` section to its plugins.** They describe the
  app's author.
- **A host's minimum policy in its own `package.json`.** It would let `install --for`
  refuse a plugin `use()` would later refuse. But `use()` already enforces it with a clear
  error, and two places for one policy is how the two drift apart.
- **`verify: 'hash'`,** a check against the install record's sha256. It would catch any
  change since install without sigstore, but it would tie the loader to this machine's
  install records. `installed` and `validate` already do that check, outside the process.
- **Version ranges, automatic dependencies, a global search path.**
- **Verifying only some of a scope** (`use(scope, { verify, only: [...] })`). `use()`
  reads one directory, so verifying all of it is only slow with a very large number of
  plugins. And plugins are what the app's author did not foresee, so a host naming which
  ones to load would defeat the point of having them.
