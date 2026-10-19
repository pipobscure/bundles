# Likes: a star for an app

**Status:** implemented (first cut).
**Author:** Philipp Dunkel

## Summary

Anyone with an Atmosphere account can like an app:

```console
$ bundle like --as you.example @alice.example/tool
$ bundle likes @alice.example/tool
$ bundle search tool          # @alice.example/tool  ★ 12  …
```

A like is a record in the liker's own repository, and each like comes with a post from the same
account saying so.

```json
at://<liker>/com.pipobscure.bundle.like/<sha256 of the listing's address>
{ "subject": "at://<publisher>/com.pipobscure.bundle.listing/tool",
  "count": 2,
  "posts": [{ "uri": "at://<liker>/app.bsky.feed.post/…", "cid": "…" }, …],
  "createdAt": "<the first like>", "updatedAt": "<the latest>" }
```

## Decisions

- **Of the listing, not a release.** A star is for the app. An attestation is of exact bytes,
  and a new release starts with none; a like should not. So it names the app's listing, which
  stays as the app is released again, and is the thing `install` and `search` already know.
- **One record per account, counting each like.** The record key is the sha256 of the listing's
  address, so liking again finds the like that is there, and unliking knows where it is. Liking
  again is allowed, because the post is the part that reaches people: someone who likes an app
  after its next release, or wants to tell their followers again, should be able to, and should
  not need a second account to. So the one record counts each like and lists each like's post
  (the newest 100; the count goes on past them), and the star stays one per account. Each like
  writes over the record as it read it (`swapRecord`, by CID), so two machines liking at once
  lose neither; a like written by 0.2.0–0.2.1, with one `post` and no count, reads as liked once.
- **Always a post.** A like is also a recommendation to the people who follow the liker, most
  of whom have never heard of bundle. The post says what the app is (its title and the
  description from its listing, or the liker's own words) and ends with the app's `nzip:` link,
  marked as a link, so a reader with bundle installs it in one click. bundle itself is the
  exception: its likes link to its page, https://bundle.pipobscure.com/, since an `nzip:` link
  opens bundle, and whoever reads about it may not have it yet. Unliking deletes the like and
  leaves the posts up: once made, a post is the person's, and may have replies and reposts of
  its own. `--revoke --all` takes down the posts the like lists in the liker's own repository
  too, and never anything in anyone else's.
- **Counted by accounts.** `search` and `listings` ask Constellation how many distinct accounts
  have a like of each listing shown. Anyone can like often, or write many records, from one
  account; it counts once. The count is the index's, not verified; `likes` fetches each like
  from its author's PDS and verifies it before showing it, with how often that account liked.
- **It decides nothing.** No policy reads likes, and nothing is installed or refused by them.
  A star is popularity, which is exactly what a supply-chain attacker can buy; trust stays with
  signatures and attestations.

## Not doing

- **Likes of suites.** A suite is a set of listings; liking the apps in it says more.
- **Ranking search by likes.** Search ranks by how well the words match. Sorting by stars
  would reward whoever games the count.
