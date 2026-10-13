# Suites: listings installed together

**Status:** implemented (first cut)
**Author:** Philipp Dunkel

## Summary

A suite is a record in the publisher's repository naming listings that go together, and what
each must carry:

```
at://did:plc:…/com.pipobscure.bundle.suite/devtools
{
  "$type":   "com.pipobscure.bundle.suite",
  "subject": "sha256:44d3324ff44da0b4d3efde1810c8cb88bdad5e673d99b011d9072714d884670d",
  "members": [
    { "listing": "at://did:plc:…/com.pipobscure.bundle.listing/bled",
      "require": { "identity": "https://github.com/pipobscure/bled/.github/workflows/publish.yml@refs/heads/main",
                   "issuer":   "https://token.actions.githubusercontent.com" } },
    { "listing": "at://did:plc:…/com.pipobscure.bundle.listing/bled-gpio",
      "for":     "at://did:plc:…/com.pipobscure.bundle.listing/bled",
      "require": { "attesters": ["published@did:plc:…"] } }
  ],
  "createdAt": "2026-10-13T12:00:00.000Z"
}
```

```console
$ bundle suite add --suite devtools.json @pipobscure.com/bled
$ bundle suite add --suite devtools.json --for @pipobscure.com/bled @alice.example/bled-gpio
$ bundle suite validate --suite devtools.json
$ bundle suite publish --suite devtools.json --as pipobscure.com
$ bundle install @pipobscure.com/devtools
```

## Why this shape

**A suite vouches for nothing.** Each member is installed exactly as `bundle install` would
install its listing alone: fetched, reviewed under the machine's policy, and accepted or not
by the person installing. A suite from a stranger therefore gains no more trust than a listing
from one. Two things set installing a suite apart from installing its members one by one:

- **A floor.** A member's `require` is a minimum. A member that does not carry it is refused, at
  install and at every update, and `installed` says so. It is checked by the review like a
  policy requirement, but unlike one it is never a reason to accept anything: meeting it vouches
  for nothing. (`review.ts` calls this a `Minimum`, beside the command line's `Demands`, which
  do count as accepted.)
- **One question.** Because the suite says up front whom its members should carry, installing
  it shows all of them together. Whom the person accepts is treated as accepted for each member
  that names them, as if for an earlier version of that install, and remembered for updates.
  The person accepted them, not the suite, and only for evidence the archive actually carries.

**Its own collection, its own concept hash.** A suite could have been a listing variant (a
listing with `members` in place of `url`). It is a record of its own so that its lexicon can
say what it is, and so that it can be attested as a suite. Its `subject` is the sha256 of its
own NSID, so a backlink index can enumerate suites the way it enumerates listings, and search
can find them later. `@<account>/<name>` is a listing when the account has one of that name,
and otherwise a suite, which costs one more request, for suites only. `suite publish` refuses a
name the account already lists.

**Members by address, with the DID.** As installs remember listings, so members name them: a
handle can change hands. A spec keeps what was typed beside it (`label`) for whoever reads the
file, and that is never published.

**`for` names the app's listing, or a scope.** A plugin installs into the scope of the app
installed here from that listing, which is how `install --for` already finds an app by its
listing. A scope directly covers a suite's shared libraries. Without `for`, a plugin's own
listing says which app it is for. Apps install before plugins whatever the order.

## The spec, and publishing without atproto

The publisher keeps a JSON file: the record's `members`, `title` and `description`, plus its
`name`. [`schemas/suite.schema.json`](../schemas/suite.schema.json) describes it, and is
released per version like the policy schema. `bundle suite add` fetches each listing and what
it serves, shows the review an install would show, and asks which of that to require. `update`
asks again with what is required now marked, `validate` checks the file and what every member
serves now against it, and `publish` writes the record.

The same file served at an `https:` URL is a suite, so `bundle install <url>` tells it from an
archive by its first byte, `{`. And a domain's TXT record `nsuite:<url>` names one, as
`nzip:<url>` names an archive, so `bundle install <domain>` installs it. A domain that says both
is refused. An installed suite remembers where it was found, and `update` asks there again.

## Installing, updating, uninstalling

`suites.json`, beside `installed.json`, remembers each installed suite: where it came from, its
hash, and per member the install it became and whether the suite installed it (`brought`) or it
was there already. It is a file of its own so that an older `bundle`, rewriting
`installed.json`, cannot drop it.

- **Install.** An install of the same listing already here is shared, not repeated. A name taken
  by an install from somewhere else is never overwritten: that member fails. A member that is
  refused, declined or undecided is reported, and the rest still install. The next update tries
  it again.
- **Update.** The suite is asked again first. Members added are installed, with the one
  question. Members taken out are uninstalled if the suite brought them and no other suite has
  them; otherwise they stay, handed to the other suite if this one brought them. Then every
  install updates as usual, each answering to the floors of every suite it is in.
- **Uninstall.** Removes what the suite brought and nothing else. An install the person
  uninstalls by itself is left out of its suites from then on; installing it by hand makes it
  theirs, so it stays when the suite goes.

## Attesting a suite

A suite's hash is the sha256 of the DAG-CBOR encoding of `{ members }`, each member as it is
published. DAG-CBOR is deterministic, so the hash is the same wherever the suite was published,
and any change to what it installs, or requires, makes another. Title and description are left
out. An attestation of a suite is an ordinary `com.pipobscure.bundle.attestation` with that hash
as its key, so discovery, the cache, refresh and withdrawal need nothing new.

- **Good attestations carry over.** Installing, updating or checking a member, attestations of
  every suite it was installed from count as its own, marked `via suite <name>`. A policy that
  requires `permitted@<IT>` is met by IT attesting the suite. What was attested is the members
  and their requirements, and a member that does not meet its requirement is refused, so what
  was reviewed is what holds.
- **What is said of a bundle itself wins.** An attester's attestation of the archive is used
  instead of theirs of the suite. So IT can permit a suite and prohibit one bundle in it.
- **Bad attestations stay with the suite.** A suite marked bad by an attester the policy blocks
  on is refused, at install and on update, and its members are left alone. It does not carry
  over, so IT can prohibit a suite and still permit bundles from it individually.

That gives an IT department one rule to push out,

```json
{ "require": { "attesters": ["permitted@did:web:it.example.com"] }, "block": ["did:web:it.example.com"] }
```

and two levels to permit and prohibit at, from its own account.

**A permit is as strong as the requirements.** A suite's attestation pins its requirements, not
its members' bytes. Permitting a suite whose member requires only `published@<publisher>` permits
that publisher's next release too. That is often what an IT department wants, and the audit
skill says so plainly when it is asked to vet one. To pin bytes, permit the bundle itself.

## Open questions

- **Search.** Suites have a concept hash, but the local index does not sync them yet, so
  `bundle search` does not find them.
- **Nesting.** A suite cannot name a suite. Composition would need the floors and the
  ask-once to compose too; it is left out until something needs it.
- **Bad verdicts on members.** A blocking attester's bad verdict on a suite refuses the suite
  but not its members. Whether a non-blocking bad verdict should at least be shown at each
  member's review, rather than once for the suite, is open.
