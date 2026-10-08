# Using `@pipobscure/bundle` from code

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

## Building executables

`@pipobscure/bundle/sea` builds what `bundle sea` builds. `createSeaBase()` makes the
expensive half, a ~155 MB copy of Node with the verifier inside it, and `buildSea()` appends
an application to a base, so one base serves any number of applications.
`@pipobscure/bundle/launch` is the entry point all of it runs through: `run()`, `runSelf()`,
`verify()`, `main()`. `verifySelf()` lets an application report on its own provenance ("signed
by X at Y").

## Plugins: `@pipobscure/bundle/plugins`

```js
import { use, list } from '@pipobscure/bundle/plugins';

use('bled');                                          // the scope: this app's package name
for (const name of list('bled')) await import(name);  // everything installed
use('/opt/bled/plugins');                             // or any directory of plugins
```

**`use(scope, options?)`** makes one scope's plugins resolvable in the calling thread. The
scope is the app's own package name, which is where `install --for` put its plugins. An
absolute path is also accepted, for plugins laid out the same way anywhere else.

- `use()` reads the scope's directory and each archive's `package.json` name. It runs nothing
  and, unless verifying, checks nothing.
- Two archives claiming one name, or an archive with no name, is an error.
- Calling it again for the same scope does nothing. Calling it again with other options throws.
- An app can `use()` several scopes: its own, and a suite's shared one.

**`list(scope)`** returns the package names installed in a scope, for an app that loads
whatever is installed.

A plugin is mounted the first time something imports it, with node's own ZIP provider, so
the app runs with `--experimental-vfs`, as every bundle does. The loader itself needs nothing
of the sort to load, and imports nothing heavy. It goes into every host's bundle, so a host
that never verifies carries only it.

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

Mounts and module hooks belong to a thread, so **each worker calls `use()` itself**, with the
same options. How the worker reaches the app's own files depends on how the app runs:

- under `bundle run` or the `register` preload, node mounts the `--vfs-load` source in every
  thread, at the same path, after the preload has run;
- in a SEA, the executable sets every worker up as its main thread before the worker's script
  loads (see [design.md](design.md#worker-threads)).

Either way, the worker's own plugins are verified exactly as the main thread's are.

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
