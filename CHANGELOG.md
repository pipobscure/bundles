# Changelog

What each release changed. The reasoning behind the project is in [HISTORY.md](HISTORY.md);
how to use it is in the [README](README.md) and [docs/](docs/).

## Unreleased

- **The project's page lists the published apps.** [bundle.pipobscure.com](https://bundle.pipobscure.com/#apps)
  shows every app listed on the Atmosphere, A to Z, ten to a page, with a search, who published
  it (linked to their profile), and its `nzip:` link. The browser finds them as `bundle search` does, from the backlink index and each
  publisher's own PDS, with each handle checked both ways; an app whose handle does not check out
  is linked by DID. What it finds is kept in `localStorage` and shown at once on the next visit;
  a result missing a publisher that could not be reached is not kept as fresh.
  The page's Content-Security-Policy now allows `connect-src https:`, since a PDS can be anywhere.

## 0.2.2

- **Liking an app again counts.** `bundle like` no longer stops at "already liked": each like
  makes a post of its own, reviewed in your editor like the first (the comment lines say which
  like it is), and the account's one like record counts it and lists the post. The record is
  now `{ subject, count, posts, createdAt, updatedAt }`, `posts` oldest first and the newest 100
  of them; it is written over the like as it was read (`swapRecord`), read again once if another
  machine liked meanwhile, and the new post taken down again if it still cannot be written. A
  like written by 0.2.0–0.2.1, with one `post`, reads as liked once, and is written in the new
  shape when liked again; the lexicon describes both. The ★ in `search` and `listings` still
  counts accounts. `bundle likes` shows each account's count, its latest post, and how many
  earlier ones there are, and `--json` gives `count`, `posts` and, as before, `post` (the latest).
- **`bundle like --revoke` leaves the posts up.** It takes back the like and says how many posts
  stay; `--revoke --all` takes down the ones in your own repository too, and never touches anyone
  else's. `--all` alone is refused before signing in.
- The library's `like()` returns the new `count`, `unlike()` takes `all` and returns how many
  posts went and how many stay, and `putRecord()` takes an optional `swapRecord`, refusing with
  the code `SWAPPED` when the record changed.
- **A signing that fails part way exits cleanly.** A write still in flight to the discarded
  file could crash the process with a stream error after the real error was reported.

## 0.2.1

- **A like's post is yours to read first.** `bundle like` opens the post it would make in your
  editor (`BUNDLE_EDITOR`, `VISUAL` or `EDITOR`, run through the shell as git runs one), before
  signing in. Save and close to post it as it stands — the whole text, the link too, made a link
  wherever you put it, or posted without one if you took it out; close without saving, or empty
  it, and nothing is liked. A post too long opens the editor again, with your text. An app liked
  already opens none. Off a terminal it stops with exit code 4, unless `--yes` (`-y`) posts it as
  proposed. The library's `like()` takes the settled post as `post`; `postOf()` builds one from
  any text and the link, and `ownLike()` reads an account's like without signing in.

## 0.2.0

- **A plugin's listing installs into its app, and so does its `nzip:` link.** The listing
  names the app's listing, so `bundle install @alice.example/bled-gpio`, or a click on
  `nzip:alice.example/bled-gpio`, puts it in the scope of the app installed here from that
  listing, with no `--for`. Without that app here, it is refused, with the app's own
  `install` and link to install it first; installed more than once as different packages,
  `--for` says which. `--for` works as before, and still must name that app.
- **A link can say which app a plugin is for:** `nzip:alice.example/bled-gpio?for=bled`,
  taking what `--for` takes that a page can know (a package name, or an app's listing), read
  strictly, and checked as `--for` is. It places a plugin's listing and nothing else; with
  `--for` too, the two must agree. The window's title and log say which app it goes in.
- **`bundle publish` prints the `nzip:` link for a plugin's listing too**, and the plain
  `bundle install` that installs it; `search --for` says the first column installs as it is.
- **A page for the project**, at [bundle.pipobscure.com](https://bundle.pipobscure.com/): what
  bundle is, why, and how to get it. It lives in `site/`, plain HTML and CSS with no build
  step, and is deployed to GitHub Pages with each release by the publish workflow;
  `pages.yml` deploys it by hand for a fix between releases.
- **An attestation can say why.** `attest` and `suite attest` take `--note` (context in your own
  words, now shown wherever the attestation is), `--post` (a link to a post that gives the
  context, fetched, verified and pinned by its CID), `--note-as-post` (post the note from the
  same account too, and link it) and `--note-from-post` (take the note from the linked post).
  The install review, `verify` (and `verify --json`) and `validate` show the note, made safe to
  print, and the post as a link. They decide nothing. The attestation lexicon gains `post`.
- **Likes.** `bundle like` stars an app, of its listing so across its releases, from an
  Atmosphere account, always with a post saying what the app is and how to install it (bundle's
  own likes link to https://bundle.pipobscure.com/). `--revoke` takes it back, post and all.
  `search` and `listings` show how many accounts like each app, and `bundle likes` who, each
  verified at its source. A new lexicon, `com.pipobscure.bundle.like`.
- **bundle installs itself from its own listing**, `@pipobscure.com/bundle`, as any listed app
  installs, so its updates follow the listing and it is found on the Atmosphere like one. The
  listing only says where: the publish workflow's signature is still trusted
  for the release URL alone. When the listing cannot be asked, `bundle install` says so and
  fetches the release URL as before. An install made from the URL moves to the listing on the
  first `update` that can ask it, and until then updates exactly as before.

## 0.1.7

- **Updating a running app works on Windows**, its parts included. Windows will not rename
  over a file a process has open, so an update of a running app, or of a part a service had
  loaded, failed with `EPERM` and was rolled back. Now the old file is moved aside first, as
  Windows allows while it is open, and the new one renamed in; what is running keeps the
  version it started with until it is restarted. Elsewhere nothing changes. A rename that
  fails part way also no longer leaves a stray `.previous` file behind.

## 0.1.6

- **`bundle node`** says which node runs bundles here, and **`bundle node install`** gets one
  where there is none: the newest LTS at or above the minimum, through mise, fnm, nvm or asdf
  (nvm-windows on Windows) when one is here, else the official build from nodejs.org, checked
  against `SHASUMS256.txt`, kept in bundle's data directory and never put on the `PATH`. The
  launcher and the Windows association look there too (`BUNDLE_NODE_DIR`,
  `BUNDLE_NODE_MIRROR`).
- **Apps get an entry in the desktop's applications** when their `package.json` asks for one
  (`bundle.app`), with their own title and icons from inside the signed archive: a `.desktop`
  file on Linux, `~/Applications/<title>.app` on macOS, a Start menu shortcut on Windows.
  `update` keeps it current, `uninstall` removes it, `install --no-menu` declines it.
- **`nzip:` links install in one click.** `install` takes `nzip:alice.example/devtools`,
  `nzip:<did>/<name>` and `nzip:at://…` (a published listing or suite only), and `install
  --window` makes its decisions in a window instead of at a terminal. Installing bundle
  registers it for the links, per user, and **`bundle links`** checks and repairs that.
- **Apps made of parts.** An app can declare, in its `package.json` (`bundle.parts`), the
  archives it ships beside it, each by package, `url` (resolved against the app's) and `hash`.
  Installing the app installs every part as a plugin in its scope, trusted because the app is:
  each must be the bytes the app pins and hold together, and needs no signature or attestation
  of its own. Every part is fetched and checked before anything moves, and the app and its parts
  are put in place together, so an install or update is all of them or none. `update` adds,
  replaces and removes parts as the app says, `installed` and `validate` check each against the
  app, and uninstalling the app removes them; a part is never installed, updated or removed by
  itself. The policy's `apps` section applies to the app, and its `scopes` section does not
  apply to the app's parts. See [proposals/parts.md](proposals/parts.md).
- **`bundle parts`** prints the declaration for a set of archives, or writes it into a
  `package.json` (`--write`). A part's `hash` is its whole-file hash, `sha256:<hex>`: what
  attestations name and `verify` reports, not the sha256 of the file.
- **`create` prints the hash as `sha256:<hex>`** (it printed the hex alone), the form a part is
  pinned by and an attestation names.
- **Installing from a file.** `bundle install ./app.nzip` installs a local archive without the
  network, and `--source <url>` says what URL it stands for; updates read the file again, or
  fetch that URL. From code, `install({ file | bytes, name, source })`.
- **`--system`, and `BUNDLE_ROOT`.** `install`, `update`, `installed`, `validate`, `uninstall` and
  `trust` take `--system`, which puts commands, apps, plugins, state and caches under one root
  (`/var/lib/bundle` on Linux), beside the machine's policy file; `BUNDLE_ROOT=<dir>` puts the
  same layout anywhere. The policy files read are the same. The plugin loader finds a scope there
  when its user has none of their own, so a service running as a user of its own needs nothing
  set.
- **The installer is an API**: `@pipobscure/bundle/install` exports `install`, `update`,
  `uninstall`, `installed`, `validate`, `records` and `partsOf`. `update` returns a result for
  each part too, with the hash before and after.
- **Plugins:** `list(scope)` returns `{ name, package, file, manifest }`, with the whole
  `package.json`, custom fields and entry points included; it returned `[name, package]` pairs
  with an allowlist of fields, and `PACKAGE_FIELDS` is gone. The layout is exported:
  `pluginsDir`, `scopeDir`, `pluginFile`, `labelFile`.
- **Pins.** `use(scope, { verify: { pins } })` holds plugins to their whole-file hash, and an app
  using its own scope has its declared parts pinned with nothing passed. A pinned plugin is
  mounted through the provider that checks every member as it is read, and loading one needs
  nothing but node's own modules.
- **`runPlugin(scope, package, argv, { bin })`** runs a plugin as the main program, with
  `process.argv` as `--vfs-load` makes it.
- **Workers started from a plugin have its plugins.** Inside a plugin, `worker_threads`'s `Worker`
  starts a thread with the same scopes and the same plugins mounted at the same places, so
  `new Worker(new URL('./worker.js', import.meta.url))` works. Hosts can import that `Worker`
  from `@pipobscure/bundle/plugins`.
- **`@pipobscure/bundle/integrity`** checks an archive's whole-file hash and member digests
  without loading sigstore or the attestation code.

## 0.1.5

- **Commands in a row sign in once.** An app-password session is kept for five minutes, so a
  script publishing and attesting one command after another makes one `createSession` rather
  than one per command; that call is among the most tightly rate-limited a PDS has. It is kept
  in `sessions/` in the state directory, encrypted with a key derived from the app password, so
  the file is worth nothing without the password. A session the PDS turns down is signed in for
  again, once. `BUNDLE_ATPROTO_SESSION_TTL` sets how long; `0` keeps none. OAuth sessions are
  still never kept. Every command that writes to an account shares it.
- **`attest --from` reads the file `publish --from` does**, fetching each entry's archive from
  its `url` or `domain`, so one file both lists a release and vouches for it. `--from` now
  completes file names in the shell.

## 0.1.4

- **🌳 is the project's icon**, and `.nzip` files wear it. `bundle install` registers the file
  type and its icon for the current user on every system, without administrator rights: on
  Windows as the association's `DefaultIcon`; on Linux as `application/x-nzip` in
  `$XDG_DATA_HOME/mime`, with a hicolor icon; on macOS through a small `NodeBundle.app` that
  declares the type with Launch Services and opens nothing. Installing twice changes nothing,
  a step that fails is reported without failing the install, and `uninstall` leaves it in
  place. `BUNDLE_NO_DESKTOP_SETUP` turns it off; `BUNDLE_NO_WINDOWS_SETUP` still does too.
- **Apps are kept as `.nzip`, and the `PATH` gets a link** (macOS and Linux). An app's archive
  lives in bundle's data directory as `<name>.nzip` (`BUNDLE_APPS` overrides), and the command
  in `~/.local/bin` is a symlink to it, so the archive keeps its extension and icon while you
  type its bare name. Rename the link, or add another: `update` replaces the archive, so every
  link runs the new version, `installed` lists them as *runs as*, and `uninstall` removes them
  all. Existing installs move over on their next `update`. Windows is unchanged.
- **Output for people on a terminal.** 🌳 marks bundles and apps, 🔐 signatures, ✍️ attestations;
  names are bold, details dim, states in colour, and signers and attesters are a short
  headline with the detail beneath (a GitHub Actions signer reads as repository, workflow and
  ref). Piped or redirected, the output is the same text as before, byte for byte, so scripts
  are unaffected. `NO_COLOR` and `TERM=dumb` are honoured.

## 0.1.3

- **The launcher finds a node new enough for the app.** A bundle made with `create --launcher`
  runs the `node` on `PATH` when that meets the app's `engines.node` (never below 26.11.1),
  else the newest one nvm, fnm, volta, asdf, mise or n has installed, and otherwise exits 69
  saying what it found and what to install. `create` writes the minimum into the launcher, and
  warns when `engines.node` also has an upper bound, which is not checked.
- **On Windows, `.nzip` opens with a node that can run it**: the one on `PATH`, else the one
  running the install, else the newest from nvm-windows, fnm, volta or mise. Installing from npm
  under an older node no longer leaves an association that cannot work.
- **Recording works through a symlinked directory.** `-r @pipobscure/bundle/record
  --vfs-load=<dir>` refused every file when `<dir>` was reached through a symlink, as every
  temporary directory on macOS is; the recording provider now mounts the real path.
- **The launcher is LF on every checkout**, so one built from a Windows clone runs on unix. CI now
  runs on macOS too.

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
