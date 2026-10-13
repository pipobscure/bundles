# Changelog

What each release changed. The reasoning behind the project is in [HISTORY.md](HISTORY.md);
how to use it is in the [README](README.md) and [docs/](docs/).

## 0.1.2

- **For now, `bundle suite` writes a plugin into a suite only with its app.** `suite add`,
  `validate` and `publish` refuse a plugin for an app that is not in the suite, and anything for
  a shared scope, while how suites of plugins alone should work is settled. Only the authoring
  commands hold to this: the lexicon, the schema and `install` are unchanged, and a suite
  published otherwise installs as it is.
- **`suite add --for` no longer takes `#` in place of `@`.** 0.1.0 read `--for
  '#<account>/<name>'` as an app's listing. That form was never meant to exist, and is refused
  now: name the app as `@<handle or did>/<name>` or by its `at://` address. Specs written with it
  are unaffected, since a spec stores the listing's address.

## 0.1.0

- **Suites: listings installed together.** A suite names listings, apps and plugins for them,
  and what each must carry: a signer, attesters. `bundle install @<account>/<suite>` installs
  each member as it would be installed by itself. Everyone the suite expects is shown once, and
  whom you accept counts for every member that names them. A member that does not carry what
  the suite requires is refused, and the rest still install. `update` follows the suite as
  members are added and taken out, and `uninstall` removes what it brought and nothing else. A
  new lexicon, `com.pipobscure.bundle.suite`; installed suites are kept in `suites.json`.
- **`bundle suite`** writes a suite as a JSON spec ([schema](schemas/suite.schema.json)).
  `add` fetches each listing, shows what vouches for it, and asks what to require; `remove`
  takes members out; `update` asks again; `validate` checks the spec, and what every member
  serves now, against it; `show`; `publish` and `unpublish`.
- **Suites without atproto.** A URL that serves a suite's JSON rather than an archive installs
  as a suite, and so does a domain whose TXT record is `nsuite:<url>`.
- **Suites can be attested**, by the hash of what they say (`bundle suite attest`). A good
  attestation counts for each member, so an IT department that requires `permitted@<its DID>`
  can permit a whole suite at once. What it says of a bundle itself still wins, and a
  prohibited suite is refused without its bundles being prohibited. The attestation lexicon
  knows the kinds `permitted` and `prohibited`.
- **`update` takes several names** in the API (`update(['a', 'b'])`).

## 0.0.21

- **The listing index syncs a publisher whose listings changed.** Re-indexing deleted their
  old full-text rows, which in SQLite's contentless-delete FTS5 tables writes a tombstone page
  whose row id is past 2^53. `node:sqlite` then refused to report that as a number, so the
  sync failed with "Value is too large to be represented as a JavaScript number" for anyone
  who had published something new since the last sync.

## 0.0.20

- **Rate limits are respected.** A server that answers 429, or 503 with `Retry-After`, is
  asked again once the time it names has passed: `Retry-After`, else atproto's
  `ratelimit-reset`, else a short backoff, up to five times, each wait said on stderr. A wait
  over ten minutes fails at once, saying until when (`BUNDLE_RATE_LIMIT_WAIT` allows more).
  Rekor and the timestamp authority are retried with a backoff.
- **atproto writes are batched, and nothing is read back.** `attest` (and `--revoke`),
  `publish`, `unpublish` and `lexicon publish` write everything a command names in one
  `applyWrites`. `publish` takes several `<name> <url | domain>` pairs, or `--from` a JSON
  file; `unpublish` takes several names. The PDS saying it wrote the records is taken as
  written.
- **`trust` and `validate` fetch attestations together.** Proofs are put together from a
  walk of the repository's tree, a level to a request (`sync.getBlocks`), and checked as
  before. `validate` asks attester by attester rather than install by install, each DID
  document is fetched once per run, and an attester whose repository has not moved since the
  last complete refresh is not asked again.
- **The same files make the same archive.** Members are dated with their files' own times,
  no later than `SOURCE_DATE_EPOCH`; `create --date <ISO 8601>` gives them all one time, and
  warns when the timezone is not UTC. `sign` keeps every member's time.
- **`bundle <command> --help`** prints that command's help (and a subcommand's, for `policy`
  and `lexicon`), reading nothing else on the line; `bundle --help` is a short overview.
- **`install --for` takes an app by its listing**: `@<handle or did>/<name>` or its `at://`
  address, meaning the app installed here from that listing.

## 0.0.19

- **`install --for <app> ./folder` links a plugin for development**: loaded from the folder
  as it is, run with plain node, and refused by anything that verifies plugins.

## 0.0.18

- **`list()` says what is installed**: `[name, package]` for each plugin, where the name is
  what was typed to install it and the package is its `package.json`, reduced to what
  describes it.

## 0.0.17

- **The shape is decided at `create`** (`--launcher`, `--prefix`), and `sign` signs the
  archive as it is. Every bundle is an `.nzip`; unsigned ones record their whole-file hash,
  and `app.unsigned.nzip` signs into `app.nzip`.
