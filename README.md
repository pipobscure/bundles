# bundle

**Ship a Node.js app as one signed file, and install other people's apps knowing exactly what
you are getting.**

```sh
bundle create --base ./app --files app.manifest --launcher --output app.unsigned.nzip   # pack your app
bundle sign app.unsigned.nzip                                                          # sign it: app.nzip
./app.nzip                                                                             # and it is a program
```

A bundle is your application, every module and dependency it uses, in one file, with a
signature over the whole thing. There is no `npm install` on the machine that runs it, nothing
resolved from a registry at the last minute, and nothing that can change after you signed it.
Node runs the app straight out of the file.

> **Needs Node 26.11.1 or later**, run with `--experimental-vfs`. Everything here, Node's
> support included, is experimental.

## What you can do with it

- **Ship an app as one file.** A file you can run by name, a standalone executable with Node
  built in, or an archive to mount. Built once, signed once.
- **Install apps safely.** `bundle install` takes a URL, a domain, or a name someone
  published, shows you everything that vouches for what it fetched, and asks you before it
  trusts anyone new. Nothing runs to install it.
- **Know who vouches for what.** Signatures say who built it. Attestations let others vouch
  for it ("I audited this", "I rebuilt it and got the same bytes") or warn against it.
- **Find apps.** Publish your app under a name; anyone can `bundle search` for it and install
  it by that name.
- **Keep everything current.** `bundle update` follows each app to its new releases, and a
  quiet check at shell start tells you when someone has flagged something you installed.
- **Let your app take plugins** that are signed bundles too, installed per app, and checked as
  they load if you want.

## Contents

- [Install bundle](#install-bundle) · [Installing apps](#installing-apps) · [Finding apps](#finding-apps)
- [Shipping your own app](#shipping-your-own-app) · [Standalone executables](#standalone-executables)
- [Deciding whom you trust](#deciding-whom-you-trust) · [Plugins](#plugins)
- [Commands at a glance](#commands-at-a-glance) · [From code](#from-code) · [Learn more](#learn-more)

## Install bundle

```sh
curl -LO https://github.com/pipobscure/bundles/releases/latest/download/bundle.nzip
node --experimental-vfs --vfs-load ./bundle.nzip install
```

The download runs once, to install the real thing: it fetches the latest release, checks its
signature, and puts the signed `bundle` on your PATH, where `bundle update` keeps it current.
It also offers to add Tab completion and a quiet daily re-check of your installs to your
shell. Afterwards, `bundle --help`.

The `bundle` command is itself a bundle: `unzip -l` lists everything in it, and
`bundle verify` tells you who signed it. Releases are signed by this repository's
[publish workflow](.github/workflows/publish.yml).

## Installing apps

```sh
bundle install https://example.com/tool.nzip     # from a URL
bundle install tool.example.com                 # from a domain: its TXT record says where
bundle install @alice.example/tool              # from a name someone published
```

Before anything is put on your PATH, `bundle install` shows you what vouches for it:

```
* tool: sha256:3f1a… (signed)
   1 signed by   https://github.com/acme/tool/.github/workflows/release.yml@refs/heads/main — new
   2 attested by audit.acme.com (did:web:audit.acme.com) as audited — trusted by policy
     WARNING     scanner.example (did:plc:…) as malware — marked it bad
* tool: … accept which? numbers (1,2), 'all', or Enter to decline:
```

Anyone you have accepted before, or that your [policy](#deciding-whom-you-trust) trusts, goes
through without a question. Anyone new is your call, and your answer is remembered for later
updates. Archives that don't verify are refused outright, and so is anything a rule of yours
demands and doesn't get. Nothing runs to install it: the file is fetched, checked, and moved
into place.

Afterwards:

```sh
bundle update                 # every install, following each to its new release
bundle installed              # what is installed, and whether it is still what you installed
bundle validate               # what has been attested, or warned about, since
bundle uninstall tool
```

An install remembers how it was installed, by URL, domain or published name, and `update`
asks that again. So when a publisher moves their releases, your install moves with them.

**Running an app by name does not check it**, because a `#!` launcher has no way to.
`bundle run app.nzip` runs it through the verifying mount, and a
[standalone executable](#standalone-executables) checks itself.

## Finding apps

```sh
bundle search markdown preview       # every word must match
bundle listings                      # everything published
```

Search runs against a local index of everything published, kept in step with the network.
The first column is what `bundle install` takes.

## Shipping your own app

Four steps, in this order:

```sh
# 1. observe: run your app once, writing down every file it reads
BUNDLE_MANIFEST=app.manifest node --experimental-vfs -r @pipobscure/bundle/record --vfs-load=./app -- <args>

# 2. create: archive exactly those files, behind a launcher so it runs by name
bundle create --base ./app --files app.manifest --launcher --output app.unsigned.nzip

# 3. audit: review it, against your last release if there is one
bundle audit --baseline last-release.nzip app.unsigned.nzip

# 4. sign: only once the review came back clean
bundle audit --check app.unsigned.nzip && bundle sign app.unsigned.nzip     # -> app.nzip
```

- **Every bundle is an `.nzip`, signed or not.** An unsigned one still records its own hash,
  and others can vouch for it with attestations. Call it `app.unsigned.nzip` while you have
  both: `bundle sign` writes `app.nzip` next to it. Any other name is signed in place.
- **The shape is decided when you create it, so it gets reviewed.** `--launcher` makes a file
  you run by name. The launcher is a little shell script that runs first, so the audit shows
  it, and signing keeps it exactly as reviewed.
- **Observing beats guessing.** Dynamic `require`, data files and conditional imports are
  exactly what static analysis misses, and exactly what a run reads.
- **The audit is a gate you choose.** `bundle skill` installs a
  [Claude Code](https://claude.com/claude-code) skill that reads every file in the archive,
  and `bundle audit --check` refuses to let signing go ahead without a clean verdict over
  exactly those bytes. Or read it yourself and `bundle audit --approve`.
- **Signing uses sigstore by default**: your CI's identity, or a browser sign-in. There is
  no key to keep or lose. Your own certificate authority works too (`--key`, `--chain`).

Each way of shipping is its own archive, created in its shape, reviewed, then signed:

```sh
bundle create … --launcher --output app.unsigned.nzip   # a file you run by name
bundle create …            --output app.unsigned.nzip   # a plain archive, to mount
bundle sea --output app.unsigned app.unsigned.nzip      # a standalone executable (see below)
```

**Publish it.** Put the `.nzip` somewhere stable, such as a GitHub release's
`latest/download` URL, and give it a name others can find:

```sh
bundle publish --as you.example --description 'what it does' tool https://github.com/you/tool/releases/latest/download/tool.nzip
```

People then `bundle install @you.example/tool`, and a new release is just a new GitHub
release. If you would rather manage the URL in DNS, publish a domain instead, whose TXT record
`nzip:<url>` says where it is. And if you vouch for releases separately, `bundle attest`
records that.

## Standalone executables

```sh
bundle sea --output tool.unsigned \
    --identity 'https://github.com/you/tool/.github/workflows/release.yml@refs/heads/main' \
    --issuer https://token.actions.githubusercontent.com \
    tool.unsigned.nzip
bundle sign tool.unsigned          # -> tool
./tool --help
```

`bundle sea` builds one file containing Node, the verifier and your app. It is built
unsigned, so you can review it as it will run, and refuses to run until `bundle sign` signs
the whole thing. Then it checks its own signature before running anything, needs nothing
installed, and can carry its own rules for whom it accepts. Worker threads work as usual. Built without an app, it is
a **verifying node**: `./node-verifying app.nzip` checks any archive and runs it.

## Deciding whom you trust

The rules your machine installs by live in a policy file. `bundle policy init` writes a
starting point, and `bundle policy` shows what is in force:

```jsonc
{
  "require": { "attesters": ["audited@did:web:audit.acme.com"] },   // must have vouched
  "trust": { "attesters": ["did:web:audit.acme.com"] },             // accepted without asking
  "block": ["did:web:scanner.example"]                              // their warning refuses it
}
```

Anyone with an atproto (Bluesky) account can attest: vouch for an archive, warn against it,
or withdraw that. `bundle attest --as you.example --kind audited app.nzip` is one sign-in in
the browser, and the record lives in your own account. `bundle trust` keeps the cached
attestations fresh for checks that can't reach the network.

## Plugins

Apps can take plugins that are bundles too: signed, installed per app, and loaded by package
name through ordinary `import`.

**Installing plugins for an app:**

```sh
bundle search --for bled gpio                         # plugins published for bled
bundle install --for bled @alice.example/bled-gpio    # or from a URL or a domain
```

A plugin goes into a directory of the app's own, never onto your PATH. It is reviewed like
any install, and it is removed with the app.

**Loading plugins in your app:**

```js
import { use, list } from '@pipobscure/bundle/plugins';

use('bled');                                          // this app's plugins
const gpio = await import('@alice/bled-gpio');        // ordinary import from here on
for (const [, pkg] of list('bled')) await import(pkg.name);  // or everything installed

use('bled', { verify: { attesters: ['audited@did:web:bled.dev'] } });   // and check them as they load
```

`list()` gives `[name, package]` for each plugin. `name` is what was typed to install it
(`@alice.example/bled-gpio`, a URL, a domain), and `package` is what its `package.json` says
about it (name, version, description, license and the like, never its scripts, entry points or
dependencies). That is enough to tell your users what is installed, and where it came from.

A plugin can never replace something your app already has, and it gets your app's own
modules when it imports them. Each worker thread calls `use()` itself. The full API is in
[docs/api.md](docs/api.md#plugins-pipobscurebundleplugins).

**Writing a plugin:** it is a package, and its `package.json` `name` is what apps import.
Build and sign it like an app, but as a plain archive, without `--launcher`, and publish it
for the app it extends:
`bundle publish --for @pipobscure.com/bled bled-gpio <url>`.

## Commands at a glance

| Building and signing | |
|---|---|
| [`create`](docs/cli.md#create) | build an unsigned archive from a list of files |
| [`audit`](docs/cli.md#audit) | report what is about to be reviewed, and gate signing on the verdict |
| [`sign`](docs/cli.md#sign) | sign an archive into a new file, optionally behind a launcher or a binary |
| [`sea`](docs/cli.md#sea) | build a node runtime that verifies an archive before running it |

| Checking and running | |
|---|---|
| [`verify`](docs/cli.md#verify) | verify an archive and report its trust state |
| [`run`](docs/cli.md#run) | verify an archive, mount it, and run what is inside |

| Vouching | |
|---|---|
| [`attest`](docs/cli.md#attest) | vouch for archives from an atproto account, warn against them, or withdraw that |
| [`lexicon`](docs/cli.md#lexicon) | show, check or publish the atproto lexicons attestations and listings are written in |

| Publishing and finding | |
|---|---|
| [`publish`](docs/cli.md#publish) | list an archive's URL under a name, so others can find and install it |
| [`unpublish`](docs/cli.md#unpublish) | take a listing down again |
| [`search`](docs/cli.md#search) | search the listed archives by name, description and publisher |
| [`listings`](docs/cli.md#listings) | every listed archive, from a local index kept in step with the network |

| Installing and keeping current | |
|---|---|
| [`install`](docs/cli.md#install) | fetch an archive from a URL, a domain or a listing, review it, and put it on your PATH |
| [`update`](docs/cli.md#update) | refetch what was installed, and replace it if a new version is accepted |
| [`installed`](docs/cli.md#installed) | list what is installed, and re-check each against its record |
| [`validate`](docs/cli.md#validate) | re-check installs, and say what has been attested since |
| [`uninstall`](docs/cli.md#uninstall) | remove an install, and forget where it came from |

| Trust and policy | |
|---|---|
| [`trust`](docs/cli.md#trust) | refresh the sigstore trust root and the cached attestations |
| [`policy`](docs/cli.md#policy) | show, start or check the rules this machine installs by |

| Setting up | |
|---|---|
| [`shell`](docs/cli.md#shell) | print what to load at shell start: Tab completion, and a quiet re-check |
| [`skill`](docs/cli.md#skill) | install the bundle-auditing skill into a project |

Every command and every option is in the [command reference](docs/cli.md).

## From code

Everything the CLI does is an API: `createBundle`, `signBundle`, `verifyBundle`,
`runBundle` and more, plus the plugin loader. See [docs/api.md](docs/api.md).

```sh
npm install @pipobscure/bundle
```

## Learn more

- **[docs/cli.md](docs/cli.md)**: every command and option, where files live, environment
  variables.
- **[docs/api.md](docs/api.md)**: the library, the plugin loader, and the package's exports.
- **[docs/design.md](docs/design.md)**: how it works and why: the archive format, what is
  signed, the verifying mount, executables, and the trust model.
- **[HISTORY.md](HISTORY.md)**: why this exists, and what it took in Node.
- **[proposals/](proposals/)**: the design notes behind attestations, listings and plugins.
- **[examples/](examples/)**: example applications, built and signed this way.
- **[slides/](slides/)**: two talks. *Ship the Tree* is the technical one, and the meetup talk
  is about what it can do for you.

## License

[EUPL-1.2](https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12)
