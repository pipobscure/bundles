# Changelog

What each release changed. The reasoning behind the project is in [HISTORY.md](HISTORY.md);
how to use it is in the [README](README.md) and [docs/](docs/).

## Unreleased

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
