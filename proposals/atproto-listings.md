# Listings: finding bundles, over atproto

**Status:** implemented (first cut)
**Author:** Philipp Dunkel

## Summary

A publisher lists a bundle with a record in their own repository. The record says only
where the bundle lives:

```
at://did:plc:…/com.pipobscure.bundle.listing/bled
{
  "$type":       "com.pipobscure.bundle.listing",
  "subject":     "sha256:aa2e2af5c7e057ae771b9c28543044546b9107216418fbb511d1353fd55c1169",
  "url":         "https://github.com/pipobscure/bled/releases/latest/download/bled.nzip",
  "title":       "bled",
  "description": "…",
  "createdAt":   "2026-10-07T12:00:00.000Z"
}
```

Anyone can then install it by account and name, and find it by searching:

```console
$ bundle publish --as pipobscure.com --description '…' bled https://github.com/…/bled.nzip
$ bundle search bled
$ bundle install @pipobscure.com/bled
```

## Why this shape

**The record points at a URL, not at a release.** It has no hash and no version. A
`releases/latest/download/…` URL keeps working as releases are cut, so publishing a new
version is still just the GitHub release the publish workflow already makes. Nothing
needs to be written to atproto per release. The listing is written once, and again only
when the title, description or URL change.

**A domain can stand in for the URL.** A publisher who already manages their URL with an
`nzip:` TXT record lists the domain instead (`"domain": "bled.pip.fyi"`). The listing
then follows the TXT record wherever it points: install resolves the listing and then the
domain, and update asks both again. A listing names exactly one of `url` and `domain`.

**A listing confers no trust.** It says where to fetch from, the way an `nzip:` TXT
record does, and nothing more. What comes back is reviewed exactly as a URL install's
would be: the signature, the signer identity recorded at install, attestations and the
policy. Anyone can list anyone's URL under their own name. That is harmless, because
`@alice.example.com/bled` pointing at pipobscure's release still installs bytes signed by
pipobscure's workflow, and the review says so.

**Bundles are not hosted on a PDS.** A PDS holds the claim; the bytes stay wherever the
publisher already serves them.

## The concept hash

Every listing carries the same `subject`: the sha256 of the NSID
`com.pipobscure.bundle.listing`, written `sha256:<hex>`. The value is the same in every
listing, so it stands for "a bundle listing" as a concept.

That gives Constellation something to index. It indexes every record field that parses
as a URI, and `sha256:<hex>` already does: attestation discovery depends on it. So

```
blue.microcosm.links.getBacklinks
  ?subject=sha256:aa2e2af5c7e057ae771b9c28543044546b9107216418fbb511d1353fd55c1169
  &source=com.pipobscure.bundle.listing:subject
```

returns every listing on the network, as `(did, collection, rkey)`, without any service
of our own. The NSID is hashed rather than a random constant chosen, so anyone can derive
the value from the lexicon alone.

The `url` field is indexed for free as well. A URL install can ask which listings name
that URL, and show `listed as @pipobscure.com/bled`.

## The lexicon

It lives under the same authority as attestations, so `bundle lexicon publish` covers it with
no new DNS record. The display field is `title` rather than `name`, because the record key
already is the name.

[`lexicons/com/pipobscure/bundle/listing.json`](../lexicons/com/pipobscure/bundle/listing.json):

```json
{
  "lexicon": 1,
  "id": "com.pipobscure.bundle.listing",
  "defs": {
    "main": {
      "type": "record",
      "description": "A bundle the repository's owner makes available under a name: the record key, which is also what it installs as. It is an app, or a plugin for one, as its subject says. The record says only where the bundle is fetched from — a url, or a domain whose 'nzip:' TXT record names one, exactly one of the two. It vouches for nothing, and whatever is fetched is verified like any other download.",
      "key": "any",
      "record": {
        "type": "object",
        "required": [
          "subject",
          "createdAt"
        ],
        "properties": {
          "subject": {
            "type": "string",
            "format": "uri",
            "description": "For an app: 'sha256:aa2e2af5c7e057ae771b9c28543044546b9107216418fbb511d1353fd55c1169', the sha256 of this lexicon's NSID, the same in every app's listing, so that a backlink index can enumerate every app listed on the network. For a plugin: the at:// address of the listing of the app it is for, so that the backlink index finds an app's plugins, and never lists them among apps.",
            "maxLength": 2048
          },
          "url": {
            "type": "string",
            "format": "uri",
            "description": "Where the bundle is fetched from: an https URL, expected to stay the same across releases. Exactly one of url and domain.",
            "maxLength": 2048
          },
          "domain": {
            "type": "string",
            "description": "A domain whose 'nzip:<url>' TXT record says where the bundle is fetched from, so the publisher manages the URL in DNS: lowercase, no trailing dot. Exactly one of url and domain.",
            "maxLength": 253
          },
          "title": {
            "type": "string",
            "description": "A display name; the record key stands in when it is absent.",
            "maxLength": 640,
            "maxGraphemes": 64
          },
          "description": {
            "type": "string",
            "description": "What the bundle is, in a sentence or two.",
            "maxLength": 3000,
            "maxGraphemes": 300
          },
          "createdAt": {
            "type": "string",
            "format": "datetime",
            "description": "When the bundle was first listed, by the publisher's clock."
          }
        }
      }
    }
  }
}
```

The record key is the install name. Lexicon cannot constrain an `any` key further, so the
tool does: lowercase `[a-z0-9][a-z0-9-]*`, at most 64 characters. That matches what is
safe as a file name on every platform `install` supports. A record with any other key is
ignored.

## Installing

`bundle install @<handle or did>/<name>`. The `@` separates it from the other two forms:
a URL has a scheme, and a bare domain is an `nzip:` alias.

1. Resolve the handle to a DID, checked both ways, as attesters are.
2. Fetch `com.pipobscure.bundle.listing/<name>` from that DID's PDS with
   `com.atproto.sync.getRecord`, and verify the proof against the DID's `#atproto` key.
   This is the same path attestations take.
3. Take its `url`, or resolve its `domain`'s `nzip:` TXT record to one. Check that it is
   `https:`, then install from it exactly as `bundle install <url>` would. It installs as
   `<name>` unless `--name` says otherwise.

**An install remembers how it was made, not only where it came from.** `InstallRecord`
gains `source`: the URL; the domain whose `nzip:` record named one; or
`at://<did>/com.pipobscure.bundle.listing/<name>`, which stores the DID, never the
handle, for the usual reason. `url` becomes where it was last fetched from. Older records
read as `alias ?? url`. `update` asks the source again first, a TXT record as much as a
listing, so a publisher who moves their releases moves every install with them. Then it
makes the usual conditional request, with the ETag only when the URL is the one it
belongs to. A source that cannot be asked, or a listing that has been taken down, is
reported, and the URL it last named is checked instead: the bytes are verified either
way, so that falls back to nothing new. `uninstall @<did>/<name>` finds an install by its
listing.

## The local index

Listings are read from a local SQLite index, `listings.sqlite` in the state directory
next to `installed.json`. Syncing keeps it current with as few requests as possible.
`node:sqlite` is built in and has FTS5, so the index adds no dependency and still fits in
a single-file bundle.

### Syncing

Constellation can say which listings exist, but not when one has changed: the concept
hash never changes, so editing a listing leaves its backlink exactly as it was. Changes
are found per publisher instead, from the revision of their repository.

1. **Enumerate.** Page through the backlinks to the concept hash, 100 a page, and keep
   the distinct DIDs. This is the only full pass, and it costs one request per 100
   listings. It is also how deletions are noticed: a DID that no longer appears has no
   listings left.
2. **Check what moved.** For each DID, ask its PDS for `com.atproto.sync.getLatestCommit`.
   If the `rev` is the one already recorded, nothing in that repository has changed since
   the last sync, and nothing more is fetched.
3. **Refetch what moved.** For a new DID, or one whose `rev` moved,
   `com.atproto.repo.listRecords` on `com.pipobscure.bundle.listing` returns all of that
   publisher's listings, usually in one request, and their rows are replaced with what it
   says, in one transaction. The DID document is only asked for where the repository
   is when the publisher is new, their handle is due a check, or their PDS stops
   answering (they may have moved).
4. **Drop who left.** DIDs no longer in the backlinks are removed with their listings.

A `rev` moves on *any* write to the repository, so an active account is refetched on
most syncs. That is still one cheap request per publisher, not one per listing.

Records that fail the lexicon's rules are not stored. That covers the wrong `subject`, a
non-`https:` URL and an invalid key. Nothing is installed from the index, so these
unverified reads are enough. Install fetches the record again with its proof (see
[Installing](#installing)).

A PDS that cannot be reached keeps its rows and its old `rev`, and is retried next time.
A flaky server does not make listings flicker in and out. At most 8 requests run at
once, and every request identifies the tool, not the user, as discovery's already do.

Handles are resolved, checked both ways, when a publisher is first seen, and again once
a day. A handle can change without any commit to the repository, so `rev` cannot say when
it has. A publisher whose handle does not check out is shown by DID.

### Schema

```sql
PRAGMA user_version = 2;

CREATE TABLE sync (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  index_url TEXT NOT NULL,        -- the Constellation instance it was built from
  synced_at TEXT NOT NULL
);

CREATE TABLE publishers (
  did               TEXT PRIMARY KEY,
  handle            TEXT,          -- NULL when it does not check out both ways
  handle_checked_at TEXT,
  pds               TEXT,          -- where the repository was, so the DID document is not asked every time
  rev               TEXT,          -- repository revision when last listed
  synced_at         TEXT,
  error             TEXT           -- the last failure, kept until a sync succeeds
);

CREATE TABLE listings (
  did         TEXT NOT NULL REFERENCES publishers(did) ON DELETE CASCADE,
  rkey        TEXT NOT NULL,
  cid         TEXT NOT NULL,
  url         TEXT,          -- one of url and domain
  domain      TEXT,
  title       TEXT,
  description TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (did, rkey)
);

CREATE VIRTUAL TABLE listings_fts USING fts5(
  rkey, title, description, handle,
  content = '', contentless_delete = 1,   -- keyed by listings.rowid
  prefix = '2 3'
);
```

The FTS row for a listing shares its `rowid` and is replaced whenever the listing or its
publisher's handle changes. `contentless_delete` needs SQLite 3.43; the 3.53 in Node 26
has it.

The index is a cache. When `user_version` differs from what the tool expects, or the
configured discovery index differs from `index_url`, the file is deleted and rebuilt
from scratch, so it never needs a migration.

### Commands

```console
$ bundle listings                     # every listing, syncing first if it is stale
$ bundle listings --json
$ bundle search led blinker           # full-text search, best first
$ bundle search --json bled
$ bundle listings --refresh           # sync now, however recent the last one was
$ bundle search --offline bled        # the index as it is, no network
```

- **Staleness.** Both commands sync first when the last sync is more than an hour old.
  `--refresh` forces a sync and `--offline` skips it. A sync that fails falls back to
  the existing index, with a warning saying how old it is.
- **Matching.** Each word becomes a quoted prefix term (`"led"*`), so user input is never
  parsed as FTS syntax. All words must match. Ranking is `bm25` weighted towards the
  name: key 10, title 5, handle 3, description 1.
- **Output.** One line per listing, `@<handle>/<name>  <description>`, where the first
  column is exactly what `bundle install` takes. `@did:…/<name>` is used when the handle
  does not check out. `--json` prints an array of
  `{ install, did, handle, name, title, description, url, createdAt }`.
- **Completion.** `bundle install @<Tab>` can complete from the index, offline. It never
  triggers a sync.

The index is only ever read for display. `bundle install @…/name` always fetches the
record from the publisher's PDS with its proof, however fresh the index is.

## Publishing

`bundle publish [--as <account>] [--description <text>] [--title <name>] <name> <url | domain>`
writes the listing. `bundle unpublish <name>` deletes it. Both sign in as `attest`
does, with write access to `com.pipobscure.bundle.listing` only. Several listings, as pairs or
`--from` a file, are one read of the account's listings and one `applyWrites`, and nothing is
read back: every request counts against the account's rate limits.
`publish` refuses a non-`https:` URL. Given a domain, it lists the domain, and checks the
URL its TXT record names now. It also fetches the URL once, before signing in, and
refuses anything that is not an archive whose bytes hold together, so a typo is not
published. An unsigned archive is published with a warning rather than refused: an
attestation-only release is a legitimate thing to list. Publishing again keeps the
original `createdAt`.

## Plugins

A plugin's listing names, as its `subject`, the `at://` address of the listing of the app it
is for, instead of the concept hash. The backlink index then answers "what are this app's
plugins" with the same query it answers "what are all the apps" with, only for another
subject. So plugins never appear among apps. `bundle publish --for <app>` lists one, and
`search --for` and `listings --for` find them. The local index follows the plugins of the
apps installed here from a listing, which keeps what it fetches proportional to what is
actually installed. See [proposals/plugins.md](plugins.md).

## When this stops scaling

The first pass of a sync enumerates every listing through Constellation, and the second
asks every publisher's PDS for its revision. Once there are tens of thousands of
publishers, that is too much to do per user. An AppView then does the syncing once for
everyone. It follows Jetstream for the collection, backfills the way a sync does, and
serves `com.pipobscure.bundle.syncListings?since=<cursor>`, which returns the listings
changed and removed since the cursor. The local index and every command stay as they
are; only where steps 1–4 get their answers changes, set by the policy's `discovery`
setting. The AppView is a hint, like the backlink index: install still verifies the
record at its PDS.

## Open questions

- **Ranking and spam.** Search could show, per listing, who has attested the bundle at
  its URL right now. That costs a fetch of each bundle, so it might be limited to
  `bundle search --details <name>`.
