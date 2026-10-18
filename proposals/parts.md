# Parts: an app shipped as the archives it is made of

**Status:** implemented (first cut).
**Author:** Philipp Dunkel

## Summary

An app declares the archives it is made of in its `package.json`, each pinned by its hash:

```json
"bundle": {
  "parts": [
    { "package": "@ordner.fyi/auth", "url": "auth.nzip", "hash": "sha256:3f1a…" },
    { "package": "@ordner.fyi/mail", "url": "mail.nzip", "hash": "sha256:9c04…" }
  ]
}
```

Installing the app installs every part, from beside it, as a plugin in the app's scope.
Each part is trusted because the app is: the pins are inside the app's archive, so whatever
vouches for the app (its signature, an attestation) vouches for exactly these bytes. A part
needs no signature or attestation of its own.

```console
$ bundle install https://ordner.fyi/bundles/suite/suite.nzip
$ bundle install --system https://ordner.fyi/bundles/suite/suite.nzip   # for a server
```

```js
// ordner-suite, `run <service>`: one part, run as the program
import { runPlugin } from '@pipobscure/bundle/plugins';
await runPlugin('@ordner.fyi/suite', `@ordner.fyi/${service}`, args);
```

## Why

The first serious user is a self-hosted suite of about thirty archives: services, a tool, and
plugins (static web apps, DNS providers). It is one product, released together, but each part
is its own package, built and reviewed on its own, and a release usually changes a few of them.

What bundle had did not fit:

- **Thirty installs** means thirty reviews, thirty signers or attestations, and nothing that
  ties a release together. An update could leave half the services on the old release.
- **A suite** (proposals/suites.md) is a set of listings on atproto, each member reviewed as if
  installed by itself. That is right for a toolset assembled from different publishers, and
  wrong for one release of one product: it vouches for nothing, and would still need every part
  signed or attested.

What the suite's operators want is one decision: trust this release of the app, and through it,
everything it is made of.

## Decisions

### The pin is the whole-file hash

`hash` is the part's whole-file hash, `<alg>:<hex>`: what a signature covers, what attestations
name, what `bundle verify` reports and what install records keep. The suite's CI first wrote
the sha256 of the file instead. That is a different value for the same archive, because the
file's hash also covers the EOCD comment: `UNSIGNED:<hash>` on an unsigned archive, and, once it
is signed, the signature and the sigstore bundle. Pinning that would mean:

- a part signed after the app was built no longer matches its pin, though not one member
  changed;
- the hash a part is pinned by is not the hash anything else in bundle calls it, so an
  attestation of a part could not be matched against its pin;
- loading a pinned part would need a second pass over the file, besides the one that checks
  its whole-file hash anyway.

The comment is outside what the pin covers, as it is outside what a signature covers. A part
whose comment claims a signature must still have one that verifies, or it does not hold
together. `bundle parts` prints the list, `bundle create` prints the hash (`sha256:<hex>`), and
`pinOf()` from `@pipobscure/bundle/integrity` computes it.

### `parts`, not `members`

The CI's first draft called them `members`. In bundle that word already means two things: the
files in an archive (`inspectBundle().members`, the per-member digests) and the listings of a
suite. A third meaning, in the one `package.json` field where all three meet, would be one too
many. They are parts.

### In package.json

The app's `package.json` already says what the app asks of an install (`bundle.app`, for an
entry in the desktop's applications), and it is inside the signed archive. A `META-INF` member
would be a second place for the same kind of statement, and a second file every host has to
know about.

### Beside the app, by the same means

Each `url` is resolved against the URL the app was fetched from, so a release is a directory a
CI publishes whole (`…/suite/suite.nzip`, `…/suite/auth.nzip`). It is fetched only by the scheme
the app was: an app from a server cannot name a file on this machine, and an app from a file
(an air-gapped install) finds its parts beside the file. For bytes installed from code, the
`source` they stand for is the base.

### All of them, or none

Every part that is new or changed is fetched and checked first, then the app and its parts are
renamed into place, each over its old file with a second name kept for the old one until all
are in. A failure before that changes nothing, the app included; one during it puts back what
was renamed. Records are written once, after. So no install or update leaves a mix of old and
new parts, short of the machine stopping between two renames, which a set of files in several
directories cannot be guarded against; the next update puts that right.

An app whose parts did not all arrive is not installed. That is stricter than a suite, where
one member refused does not stop the others, and it has to be: the app was released with these
parts, and a service from one release talking to one from another is the failure this exists
to prevent.

### Trusted because the app is

A part is checked for what the pin says and nothing else: it is those bytes, it holds together
(its recorded hash and every member's digest), and it carries the package it is declared as.
That is the evidence "pinned by `<app>`", recorded as `partOf` and the pin. `installed` and
`validate` check it again: the file is the one installed, the app still checks out (someone
accepted for it still vouches for it, the policy still holds), the app still declares the part
with that hash, and the bytes hold together.

A bad verdict from someone the policy blocks on still refuses a part. A block is a positive
claim that those bytes are harmful, and the pin says nothing about that. Only the blocking
attesters are asked: nobody else's verdict could refuse it.

### The policy

`apps.<app>` applies to the app, as to any app. It does not need to apply to the parts: its
requirements are met by the app, and its trust is in the app's signer and attesters.

`scopes.<app package>` does **not** apply to parts. That section is written about plugins
someone other than the app's author wrote, installed with `--for`: the signers and attesters
such a plugin must carry. A part is the app's own, released with it and pinned by it, and asking
it to carry what a third-party plugin must would undo the point. Plugins installed into the same
scope with `--for` are still held to it, at install and at load.

### Beside suites, not part of them

Parts do not extend suites; the two answer different questions. A suite says which separately
published things go together, and vouches for none of them. An app with parts is one published
thing. They are kept consistent where they meet the same problem: a whole's good attestations
count for what it holds, it takes away what it brought, an update adds and removes as the whole
says now, and what it holds is never removed by itself.

### Installed, updated and removed only with the app

A part is a plugin in the app's scope, so the app loads it by package name like any plugin,
and `list()` shows it. But it has no source of its own to follow, so naming it to `update`
updates the app, `uninstall` of a part is refused, and installing a plugin of the same name for
that scope is refused. An app with parts is installed once: a second install of the same
package, under another name, would share its scope and fight over its parts.

### Loading

When the app uses its own scope, `use()` pins its parts with nothing passed: it reads the
`package.json` of the package that called it, and if that package is the scope and declares
parts, each must be installed and be those bytes. The pins come from the app's own archive,
which is what makes them enough. A pinned plugin is mounted through the verifying provider,
which checks each member against its digest as it is read, so a file changed after the check
is not served unchecked. This needs nothing but node's own modules: the loader does not load the
verifier for pins.

## Not doing

- **Parts of parts.** A part that declares parts is refused. One level is what a release is.
- **Parts for a plugin.** Only an app has parts.
- **Partial installs.** See above.
- **Ranges, or parts from elsewhere.** A part is one hash, beside its app.
