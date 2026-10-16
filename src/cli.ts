import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { parseArgs } from 'node:util';
import { createBundle, signBundle, signedName, verifyBundle, runBundle, fileSigner } from './api.ts';
import { members, parseDate } from './archive.ts';
import { packageVersion } from './files.ts';
import * as AUDIT from './audit.ts';
import { message, wholeFileHash, STATES, type VerificationResult, type VerificationState } from './manifest.ts';
import { formatAttester, parseAttester, parseDuration, policyFromEnvironment, cachedDids, type Attester } from './attestation.ts';

// Re-exported because this is where a CLI consumer looks for it; it is defined
// in the format layer so the `bundle` launcher can report an exit code without
// loading the whole CLI.
export { STATES };
import * as SKILLS from './skill.ts';
import * as REVIEW from './review.ts';
import { PLAIN, styleFor, bytes, plural, type Style, type Mark } from './style.ts';
import type { Validation, Seen } from './install.ts';

// Argument parsing and reporting, and nothing else. Every command below is a
// `parseArgs` call, a message or two, and one call into `api.ts` — which is
// deliberate: what the CLI can do is exactly what an embedder can do, because
// they are the same functions.

/** What `bundle --help` prints: the commands, and how to ask about one. */
export const USAGE = `usage: bundle <command> [options]
       bundle -v, --version

commands:
  create    build an archive from a list of files
  sign      sign an archive as it is: app.unsigned.nzip into app.nzip
  audit     report what is about to be reviewed, and gate signing on the verdict
  verify    verify an archive and report its trust state
  attest    vouch for an archive from an atproto account, or withdraw that
  publish   list an archive's URL under a name, so others can find and install it
  unpublish take a listing down again
  suite     write, check and publish a suite: listings installed together
  run       mount a signed archive and run it
  search    search the listed archives by name, description and publisher
  listings  every listed archive, from a local index kept in step with the network
  install   fetch a signed archive — or a suite of them — from a URL, domain or listing
  update    refetch what was installed, and replace it if it changed
  installed list what is installed, and re-check each against its record
  validate  re-check installs, and say what has been attested since — at startup
  uninstall remove an installed archive, and forget where it came from
  sea       build a node runtime that verifies an archive before running it
  trust     refresh the sigstore trust root and the cached attestations
  policy    show the rules this machine installs by, and where they come from
  lexicon   show, check or publish the atproto lexicons for attestations and listings
  skill     install this package's bundle-auditing skill into a project
  shell     print what to load at shell start: Tab completion, and validate

  bundle <command> --help     what one command does, and its options
  bundle help <command>       the same

options:
  -h, --help            show this help; after a command, that command's
  -v, --version         print the version`;

/** What `bundle <command> --help` prints: one command, what it does, and its options. */
export const HELP: Record<string, string> = {
    create: `create options:                     usage: create [options]
  -b, --base <dir>      base directory the file list is relative to (default: .)
  -l, --launcher        put this package's shell launcher in front, so the
                        result runs by name — the usual way to make a program
  -p, --prefix <file>   put some other prefix in front: a launcher of your own,
                        or a verifying node; omit both for a plain archive
  -f, --files <file>    read the newline-separated file list from here (default: stdin)
  -o, --output <file>   write the archive here (default: stdout)
  -k, --key <file>      leaf private key (PEM); signs at build time with --chain
  -c, --chain <file>    full certificate chain (PEM, leaf first)
      --hash <alg>      digest for the whole-file hash and member digests (default: sha256)
      --sign <alg>      digest the signature over that hash uses (default: sha256)
      --date <iso8601>  date every member with this one time, as a rebuild
                        should: 2024-05-01T12:00:00Z, or a date (UTC midnight)

  the prefix decides the archive's shape, and is part of what an audit
  reviews; signing keeps it.

  the launcher runs the node on PATH when that meets the app's engines.node
  (from package.json in --base, never below 26.11.1), else the newest one
  nvm, fnm, volta, asdf, mise or n has installed, and otherwise exits 69
  saying which node to install. Only the lower bound is checked.

  every member records its own digest, and the
  archive records its whole-file hash, so even unsigned it says what its
  bytes should be.

  each member is dated with its file's own time (never the time of the
  build), no later than SOURCE_DATE_EPOCH when that is set; --date gives
  them all one time instead. So the same files make the same archive — in
  the same timezone, since ZIP times are local: build with TZ=UTC.`,
    sign: `sign options:                       usage: sign [options] <archive>
  -o, --output <file>   write the signed archive here; '-' for stdout. By
                        default app.unsigned.nzip is signed into app.nzip, and
                        a name without '.unsigned' is signed in place
  -x, --executable      make the output executable (implied when the archive
                        has a prefix)
      --hash <alg>      digest for the whole-file hash and member digests (default: sha256)
      --sign <alg>      digest the signature over that hash uses (default: sha256)

  by default this signs through sigstore, taking the identity from CI when
  there is one and otherwise opening a GitHub sign-in:
      --flow <how>          auto | ci | browser | device (default: auto)
      --token <jwt>         use this OIDC token instead of signing in
      --oidc-issuer <url>   OIDC issuer (default: sigstore's dex)
      --connector <name>    identity provider to jump to (default: github)
      --fulcio <url>        certificate authority (default: fulcio.sigstore.dev)
      --rekor <url>         transparency log; empty string to skip it
      --tsa <url>           timestamp authority; empty string to skip it

  or, to sign against a certificate authority of your own:
  -k, --key <file>      leaf private key (PEM)
  -c, --chain <file>    full certificate chain (PEM, leaf first)`,
    audit: `audit options:                      usage: audit [options] <archive>
  -b, --baseline <file>  a previously approved archive to review against, so
                        the review is of what changed rather than of everything
  -v, --verdict <file>  where the verdict is (default: <archive>.audit.json)
      --check           exit non-zero unless a clean verdict pins these bytes
      --approve         record a clean verdict you reached by reading it yourself
  -n, --note <text>     what you checked, recorded with --approve

  with none of those it reports what is about to be reviewed and how. The review
  itself needs judgement, so no command performs it: install the skill with
  'bundle skill' and run /audit-bundle, or read the archive yourself and
  --approve. Signing is not gated unless you run --check before it.`,
    verify: `verify options:                     usage: verify [options] <archive>
  -a, --archive <file>  archive to verify (or pass it as a positional argument)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --sigstore-root <file>  sigstore trust root (default: the cache 'trust' fills)
      --attester <[kind@]who>  require an attestation from this DID or handle,
                        optionally of this kind (audited@did:web:…); repeatable
      --quorum <n>      how many of the attesters must have attested (default: all)
      --max-age <time>  how stale a cached attestation may be (default: 7d)
      --block <who>     refuse it if this DID or handle has marked it bad; repeatable
      --json            print the result as JSON

  with attesters, their attestations of this file are fetched first; if that
  fails, what the cache holds is used. A signature is then optional — when
  there is one it must verify, but its certificate only has to be trusted if
  --identity or --issuer ask for a signer too.`,
    attest: `attest options:                     usage: attest [options] <archive>...
      --as <handle | did>  the account to attest as
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --from <file>     attest these too: the file 'publish --from' reads —
                        each entry's archive, fetched from its url or domain
      --kind <kind>     what is being said: published, audited, reproduced —
                        or, with --verdict bad, malware, vulnerable, …
      --verdict <v>     good (the default) to vouch for it, bad to warn
                        everyone who installs it against it
      --note <text>     a short note kept with the attestation
      --revoke          withdraw the attestations instead
      --password-file <file>  use an app password from this file instead of
                        signing in — for CI, where there is no browser
                        (BUNDLE_ATPROTO_PASSWORD works too; never an argument)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable

  every archive named is checked first, and one that does not hold together
  stops them all. Then one sign-in covers them: OAuth, in the browser, against
  the account's own PDS, asking for write access to attestation records and
  nothing else where the server supports that. Nothing is kept — the session is
  revoked when the command is done, so every attest is approved by whoever it
  speaks for. An app-password session is kept for 5 minutes, encrypted with
  the password, so commands in a row sign in once
  (BUNDLE_ATPROTO_SESSION_TTL; 0 turns that off).

  writes com.pipobscure.bundle.attestation/<hash> to the account's repository, naming
  the archive's whole-file hash — the hash a signature covers. The archive is
  checked first: one whose bytes or signature do not hold together is refused.`,
    publish: `publish options:                    usage: publish [options] <name> <url | domain> [<name> <url | domain>]...
      --as <handle | did>  the account to publish from
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --for <app>       list it as a plugin for this app: an app installed from
                        its listing, @<handle or did>/<name>, or an at:// address
      --title <text>    a display name (default: the name); one listing only
      --description <text>  what it is, in a sentence or two; one listing only
      --from <file>     list these too: a JSON array of { "name", "url" or
                        "domain", and optionally "title", "description", "for" }
      --password-file <file>  an app password instead of signing in, for CI
                        (BUNDLE_ATPROTO_PASSWORD works too)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable

  writes com.pipobscure.bundle.listing/<name> to the account's repository,
  naming <url>, so 'bundle install @<handle>/<name>' fetches it and 'bundle
  search' finds it. The listing says where and nothing else: point it at a URL
  that stays the same across releases (a GitHub 'releases/latest/download/…'
  URL does), and a release is just whatever the URL serves next. Or name a
  domain instead, whose 'nzip:' TXT record names the URL (see 'install'): the
  listing then follows whatever that record says, so the URL stays yours to
  manage in DNS. Either way the archive is fetched first, and refused unless
  it is https and an archive whose bytes hold together. <name> is lowercase
  letters, digits and '-', and is what it installs as. Publishing it again
  replaces it.

  several listings are checked first — all of them, before signing in — and
  written as one batch: the account's listings are read once, and the PDS
  saying they are written is taken as their being written, since every
  request counts against the account's rate limits.`,
    unpublish: `unpublish options:                  usage: unpublish [options] <name>...
      --as <handle | did>  the account the listing is in
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --password-file <file>  an app password instead of signing in, for CI
                        (BUNDLE_ATPROTO_PASSWORD works too)

  deletes the listings, as one batch. Installs made from one keep checking
  the URL it last named. Exits 1 when a name was not listed.`,
    suite: `suite options:                      usage: suite <add | remove | update | validate | show | publish | unpublish | attest> [options]
  -s, --suite <file>    the suite's spec (default: suite.json)
      --for <app>       add: install it as a plugin, for the app installed
                        from this listing (@<handle or did>/<name>, or an
                        at:// address) — for now, an app in the suite
  -y, --yes             add, update: require everything shown that can be
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --no-discover     do not ask the backlink index who has attested it
      --json            show: print the spec as it is
      --as <handle | did>  publish, unpublish, attest: the account
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --password-file <file>  an app password instead of signing in, for CI
      --kind <kind>     attest: what is vouched for (permitted, prohibited, …)
      --verdict <good | bad>  attest: vouch for it, or warn against it
                        (default: good)
      --note <text>     attest: a short note, for information
      --revoke          attest: withdraw the account's attestation of it

  a suite is a set of listings installed together: 'bundle install
  @<handle>/<suite>' installs each as it would be installed by itself, and
  'bundle update' keeps them in step — members added are installed, members
  taken out are removed. It vouches for none of them; what it can do is set
  a minimum per member — a signer, attesters — below which that member is
  refused, at install and at every update. Installing, everyone the suite
  expects is shown once, and whom you accept counts for every member that
  names them: one answer, rather than one per member.

  a suite is written as a spec, a JSON file (schemas/suite.schema.json):
    add <listing>...    adds listings: fetches each, shows what vouches for
                        it, and asks which of that to require
    remove <listing>... takes members out
    update [listing]... asks again what to require, of the members named or all
    validate [suite]    checks the file holds together, and that what each
                        member's listing serves now carries what it requires
    show [suite]        prints it
    publish             writes it to the account as com.pipobscure.bundle.suite
    unpublish <name>    takes it down
    attest [suite]      attests it — the spec, or one published — by the
                        hash of what it says
  'bundle suite <subcommand> --help' says more about each.

  an attestation of a suite (see 'suite attest') counts for each member
  installed from it, while the suite is as it was attested: so an IT
  department that requires 'permitted@<its DID>' of everything can permit a
  whole suite at once, and still permit or prohibit single bundles — what is
  said of a bundle itself wins over what is said of its suite. A bad verdict
  (prohibited) refuses the suite where the policy blocks on whoever said it,
  and does not carry over: its bundles can still be installed by themselves.

  a spec can be published without atproto, too: serve it at an https URL,
  and 'bundle install <url>' installs it — or name that URL in a TXT record
  'nsuite:<url>' on a domain, and 'bundle install <domain>' does.`,
    run: `run options:                        usage: run [options] <archive> [app args...]
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --attester <[kind@]who>  require an attestation from this DID or handle;
                        repeatable. Fetched before running, else the cache
      --quorum <n>      how many of the attesters must have attested (default: all)
      --max-age <time>  how stale a cached attestation may be (default: 7d)
      --block <who>     refuse it if this DID or handle has marked it bad; repeatable
      --untrusted       run an archive whose signature is good but unanchored —
                        never one that misses what the flags above demand

  these options come before the archive; everything after it is the program's,
  flags included. A '--' is accepted there too, for the habit.`,
    search: `search options:                     usage: search [options] <words>...
      --for <app>       search the plugins listed for this app instead: an app
                        installed from its listing, or @<handle or did>/<name>
      --refresh         sync the index first, however recent it is
      --offline         answer from the index as it is, without the network
      --json            print the results as JSON

  every word must match, as the start of a word in the name, title,
  description or publisher's handle; the best matches come first. The first
  column is what 'bundle install' takes. Searching is local, against an index
  in the state directory: it is synced first when it is more than an hour
  old — every listing found through the backlink index the policy names
  ('discovery'), and only publishers whose repository changed asked again.
  If that fails, the index answers as it is.

  plugins are listed against their app's listing, so they never show up
  among apps; --for asks for one app's. The index follows the plugins of
  every app installed here from a listing, and of the one --for names.`,
    listings: `listings options:                   usage: listings [options]
      --for <app>       the plugins listed for this app instead
      --refresh         sync the index first, however recent it is
      --offline         answer from the index as it is, without the network
      --json            print the listings as JSON

  every listing in the index, synced first as for 'search'.`,
    install: `install options:                    usage: install [options] [url | domain | @account/name | ./folder]
  -y, --yes             accept everything found, rather than asking
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --attester <[kind@]who>  require an attestation from this DID or handle;
                        repeatable
      --quorum <n>      how many of the attesters must have attested (default: all)
      --block <who>     refuse it if this DID or handle has marked it bad; repeatable
      --no-discover     do not ask the backlink index who has attested it
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
  -n, --name <name>     install under this name, rather than the one the
                        server suggests (Content-Disposition, else the URL)
      --for <app>       install a plugin for this app — an installed name, the
                        listing it was installed from (@<handle or did>/<name>,
                        or an at:// address), or its package name — into the
                        app's scope rather than onto the PATH
  -d, --dir <dir>       where the command goes (default: ~/.local/bin, or
                        %LOCALAPPDATA%\\bundle\\bin; BUNDLE_INSTALL_DIR overrides).
                        On macOS and Linux it is a link to the archive, which
                        is kept as <name>.nzip in bundle's data directory
                        (BUNDLE_APPS overrides), so it can be renamed freely
      --no-shell        installing itself, do not offer to set up the shell

  everything that vouches for the archive is found and shown: its signature,
  and every attestation of it — from attesters this machine knows, and from
  anyone a backlink index says has attested it (each one fetched from the
  attester's own PDS and verified). Bad verdicts are shown as warnings.

  what is accepted without asking: a signer or attester accepted for this
  install before, one the policy trusts ('bundle policy'), one a flag demands,
  or a certificate anchored in the trust store. Anything else is a question —
  on a terminal you are asked which to accept; elsewhere it stops with exit 4
  unless --yes. What you accept is remembered for later updates.

  what refuses: an archive whose bytes or signature do not verify; a missing
  --identity, --issuer or --attester; a policy requirement not met; a bad
  verdict from someone --block or the policy blocks on.

  a domain instead of a url is looked up in DNS: a TXT record of the form
  'nzip:<url>' says what to fetch, with <url> either https or resolved
  against https://<domain>/, and the domain's first label is the name. So a
  TXT record 'nzip:/app/npm.nzip' on npm.npmjs.org makes
  'bundle install npm.npmjs.org' fetch https://npm.npmjs.org/app/npm.nzip
  and install it as 'npm'. The record only says where; the archive is
  verified exactly as a url's would be.

  '@<handle or did>/<name>' installs a listing (see 'publish' and 'search'):
  the record is fetched from the publisher's own PDS and verified, the archive
  is fetched from the URL it names — or that its domain's TXT record names —
  and installed as <name>. Like an alias, it
  says only where; the archive is verified exactly as a url's would be.

  how it was installed — url, domain or listing — is remembered, and 'update'
  asks it again, so a listing or TXT record that moves moves the install too.

  a suite installs every listing in it (see 'suite'): '@<handle>/<name>'
  where the account has a suite and no listing of that name; a domain whose
  TXT record is 'nsuite:<url>'; or a URL that serves a suite's JSON rather
  than an archive. Each member is installed as it would be by itself, and
  reviewed on its own. First, everyone the suite expects its members to
  carry is shown once: whom you accept counts for every member that names
  them, so the rest installs without asking. A member that does not carry
  what the suite requires is refused; one refused or declined does not stop
  the others. --dir applies to its apps; --name and --for do not apply.

  --for installs a plugin: a bundle an app loads by its package name, with
  '@pipobscure/bundle/plugins'. It goes into the app's scope — a directory of
  that app's own (BUNDLE_PLUGINS overrides where those are) — under the
  package name inside it, is not made executable, and is never on the PATH.
  It is reviewed like any install, under the policy's global rules and its
  'scopes' section for that app, never the app's own 'apps' section: a
  plugin's author is not the app's. Its record is '<scope>:<package>', which
  update, installed, validate and uninstall take like any other name. It is
  also known by what was given to install it, as typed: that is what the app
  is told it is called.

  --for with a folder (./my-plugin, an absolute path, a file: URL) links it,
  for developing a plugin: the scope notes the folder, and the app loads the
  plugin from it as it is, so a change is there on its next run. Nothing is
  reviewed or verified, and anything that verifies plugins refuses it — run
  the app with plain node (node --experimental-vfs --vfs-load ./app.nzip) to
  use it. Installing the plugin again replaces the link, and the other way
  round; uninstall removes the link and never the folder.

  with neither, this package installs itself from its own published release,
  whose publish workflow's signature is accepted without asking — so
  'npx @pipobscure/bundle install' leaves a signed 'bundle' on your PATH that
  'bundle update' keeps current. The archive is named '.nzip', and the name it
  installs under drops that everywhere but Windows, where the extension is what
  makes it runnable. It then offers to add 'bundle shell' to the startup file
  of the shell it is run from — Tab completion, and a quiet daily re-check of
  installs (see 'shell'); 'bundle uninstall' takes that out again. Run again
  once installed, it fetches nothing and only sets up the current shell — so
  after switching shells, 'bundle install' is all it takes.`,
    update: `update options:                     usage: update [options] [name]
  -y, --yes             accept everything found for a new version, rather than asking
      --identity <san>  require this sigstore signing identity of every new version
      --issuer <url>    require this sigstore OIDC issuer of every new version
      --attester <[kind@]who>  require an attestation from this DID or handle of
                        every new version; repeatable
      --quorum <n>      how many of the attesters must have attested (default: all)
      --block <who>     refuse a new version this DID or handle has marked bad;
                        repeatable
      --no-discover     do not ask the backlink index who has attested it
  -r, --root <file>     extra trusted root certificate (PEM); repeatable

  with no name, every install is checked — and first every suite is asked
  what it holds now: members added are installed, and members taken out
  removed, if the suite brought them. Named, a suite is that suite and its
  members. A domain or listing it was installed
  from is asked again where the archive is now; then each is a conditional
  request with the recorded ETag, so nothing is downloaded twice. A new version is reviewed
  like an install, against what has been accepted for it so far: a new signer,
  or different attestations, is a question rather than a failure — publishers
  move, and auditors do not review every release. Only flags and the policy
  make anything mandatory.`,
    installed: `installed options:                  usage: installed [options]
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --json            print the results as JSON

  says what is installed, where it came from and who vouched for it — and
  checks each one: the file is there, its bytes are still the bytes that were
  installed, someone accepted for it still vouches for it, the policy still
  holds, and nobody it blocks on has marked it bad since. Attestations are
  fetched fresh first. Exits non-zero if any of that is no longer true.`,
    validate: `validate options:                   usage: validate [options] [name | url | domain]...
  -q, --quiet           say nothing unless something needs attention
      --every <time>    leave alone anything validated more recently (30m, 1d)
      --timeout <time>  give up on the network after this, and answer from the cache
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --json            print the results as JSON

  re-checks installs — the named ones, or all — exactly as 'installed' does,
  attestations fetched afresh and discovery asked again, and says what is new
  since the last time: an attestation that was not there before, one that was
  withdrawn, and above all a warning — someone marking it bad. Then it
  remembers what it saw, so each change is reported once. Exits 0 when
  nothing needs attention, 1 for a new warning or an install nobody accepted
  vouches for any more, 2 for one that is changed, missing, invalid or
  blocked. Made for startup — e.g. 'bundle validate --quiet --every 1d' in a
  shell profile; offline, it answers from the cache.`,
    uninstall: `uninstall options:                  usage: uninstall [name | url | domain | @did/name]

  a suite (by its name, how it was installed, or @did/name) is removed with
  what it brought: what was installed before it, or that another suite has
  too, stays. An install a suite has, uninstalled by itself, is left out of
  that suite from then on, until it is installed again.

  deletes the archive — and on macOS and Linux every link to it in its
  directory, whatever it is called now — and forgets the record. With no
  argument it removes this
  package's own install — what 'bundle install' left behind. An app's plugins
  go with it, unless another install of the same app still loads them. The
  .nzip association on Windows is left alone: other archives may need it.`,
    sea: `sea options:                        usage: sea [options] [archive]
  -o, --output <file>   write the executable here (required)
      --hash <alg>      digest for the whole-file hash and member digests (default: sha256)
      --node <file>     node binary to embed (default: the running one)
      --base <file>     reuse a SEA base built earlier instead of building one
      --no-sigstore     leave the sigstore libraries out of the embedded verifier
      --untrusted       let the finished executable run an archive whose
                        signature is good but unanchored
  -r, --root <file>     trusted root the executable checks against; repeatable
      --identity <san>  identity the executable requires of a signature
      --issuer <url>    issuer the executable requires of a signature
      --attester <[kind@]who>  attester the executable requires; repeatable.
                        Handles are resolved now, and the DID is what is baked
      --quorum <n>      how many of the attesters (default: all)
      --max-age <time>  how stale a cached attestation may be (default: 7d)
      --block <who>     refuse what this DID or handle has marked bad; repeatable

  with an archive, the result is that application: one file that verifies
  itself and runs what is inside it. without one, the result is a verifying
  node — a runtime that takes an archive on its own command line:

      bundle sea -o node-verifying
      ./node-verifying ./my-app.zip --args --for --the --app

  a runtime built with a policy (-r, --identity, --issuer, --attester) is
  sealed: it accepts no policy from its command line, because a binary that
  demands a signing identity is not one whose user can ask it to stop. It
  checks attestations against the cache 'bundle trust' keeps current, and
  never the network.

  with an archive, the executable is built unsigned, and refuses to run until
  'bundle sign' signs it: the same create, audit, sign order as any archive,
  so what is signed is what was reviewed. A verifying node needs no
  signature of its own; it checks what it is handed.`,
    trust: `trust options:                      usage: trust [options]
      --mirror <url>    TUF repository to refresh from (default: sigstore's)
      --attester <who>  also keep this DID's or handle's attestations; repeatable
      --no-sigstore     refresh only the attestations

  attestations are kept for every attester named here, in BUNDLE_ATTESTERS,
  in an install record, or already in the cache: each one's attestations are
  listed, new ones fetched and verified, and withdrawn ones dropped. That is
  what a verifying runtime — which never reaches for the network — checks
  against, and what decides how stale its answer can be.`,
    policy: `policy options:                     usage: policy [show | init | check <file>] [options]
  -a, --app <name>      the rules for this installed name, apps section included
      --json            print the rules in force as JSON (merged — not a policy file)
      --system          the machine's file: the one init writes, or the one shown
      --user            the user's file (what init writes by default)
  -f, --force           init over a file that is already there

  with no subcommand, says what rules are in force and which files they come
  from. 'show' prints the policy files themselves; 'init' writes a starter file;
  'check' validates a file the way an install will read it.

  the policy is read from a file for the machine (/etc/bundle/policy.json, or
  BUNDLE_SYSTEM_POLICY) and one for the user (~/.config/bundle/policy.json, or
  BUNDLE_POLICY). Both are JSON, described by a JSON Schema published with each
  release; files written or shown here start with a "$schema" pointing at the
  one for this version, so an editor can complete and check them.`,
    lexicon: `lexicon options:                    usage: lexicon [check | publish] [options]
      --as <handle | did>  the account to publish from
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --dry-run         say what publish would write, and stop before signing in
      --force           publish even though DNS does not name that account yet
      --password-file <file>  an app password instead of signing in, for CI
                        (BUNDLE_ATPROTO_PASSWORD works too)

  with no subcommand, lists the lexicons this package carries and the DNS
  record each needs: a TXT record '_lexicon.<authority>' saying 'did=<DID>',
  naming the account whose repository publishes them. 'check' resolves that
  and compares what is published — verified — with what is here. 'publish'
  writes each as a com.atproto.lexicon.schema record from --as, signing in
  with access to that collection only, and reads it back.`,
    skill: `skill options:                      usage: skill [options] [name]
  -d, --dir <dir>       where to install (default: .claude/skills)
  -f, --force           overwrite files that are already there
  -l, --list            list the skills this package carries and stop`,
    shell: `shell options:                      usage: shell [bash | zsh | fish | powershell] [options]
      --every <time>    how often a new shell re-validates installs (default: 1d)
      --timeout <time>  how long it may wait for the network (default: 5s)
      --no-validate     leave out the re-validation
      --no-complete     leave out Tab completion

  prints what to load when a shell starts, for the shell named or the one
  $SHELL names:

      bash        eval "$(bundle shell bash)"       in ~/.bashrc
      zsh         eval "$(bundle shell zsh)"        in ~/.zshrc
      fish        bundle shell fish | source        in ~/.config/fish/config.fish
      powershell  bundle shell powershell | Out-String | Invoke-Expression
                                                    in $PROFILE

  'bundle install', installing itself, offers to add exactly that line, for
  the shell it is run from — Git Bash on Windows included, where bundle is
  run as 'bundle.nzip' and the setup uses that name, and PowerShell, whose
  profile is asked of PowerShell itself.

  Tab completion: commands, their options, the values those take, installed
  names, and file names where a file goes. And, in interactive shells,
  'bundle validate --quiet', so a warning about something you installed —
  someone marking it bad since — is the first thing a new terminal says. It
  asks the network at most once per --every, gives up after --timeout and
  answers from the cache, and says nothing when there is nothing to say.`,
};

/**
 * What `bundle <command> <subcommand> --help` prints, for the commands that
 * have subcommands. The command's own help lists them all.
 */
export const SUBCOMMAND_HELP: Record<string, Record<string, string>> = {
    suite: {
        add: `suite add options:                  usage: suite add [options] <listing>...
  -s, --suite <file>    the spec to add to (default: suite.json), made if
                        it is not there, named after the file
      --for <app>       install them as plugins: for the app installed from
                        this listing (@<handle or did>/<name>, or an at://
                        address) — for now, an app in the suite
  -y, --yes             require everything shown that can be
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --no-discover     do not ask the backlink index who has attested it

  each <listing> (@<handle or did>/<name>, or an at:// address) is fetched
  from its publisher's PDS and verified, the archive it names is fetched,
  and everything that vouches for it is shown, numbered, as an install shows
  it. Then: which of that should the suite require? The signature and good
  attestations can be required. What is chosen becomes the member's
  "require": a member that does not carry it is refused wherever the suite is
  installed. Adding a member again replaces it.

  for now, a plugin goes in only with its app: add the app first, then its
  plugins. A plugin for an app not in the suite, and anything for a shared
  scope, is refused — by this tool, as it writes suites, while how suites of
  plugins alone should work is settled.`,
        remove: `suite remove options:               usage: suite remove [options] <listing>...
  -s, --suite <file>    the spec (default: suite.json)

  takes members out, by what they were added as, their at:// address, or
  @<handle or did>/<name>. Exits 1 when one was not a member. Once
  published, an update removes them wherever the suite is installed and
  brought them.`,
        update: `suite update options:               usage: suite update [options] [listing]...
  -s, --suite <file>    the spec (default: suite.json)
  -y, --yes             require everything shown that can be
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --no-discover     do not ask the backlink index who has attested it

  asks again, for the members named or all of them, what the suite should
  require: each is fetched as 'add' fetches it, shown with what is required
  now marked — and what is required but no longer carried — and Enter keeps
  what is required now.`,
        validate: `suite validate options:             usage: suite validate [options] [@account/name | at:// | url | domain]
  -s, --suite <file>    the spec, when no published suite is named
                        (default: suite.json)
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --no-discover     do not ask the backlink index who has attested it

  checks that the file holds together — names, listings, scopes, the
  requirements' form — that every member's listing and every app one is for
  is there, that a plugin is for the app its listing says, and for now that
  each plugin's app is in the suite too — and then fetches
  what each listing serves now and checks that it carries what the suite
  requires of it. Judged by the suite's requirements alone, not this
  machine's policy. Each member's line names the URL and the hash of what it
  serves now. Exits 1 when anything does not hold. Named, a published suite
  is checked instead of a spec — before permitting it, say.`,
        show: `suite show options:                 usage: suite show [options] [@account/name | at:// | url | domain]
  -s, --suite <file>    the spec, when no published suite is named
                        (default: suite.json)
      --json            print the spec as it is

  prints the suite: its hash — what an attestation of it names — and each
  member, what it is for, and what it requires.`,
        publish: `suite publish options:              usage: suite publish [options]
  -s, --suite <file>    the spec (default: suite.json)
      --as <handle | did>  the account to publish from
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --password-file <file>  an app password instead of signing in, for CI
                        (BUNDLE_ATPROTO_PASSWORD works too)

  writes com.pipobscure.bundle.suite/<name> to the account's repository, so
  'bundle install @<handle>/<name>' installs it. Every member's listing, and
  every app one is for, is checked to be there first, before signing in —
  and, for now, that every plugin's app is in the suite (see 'suite add'). A
  suite cannot share its name with a listing on the same account: that
  address installs the listing. Publishing it again replaces it, keeping
  when it was first published; every install of it follows on its next
  update.`,
        attest: `suite attest options:               usage: suite attest [options] [@account/name | at:// | url | domain]
  -s, --suite <file>    the spec to attest, when no published suite is named
                        (default: suite.json)
      --as <handle | did>  the account to attest from
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --kind <kind>     what is vouched for: permitted, prohibited, …
      --verdict <good | bad>  vouch for it, or warn against it (default: good)
      --note <text>     a short note, for information
      --revoke          withdraw the account's attestation of it
      --password-file <file>  an app password instead of signing in, for CI
                        (BUNDLE_ATPROTO_PASSWORD works too)

  writes a com.pipobscure.bundle.attestation of the suite's hash: the sha256
  of what it says — its members, where each goes, and what each must carry,
  not its title or description — so any change to the suite makes another
  hash, which the attestation does not name. What is attested is shown first.

  installing a member of the suite, a good attestation of it counts as one of
  the member, said as coming 'via suite <name>' — unless the same attester
  has said something of the member itself, which wins. A policy that
  requires 'permitted@<did>' is met either way. A bad verdict refuses the
  suite, where the policy blocks on the attester, and never carries over to
  its members: they are judged on their own.`,
        unpublish: `suite unpublish options:            usage: suite unpublish [options] <name>
      --as <handle | did>  the account the suite is in
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --password-file <file>  an app password instead of signing in, for CI

  deletes the suite. Installs of it keep what they have; their updates say
  it is gone, and leave its members as they are. Exits 1 when there was none.`,
    },
    policy: {
        show: `policy show options:                usage: policy show [options]
      --system          only the machine's file
      --user            only the user's file

  prints the policy files themselves: the machine's (/etc/bundle/policy.json,
  or BUNDLE_SYSTEM_POLICY) and the user's (~/.config/bundle/policy.json, or
  BUNDLE_POLICY) — both, unless one is asked for.`,
        init: `policy init options:                usage: policy init [options]
      --user            write the user's file (the default)
      --system          write the machine's file instead
  -f, --force           replace a file that is already there

  writes a starter policy file, beginning with a "$schema" pointing at the
  JSON Schema for this version, so an editor can complete and check it.`,
        check: `policy check:                       usage: policy check <file>

  reads a policy file the way an install will, and says what is wrong with
  it if anything is.`,
    },
    lexicon: {
        check: `lexicon check:                      usage: lexicon check

  resolves each lexicon's authority from its '_lexicon.<authority>' TXT
  record, and compares what that account has published — verified — with
  what this package carries. Exits 1 when any is missing or different.`,
        publish: `lexicon publish options:            usage: lexicon publish [options]
      --as <handle | did>  the account to publish from
                        (default: BUNDLE_ATPROTO_IDENTIFIER)
      --dry-run         say what would be written, and stop before signing in
      --force           publish even though DNS does not name that account yet
      --password-file <file>  an app password instead of signing in, for CI
                        (BUNDLE_ATPROTO_PASSWORD works too)

  writes each lexicon as a com.atproto.lexicon.schema record from --as,
  signing in with access to that collection only, all as one batch. 'lexicon
  check' reads them back, verified.`,
    },
};

/**
 * The help for one command, or one of its subcommands: what `--help` after
 * it prints. Undefined for a command there is none of.
 */
export function helpFor(command: string, subcommand?: string | undefined): string | undefined {
    const own = Object.hasOwn(HELP, command) ? HELP[command] : undefined;
    if (own === undefined) return undefined;
    const sub = subcommand !== undefined && Object.hasOwn(SUBCOMMAND_HELP[command] ?? {}, subcommand) ? SUBCOMMAND_HELP[command]![subcommand] : undefined;
    return `${sub ?? own}

  -h, --help            show this help`;
}


/** Where a command's output goes. Swappable so tests need no subprocess. */
export interface Console {
    out(line: string): void;
    err(line: string): void;
    /**
     * Ask a person something and return the answer — present only when there
     * is a person to ask. Without it, a decision that needs one is not made.
     */
    ask?: ((question: string) => Promise<string>) | undefined;
    /** Open a URL for a person to sign in at (default: the system browser). */
    open?: ((url: string) => void) | undefined;
    /**
     * How each stream is formatted (see style.ts). Without it, both are plain:
     * the line-oriented text a script reads, which is what tests see too.
     */
    style?: { out: Style; err: Style } | undefined;
}

/** The styles `io` writes with: plain unless it says otherwise. */
export function styles(io: Console): { o: Style; e: Style } {
    return { o: io.style?.out ?? PLAIN, e: io.style?.err ?? PLAIN };
}

// Who signed or vouched for something, as a person reads it: a headline short
// enough for one line, and the detail under it. A sigstore identity is a URL
// or an address and its issuer another URL, which side by side run off any
// terminal; the commonest — a GitHub Actions workflow — reads best taken apart
// into the repository, the workflow, and the ref.
function signerLines(o: Style, identity: string, issuer?: string | undefined): string[] {
    const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/\.github\/workflows\/([^@]+)@(.+)$/.exec(identity);
    if (github && (!issuer || issuer === 'https://token.actions.githubusercontent.com')) {
        const [, repository, workflow, ref] = github as unknown as [string, string, string, string];
        return [`${o.bold(repository)} ${o.dim('via GitHub Actions')}`, o.dim(`${workflow} @ ${ref.replace(/^refs\/(?:heads|tags)\//, '')}`)];
    }
    return [o.bold(identity), ...(issuer ? [o.dim(`via ${issuer}`)] : [])];
}

function attesterLines(o: Style, who: { did: string; handle?: string | undefined; kind?: string | undefined; via?: string | undefined }): string[] {
    return [
        `${o.bold(who.handle ?? who.did)}${who.kind ? ` as ${who.kind}` : ''}`,
        ...(who.handle ? [o.dim(who.did)] : []),
        ...(who.via ? [o.dim(`via ${who.via}`)] : []),
    ];
}

// An attester as a policy or a record writes one: `kind@did`, or a bare DID.
function attesterSpecLines(o: Style, spec: string): string[] {
    const { subject, kind } = parseAttester(spec);
    return attesterLines(o, { did: subject, kind });
}

// A mark and a verb with the first line beside them, and the rest lined up
// under the words after the mark.
function marked(o: Style, indent: string, mark: Mark, verb: string, lines: string[], after = ''): string[] {
    const [first = '', ...rest] = lines;
    return [`${indent}${o.mark(mark, `${verb}${first ? ` ${first}` : ''}`)}${after}`, ...rest.map((line) => `${indent}   ${line}`)];
}

// What other modules log — install progress, sign-in prompts, waits on a rate
// limit — goes to stderr with its markers in the style of that stream.
function logger(io: Console): (line: string) => void {
    const { e } = styles(io);
    if (!e.people) return (line) => io.err(line);
    return (line) => { for (const each of line.split('\n')) io.err(e.line(each)); };
}

const CONSOLE: Console = {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    ask: process.stdin.isTTY && process.stderr.isTTY
        ? async (question) => {
            const READLINE = await import('node:readline/promises');
            const rl = READLINE.createInterface({ input: process.stdin, output: process.stderr });
            try {
                return await rl.question(question);
            } finally {
                rl.close();
            }
        }
        : undefined,
    style: { out: styleFor(process.stdout), err: styleFor(process.stderr) },
};

/** The exit code for an install or update that needs a decision nobody made, or that was declined. */
export const UNDECIDED = 4;

/**
 * The commands, in the order the usage text lists them. Keeping the dispatch
 * table and the help in one place is what stops the two drifting apart.
 */
export const COMMANDS: Record<string, (args: string[], io: Console) => number | Promise<number>> = {
    create, sign, audit, verify: check, attest, publish, unpublish, suite, run, search, listings, install, update, installed, validate, uninstall,
    sea, trust, policy: policyCommand, lexicon, skill, shell,
};

/**
 * Run one CLI invocation. `argv` is the user's arguments — everything after the
 * runtime and the entry point — and the return value is the process exit code,
 * so a caller decides what to do with it rather than being exited out from
 * under.
 */
export async function main(argv: string[], io: Console = CONSOLE): Promise<number> {
    const [cmd, ...rest] = argv;
    try {
        if (cmd === undefined) {
            io.out(USAGE);
            return 64;
        }
        if (cmd === '-h' || cmd === '--help' || (cmd === 'help' && rest[0] === undefined)) {
            io.out(USAGE);
            return 0;
        }
        if (cmd === 'help') {
            const help = helpFor(rest[0]!, rest[1]);
            if (help === undefined) throw new Error(`no command '${rest[0]}' — 'bundle --help' lists them`);
            io.out(help);
            return 0;
        }
        if (cmd === '-v' || cmd === '--version') {
            io.out(version());
            return 0;
        }
        // What a shell runs on Tab: not a command anyone types, so not listed.
        // It must never fail loudly — an error is simply nothing to offer.
        if (cmd === '__complete') {
            try {
                const COMPLETION = await import('./completion.ts');
                for (const line of await COMPLETION.respond(rest)) io.out(line);
            } catch {
                // nothing to offer
            }
            return 0;
        }
        const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
        if (!command) throw new Error(`unknown command: ${cmd} — 'bundle --help' lists them`);
        // --help wins over everything else on the line, which is not read: it
        // is what to type when unsure what the rest should be.
        const asked = askedForHelp(cmd, rest);
        if (asked) {
            io.out(helpFor(cmd, asked.subcommand)!);
            return 0;
        }
        return await command(rest, io);
    } catch (err) {
        io.err(styles(io).e.error(message(err)));
        return 70;
    }
}

// Whether `--help` (or `-h`) is among a command's own arguments, and for a
// command with subcommands, which one it is about. Its own arguments are those
// before a '--', and for `run`, those before the archive: what follows is the
// program's, so 'bundle run app.nzip --help' asks the program.
function askedForHelp(command: string, args: string[]): { subcommand?: string | undefined } | undefined {
    const end = args.indexOf('--');
    const own = command === 'run' ? splitRunArgs(args).mine : end < 0 ? args : args.slice(0, end);
    if (!own.includes('--help') && !own.includes('-h')) return undefined;
    const subcommands = SUBCOMMAND_HELP[command];
    return { subcommand: subcommands ? own.find((arg) => Object.hasOwn(subcommands, arg)) : undefined };
}

// The version of whatever is running — read from the package.json beside it,
// which inside the bundled CLI is the archive's own member, so it answers for
// the archive and not for some other copy of this package on the machine.
function version(): string {
    return packageVersion();
}

async function create(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({
        args,
        options: OPTIONS.create,
    });
    if (Boolean(values.key) !== Boolean(values.chain)) throw new Error('create: --key and --chain must be given together');
    if (values.launcher && values.prefix) throw new Error('create: --launcher and --prefix are alternatives');

    // The prefix is the archive's shape, decided here and nowhere else: it is
    // part of what an audit reviews, and signing keeps it. `--launcher` is
    // `--prefix <this package's shell-base>`, spelled so that nobody has to
    // know the prefix ships inside node_modules — with the node it asks for
    // set to what the app's engines.node says (see runtime.ts).
    let prefix = values.prefix;
    // A verifying node built as `--output node-verifying` is `node-verifying.exe`
    // on Windows; `--prefix node-verifying` means that one.
    if (prefix && process.platform === 'win32' && !FS.existsSync(prefix) && FS.existsSync(`${prefix}.exe`)) prefix = `${prefix}.exe`;

    // Read before the file list, so a mistyped date fails before anything is read.
    const date = values.date !== undefined ? parseDate(values.date) : undefined;
    // node writes a ZIP entry's time in local time, so one --date makes the
    // same bytes only in the same timezone. Any timezone is fine for anyone
    // who means it; UTC is the one every rebuild can agree on.
    const here = Temporal.Now.zonedDateTimeISO();
    const { e } = styles(io);
    if (date && !here.equals(here.withTimeZone('UTC'))) {
        io.err(e.warn(`the timezone here is ${here.timeZoneId}, not UTC: ZIP times are written in local time, so only a build in ${here.timeZoneId} ` +
            'with the same --date makes this same archive — build with TZ=UTC for one that is the same anywhere'));
    }
    const listing = values.files ? FS.readFileSync(values.files, 'utf-8') : await readStdin();
    const files = [...new Set(listing.split(/\r?\n/).filter(Boolean))].sort();
    if (!files.length) throw new Error('create: the file list is empty');

    // Written last, so nothing between here and the archive can leave it behind.
    let launcher: ReturnType<typeof import('./runtime.ts').writeLauncher> | undefined;
    if (values.launcher) {
        launcher = (await import('./runtime.ts')).writeLauncher(values.base);
        prefix = launcher.path;
        io.err(e.note(`launcher: runs with node ${launcher.minimum} or newer${launcher.range !== undefined ? ` (engines.node '${launcher.range}')` : ''}`));
        if (launcher.upper) io.err(e.warn(`engines.node '${launcher.range}' also has an upper bound, which the launcher does not check: it runs with any node from ${launcher.minimum} on`));
    }

    // A person is told how many; a log gets the list.
    if (e.people) {
        const what = values.output ? e.bold(values.output) : 'an archive';
        io.err(e.bundle(`building ${what}  ${e.dim(`${plural(files.length, 'member')}, ${values.hash} digests${values.key ? `, ${values.sign} signature` : ', unsigned'}`)}`));
        if (prefix) io.err(`   ${e.dim('prefix')}  ${launcher ? 'the #! launcher' : prefix}  ${e.dim(bytes(FS.statSync(prefix).size))}`);
        if (date) io.err(`   ${e.dim('dated')}   ${date.round({ smallestUnit: 'second', roundingMode: 'floor' }).toString()}`);
    } else {
        for (const file of files) io.err(`+ ${file}`);
        io.err(values.key
            ? `* signed archive (${files.length} members, ${values.hash} digests, ${values.sign} signature)`
            : `* unsigned archive (${files.length} members, ${values.hash} digests)`);
        if (prefix) io.err(`* prefix ${prefix} (${FS.statSync(prefix).size} bytes)`);
        if (date) io.err(`* every member dated ${date.round({ smallestUnit: 'second', roundingMode: 'floor' }).toString()}`);
    }

    const res = await createBundle({
        base: values.base, files, prefix, output: values.output, date,
        hashAlg: values.hash, signAlg: values.sign,
        key: values.key ? FS.readFileSync(values.key) : undefined,
        chain: values.chain ? FS.readFileSync(values.chain, 'utf-8') : undefined,
    }).finally(() => { if (launcher) FS.rmSync(launcher.dir, { recursive: true, force: true }); });
    io.err(!e.people ? `* ${values.key ? 'signed' : 'hash'}: ${res.hash}`
        : values.key ? e.signature(`signed  ${e.dim(String(res.hash))}`)
        : `   ${e.dim('hash')}    ${e.dim(String(res.hash))}`);
    return 0;
}

async function sign(args: string[], io: Console): Promise<number> {
    // The shape used to be chosen here. Say where it went, rather than
    // "unknown option".
    if (args.some((arg) => /^(?:-l|-p|--launcher|--prefix)(?:=|$)/.test(arg))) {
        throw new Error("sign: an archive's prefix is chosen when it is created, so that it is part of what is reviewed — " +
            "'bundle create --launcher' (or --prefix), then 'bundle sign' signs it as it is");
    }
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.sign,
    });
    const source = positionals[0];
    if (!source) throw new Error('sign: an archive path is required');
    if (Boolean(values.key) !== Boolean(values.chain)) throw new Error('sign: --key and --chain must be given together');

    const { e } = styles(io);
    const { prefixLength } = await import('./archive.ts');
    const prefix = prefixLength(source);
    if (e.people) {
        io.err(e.bundle(`${e.bold(source)}  ${e.dim(`${plural(members(source).length, 'member')}${prefix ? `, keeping its ${bytes(prefix)} prefix` : ''}`)}`));
    } else {
        for (const name of members(source)) io.err(`+ ${name}`);
        if (prefix) io.err(`* keeping its ${prefix}-byte prefix`);
    }

    const signer = await chooseSigner(values, io);

    // An archive is an `.nzip` whether it is signed or not. By default the
    // signed one goes where the name says: `app.unsigned.nzip` → `app.nzip`,
    // and a name without `.unsigned` is signed in place — replaced only once
    // the signed archive is complete. `-o -` is stdout.
    const output = values.output === undefined ? signedName(source) : values.output === '-' ? undefined : values.output;
    const res = await signBundle({
        source, output, executable: values.executable,
        hashAlg: values.hash, signAlg: values.sign, signer,
    });
    if (e.people) {
        io.err(e.signature(`signed  ${e.dim(String(res.hash))}`));
        if (res.output) io.err(e.bundle(`wrote ${e.bold(res.output)}  ${e.dim(bytes(res.size ?? 0))}`));
    } else {
        io.err(`* signed: ${res.hash}`);
        if (res.output) io.err(`* wrote ${res.output} (${res.size} bytes)`);
    }
    return 0;
}

async function check(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.verify,
    });
    const archive = values.archive ?? positionals[0];
    if (!archive) throw new Error('verify: an archive path is required');

    const { attesters, quorum, maxAge, block } = await policy(values);
    await fetchAttestations(archive, [...attesters, ...block], io);
    const res = await verifyBundle(archive, {
        roots: values.root ?? [],
        identity: values.identity,
        issuer: values.issuer,
        trustedRoot: values['sigstore-root'],
        attesters, quorum, maxAge, block,
    });
    report(res, Boolean(values.json), io, archive);
    return STATES[res.state].code;
}

// Vouch for an archive from an atproto account: a record in that account's own
// repository naming the archive's whole-file hash. Or withdraw it again.
async function attest(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.attest,
    });
    const archives = [...new Set(positionals)];
    // The same file 'publish --from' reads: each entry's archive, fetched
    // from its URL or its domain's, is attested as the local ones are.
    const listed = values.from !== undefined ? readListingFile(values.from, 'attest') : [];
    if (!archives.length && !listed.length) throw new Error('attest: at least one archive path is required (or --from <file>)');
    if (!(values.as ?? process.env['BUNDLE_ATPROTO_IDENTIFIER'])) throw new Error('attest: say which account with --as <handle or did>, or BUNDLE_ATPROTO_IDENTIFIER');
    if (values.kind !== undefined && !/^[A-Za-z0-9._-]+$/.test(values.kind)) throw new Error(`attest: '${values.kind}' is not a valid kind`);
    if (values.verdict !== 'good' && values.verdict !== 'bad') throw new Error(`attest: --verdict is good or bad, not '${values.verdict}'`);
    const verdict: 'good' | 'bad' = values.verdict;

    // Every archive is checked before anyone signs in, and one that does not
    // hold together stops the lot: a release is attested whole or not at all.
    // Vouching for bytes that do not hold together is never what anyone means
    // — and a warning about them is a warning about a file nobody is offered.
    const { o, e } = styles(io);
    const checked: { archive: string; hashAlg: string; hash: string }[] = [];
    for (const archive of archives) {
        const hashed = wholeFileHash(archive);
        if (!hashed) throw new Error(`attest: ${archive} carries no manifest, so it is not an archive this tool can vouch for`);
        if (!values.revoke) {
            const res = await verifyBundle(archive, { roots: values.root ?? [], deep: true, integrity: true });
            if (res.state === 'invalid') {
                io.err(e.error(`refusing to attest ${archive}: ${res.reason}`));
                return STATES.invalid.code;
            }
            if (res.hash !== hashed.hash) throw new Error(`attest: ${archive} changed while it was being checked`);
            io.err(e.people
                ? e.bundle(`${e.bold(archive)}  ${e.dim(`${res.signed ? 'signed' : 'unsigned'}, ${plural(res.digests?.size ?? 0, 'member')}, all digests match`)}`)
                : `* ${archive}: ${res.signed ? 'signed' : 'unsigned'}, ${res.digests?.size ?? 0} members, all digests match`);
        }
        checked.push({ archive, ...hashed });
    }
    for (const { where } of listed) {
        const fetched = await fetchListed(where, values.root ?? [], io, 'attest', !values.revoke);
        if (typeof fetched === 'number') return fetched;
        const hashed = wholeFileHash(fetched.bytes);
        if (!hashed) throw new Error(`attest: ${fetched.url} carries no manifest, so it is not an archive this tool can vouch for`);
        checked.push({ archive: fetched.url, ...hashed });
    }

    // One sign-in for everything named.
    const ATPROTO = await import('./atproto.ts');
    const { COLLECTION } = await import('./attestation.ts');
    const session = await signIn('attest', values, io, `atproto repo:${COLLECTION}`);
    try {
        // All of them in one batch, not a request each: every request counts
        // against the account's rate limits.
        if (values.revoke) {
            await ATPROTO.revokeAll(session, [...new Set(checked.map(({ hash }) => hash))]);
            for (const { archive, hashAlg, hash } of checked) {
                io.out(o.people
                    ? o.attestation(`withdrew ${o.bold(archive)}  ${o.dim(`${hashAlg}:${hash}`)}`)
                    : `withdrew ${session.did}'s attestation of ${archive} (${hashAlg}:${hash})`);
            }
        } else {
            const unique = [...new Map(checked.map((each) => [each.hash, each])).values()];
            const written = await ATPROTO.attestAll(session, unique.map(({ hashAlg, hash }) => ({ hashAlg, hex: hash, kind: values.kind, verdict, note: values.note })));
            for (const { archive, hashAlg, hash } of checked) {
                const uri = written[unique.findIndex((each) => each.hash === hash)]!.uri;
                if (o.people) {
                    io.out(o.attestation(`${verdict === 'bad' ? o.red(o.bold('marked bad')) : o.green('attested')} ${o.bold(archive)}${values.kind ? ` as ${values.kind}` : ''}`));
                    io.out(`   ${o.dim(`${hashAlg}:${hash}`)}`);
                    io.out(`   ${o.cyan(uri)}`);
                } else {
                    io.out(`${verdict === 'bad' ? 'marked bad' : 'attested'} ${archive} (${hashAlg}:${hash}) as ${session.did}${values.kind ? ` (${values.kind})` : ''}`);
                    io.out(`  ${uri}`);
                }
            }
        }
    } finally {
        await session.end?.();
    }
    return 0;
}

/** The flags every command that takes an attestation policy accepts. */
const POLICY_OPTIONS = {
    attester:  { type: 'string', multiple: true },
    quorum:    { type: 'string' },
    'max-age': { type: 'string' },
    block:     { type: 'string', multiple: true },
} as const;

interface PolicyValues {
    attester?: string[] | undefined;
    quorum?: string | undefined;
    'max-age'?: string | undefined;
    block?: string[] | undefined;
}

// Turn the policy flags into a policy: handles into DIDs — which takes the
// network, and is why it happens here rather than in the verifier — the quorum
// into a count, and the age into milliseconds.
async function policy(values: PolicyValues): Promise<{
    attesters: Attester[]; quorum?: number | undefined; maxAge?: number | undefined; block: Attester[];
}> {
    const specs = values.attester ?? [];
    let attesters: Attester[] = [];
    let block: Attester[] = [];
    if (specs.length || values.block?.length) {
        const ATPROTO = await import('./atproto.ts');
        attesters = await Promise.all(specs.map((spec) => ATPROTO.resolveAttester(spec)));
        block = await Promise.all((values.block ?? []).map(async (spec) => ({ did: (await ATPROTO.resolveAttester(spec)).did })));
    }
    let quorum: number | undefined;
    if (values.quorum !== undefined) {
        quorum = Number(values.quorum);
        if (!attesters.length) throw new Error('--quorum needs --attester');
        if (!Number.isInteger(quorum) || quorum < 1 || quorum > attesters.length) {
            throw new Error(`--quorum must be between 1 and the number of attesters (${attesters.length})`);
        }
    }
    const maxAge = values['max-age'] !== undefined ? parseDuration(values['max-age']) : undefined;
    return { attesters, quorum, maxAge, block };
}

// Fetch the attesters' proofs for this one archive, so the verification that
// follows sees the current answer. If that fails, the cache is what there is,
// and the policy's freshness window decides whether it is good enough.
async function fetchAttestations(archive: string, attesters: Attester[], io: Console): Promise<void> {
    if (!attesters.length) return;
    const hashed = wholeFileHash(archive);
    if (!hashed) return;
    const { refreshFor } = await import('./atproto.ts');
    for (const problem of await refreshFor(attesters, hashed.hashAlg, hashed.hash)) {
        io.err(styles(io).e.warn(`could not fetch an attestation, using the cache: ${problem}`));
    }
}

/** Print a verification result, as text or as the JSON `--json` produces. */
export function report(res: VerificationResult, json: boolean, io: Console, archive?: string | undefined): void {
    const state = STATES[res.state];
    if (json) {
        io.out(JSON.stringify({
            state: res.state, reason: res.reason, subject: res.subject,
            signed: res.signed, trusted: res.trusted, sigstore: Boolean(res.sigstore),
            identity: res.identity, issuer: res.issuer,
            signedAt: res.signedAt ? res.signedAt.toISOString() : undefined,
            hash: res.hash ? `${res.hashAlg}:${res.hash}` : undefined,
            attestations: res.attestations?.map((each) => ({
                did: each.did, handle: each.handle, required: each.kind, kind: each.attested,
                ok: each.ok, reason: each.reason, uri: each.uri, createdAt: each.createdAt,
                checkedAt: each.checkedAt?.toISOString(),
            })),
            members: res.digests ? [...res.digests.keys()] : undefined,
            code: state.code,
        }, null, 2));
        return;
    }
    const { o } = styles(io);
    if (o.people) {
        io.out(`${archive ? `${o.bundle(o.bold(archive))}  ` : ''}${o.bold(o.state(res.state, state.label))}`);
        // A good sigstore signature's reason is its identity, said again below.
        if (res.state !== 'valid' || !res.identity) io.out(`   ${res.reason ?? state.note}`);
        const field = (label: string, value: string) => io.out(`   ${o.dim(label.padEnd(9))} ${value}`);
        if (res.identity) {
            const lines = signerLines(o, res.identity, res.issuer);
            for (const line of marked(o, '   ', 'signature', 'signed by', [...lines, ...(res.signedAt ? [o.dim(`at ${res.signedAt.toISOString()}`)] : [])])) io.out(line);
        } else if (res.subject) {
            for (const line of marked(o, '   ', 'signature', 'certificate', res.subject.split('\n'))) io.out(line);
        }
        if (res.hash) field('hash', o.dim(`${res.hashAlg}:${res.hash}`));
        for (const each of res.attestations ?? []) {
            const lines = attesterLines(o, { did: each.did, handle: each.handle, kind: each.ok ? each.attested ?? each.kind : each.kind });
            if (each.ok) lines.push(...(each.createdAt ? [o.dim(`at ${each.createdAt}`)] : []));
            else lines.push(o.red(each.reason ?? 'missing'));
            for (const line of marked(o, '   ', 'attestation', each.ok ? 'attested by' : o.red('missing'), lines)) io.out(line);
        }
        return;
    }
    io.out(`${state.label} — ${res.reason ?? state.note}`);
    // For a sigstore signature the identity is the answer to "who signed this";
    // the certificate subject is an ephemeral Fulcio artifact and says nothing
    // useful.
    if (res.identity) io.out(`  identity: ${res.identity}`);
    if (res.issuer) io.out(`  issuer: ${res.issuer}`);
    if (res.signedAt) io.out(`  signed: ${res.signedAt.toISOString()}`);
    if (res.subject && !res.identity) io.out(`  certificate: ${res.subject.replace(/\n/g, ', ')}`);
    if (res.attestations) {
        if (res.hash) io.out(`  hash: ${res.hashAlg}:${res.hash}`);
        for (const each of res.attestations) {
            const who = each.handle ? `${each.handle} (${each.did})` : each.did;
            const kind = each.attested ?? each.kind;
            io.out(each.ok
                ? `  attested: ${who}${kind ? ` as ${kind}` : ''}${each.createdAt ? `, ${each.createdAt}` : ''}`
                : `  missing:  ${who}${each.kind ? ` as ${each.kind}` : ''} — ${each.reason}`);
        }
    }
}

const RUN_OPTIONS = {
    root:      { type: 'string',  short: 'r', multiple: true },
    identity:  { type: 'string' },
    issuer:    { type: 'string' },
    untrusted: { type: 'boolean' },
    attester:  { type: 'string', multiple: true },
    quorum:    { type: 'string' },
    'max-age': { type: 'string' },
    block:     { type: 'string', multiple: true },
} as const;

/**
 * Split `run`'s own arguments from the application's.
 *
 * This command is the one that forwards, so it stops as soon as it reaches
 * something that is not its own: options up to the archive belong to `run`, and
 * **everything after the archive belongs to the program**, flags included. That
 * is what makes
 *
 *     bundle run ./app verify ./app
 *
 * mean what it looks like, rather than quietly handing `verify` to a positional
 * that nothing reads. `--` is still accepted, and still ends the discussion —
 * it is only no longer required.
 */
export function splitRunArgs(args: string[]): { mine: string[]; archive?: string | undefined; theirs: string[] } {
    const takesValue = new Set(['--root', '-r', '--identity', '--issuer', '--attester', '--quorum', '--max-age', '--block']);
    const mine: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--') return { mine, archive: args[i + 1], theirs: args.slice(i + 2) };
        // A `--name=value` carries its own value; a bare `--name` eats the next
        // argument, and must, or the archive would be read out of it.
        if (arg.startsWith('-') && arg !== '-') {
            mine.push(arg);
            if (takesValue.has(arg) && !arg.includes('=')) {
                const value = args[++i];
                if (value !== undefined) mine.push(value);
            }
            continue;
        }
        // The first thing that is not an option is the archive, and the program
        // owns everything after it — including a leading `--`, which people
        // write out of habit.
        const rest = args.slice(i + 1);
        return { mine, archive: arg, theirs: rest[0] === '--' ? rest.slice(1) : rest };
    }
    return { mine, theirs: [] };
}

// Check an archive, mount it, and run what is inside — in this process, the way
// a verifying runtime does. Everything after the archive is the application's
// own argv.
async function run(args: string[], io: Console): Promise<number> {
    const { mine, archive, theirs } = splitRunArgs(args);
    const { values } = parseArgs({ args: mine, allowPositionals: false, options: OPTIONS.run });
    if (!archive) throw new Error('run: an archive path is required');
    const { attesters, quorum, maxAge, block } = await policy(values);
    await fetchAttestations(archive, [...attesters, ...block], io);

    try {
        return await runBundle(archive, {
            roots: values.root ?? [], identity: values.identity, issuer: values.issuer,
            attesters: attesters.map(formatAttester), quorum, maxAge, block: block.map(({ did }) => did),
            allowUntrusted: values.untrusted, args: theirs,
        });
    } catch (err) {
        if ((err as { code?: string }).code !== 'ERR_BUNDLE_UNTRUSTED') throw err;
        const state = (err as { state?: VerificationState }).state;
        io.err(styles(io).e.error(message(err)));
        return state ? STATES[state].code : 2;
    }
}

// Fetch a signed archive and put it on the PATH — `curl | sh` with the parts
// that make that dangerous taken out: nothing runs to install it, nothing lands
// anywhere until it verifies, and whoever vouches for it is shown to the person
// installing it, who decides.
async function install(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        allowNegative: true,
        options: OPTIONS.install,
    });
    const INSTALL = await import('./install.ts');
    const demands = await policy(values);
    if (values.for !== undefined && !positionals[0]) throw new Error('install: --for needs a plugin to install: a url, a domain, @account/name, or a folder to link');
    const scope = values.for !== undefined ? await scopeFor(values.for, INSTALL) : undefined;

    // With no URL, this package installs itself: the published release, signed
    // by the workflow that publishes it. `npx @pipobscure/bundle install` is
    // then the whole bootstrap — npm fetches it once, and what stays behind is
    // a signed archive that updates itself from its own releases.
    const target = positionals[0] ?? INSTALL.self().url;
    if (!positionals[0]) {
        // Already here: nothing to fetch — 'update' is what brings a newer one
        // — but the shell this is being run from may be new to it, so that
        // part is still offered. Switching shells is one 'bundle install'.
        const existing = Object.values(INSTALL.records()).find((record) => record.url === target);
        const { o } = styles(io);
        if (existing && FS.existsSync(INSTALL.pathOf(existing))) {
            io.out(o.people
                ? `${o.bundle(`${o.bold(existing.name)} is already installed`)}  ${o.dim(`in ${existing.dir} — 'bundle update' fetches a newer one`)}`
                : `${existing.name} is already installed in ${existing.dir} ('bundle update' fetches a newer one)`);
            if (values.shell) await offerShellHook(io);
            return 0;
        }
        io.err(styles(io).e.note(`installing this package itself from ${target}`, 'bundle'));
    }

    try {
        const record = await INSTALL.install(target, {
            roots: values.root ?? [], name: values.name, dir: values.dir, scope,
            identity: values.identity, issuer: values.issuer,
            attesters: demands.attesters, quorum: demands.quorum, block: demands.block,
            discover: values.discover,
            onReview: (review, about) => showReview(review, about, io),
            decide: decider(Boolean(values.yes), io),
            log: logger(io),
        });
        // Installed by hand, it is the person's own, whatever suite has it too.
        if (record.link === undefined) (await import('./suite-install.ts')).adopt(record, INSTALL.sourceOf(record));
        const { o } = styles(io);
        io.out(o.people
            ? record.link !== undefined
                ? `${o.bundle(`${o.bold(record.label ?? record.name)} linked for ${o.bold(record.scope!)}`)}  ${o.dim(`(${record.package})`)}\n` +
                  `   ${o.yellow('⚠')} loaded from ${record.link} as it is, and refused by anything that verifies plugins`
                : record.scope !== undefined
                ? `${o.bundle(`${o.bold(record.label ?? record.name)} ${o.green('installed')} for ${o.bold(record.scope)}`)}  ${o.dim(`(${record.package}) in ${record.dir}`)}`
                : `${o.bundle(`${o.bold(record.name)} ${o.green('installed')}`)}  ${o.dim(`in ${record.dir}`)}`
            : record.link !== undefined
            ? `${record.label} (${record.package}) linked for ${record.scope}: loaded from ${record.link} as it is, and refused by anything that verifies plugins`
            : record.scope !== undefined
            ? `${record.label} (${record.package}) installed for ${record.scope}, in ${record.dir}`
            : `${record.name} installed in ${record.dir}`);
        // Installing itself is setting up a machine, so it offers the rest of
        // the setup too: the shell hook, for the shell this is being run from.
        if (!positionals[0] && values.shell) await offerShellHook(io);
        return 0;
    } catch (err) {
        // A suite: its members, each installed as it would be by itself.
        const { code, suite } = err as { code?: string; suite?: import('./suite.ts').FoundSuite };
        if (code === 'ERR_BUNDLE_SUITE') {
            if (values.name !== undefined || values.for !== undefined) throw new Error(`install: ${target} is a suite — its members say where each goes, so --name and --for do not apply`);
            const SUITES = await import('./suite-install.ts');
            try {
                const result = await SUITES.installSuite(target, { ...suiteOptions(values, demands, io), dir: values.dir, suite });
                return reportSuites([result], io);
            } catch (refusedSuite) {
                return refused(refusedSuite, io);
            }
        }
        return refused(err, io);
    }
}

// What installing or updating a suite is told: the same as any install, and
// how to ask, once, about everyone the suite expects its members to carry.
function suiteOptions(values: { root?: string[] | undefined; identity?: string | undefined; issuer?: string | undefined; discover?: boolean | undefined; yes?: boolean | undefined },
    demands: Awaited<ReturnType<typeof policy>>, io: Console): import('./suite-install.ts').SuiteOptions {
    return {
        roots: values.root ?? [], identity: values.identity, issuer: values.issuer,
        attesters: demands.attesters.length ? demands.attesters : undefined, quorum: demands.quorum, block: demands.block,
        discover: values.discover,
        onReview: (review, about) => showReview(review, about, io),
        decide: decider(Boolean(values.yes), io),
        confirm: confirmer(Boolean(values.yes), io),
        log: logger(io),
    };
}

// The one question a suite asks: whom, of everyone it expects its members to
// carry, to accept for those members. All of them with --yes; the person's
// choice on a terminal; otherwise none, and each member is its own question.
function confirmer(yes: boolean, io: Console) {
    return async (offer: import('./suite-install.ts').Offer, about: { name: string; source: string }): Promise<REVIEW.Accepted> => {
        const lines = [
            ...offer.signers.map((each) => ({ kind: 'signer' as const, each, text: `signed by   ${each.identity} via ${each.issuer}` })),
            ...offer.attesters.map((each) => ({ kind: 'attester' as const, each, text: `attested by ${each.kind ? `${each.kind}@` : ''}${each.did}` })),
        ];
        const short = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
        const { e } = styles(io);
        if (e.people) {
            io.err('');
            io.err(e.bundle(`suite ${e.bold(about.name)} expects its members to carry:`));
            for (const [i, { kind, each }] of lines.entries()) {
                const block = kind === 'signer'
                    ? marked(e, '      ', 'signature', 'signed by', signerLines(e, (each as { identity: string }).identity, (each as { issuer: string }).issuer))
                    : marked(e, '      ', 'attestation', 'attested by', attesterLines(e, each as { did: string; kind?: string }));
                block[0] = `  ${e.cyan(String(i + 1).padStart(2))}  ${block[0]!.trimStart()}`;
                block.push(`         ${e.dim(`for ${each.members.map(short).join(', ')}`)}`);
                io.err('');
                for (const line of block) io.err(line);
            }
        } else {
            io.err(`* suite ${about.name} expects its members to carry:`);
            for (const [i, { each, text }] of lines.entries()) io.err(`  ${String(i + 1).padStart(2)} ${text} — for ${each.members.map(short).join(', ')}`);
        }
        let picked: typeof lines = [];
        if (yes) picked = lines;
        else if (io.ask) {
            for (;;) {
                const answer = (await io.ask(prompt(e, 'accept which, for those members?', `numbers (${lines.length > 1 ? '1,2' : '1'}), 'all', or Enter to decide each on its own`))).trim().toLowerCase();
                if (!answer || answer === 'n' || answer === 'no' || answer === 'none') break;
                if (answer === 'all' || answer === 'a' || answer === 'y' || answer === 'yes') { picked = lines; break; }
                const numbers = answer.split(/[\s,]+/).map(Number);
                if (numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= lines.length)) { picked = [...new Set(numbers)].map((n) => lines[n - 1]!); break; }
                io.err(`  ${e.people ? e.yellow(`'${answer}' is not one of 1–${lines.length}`) : `'${answer}' is not one of 1–${lines.length}`}`);
            }
        }
        return {
            signers: picked.flatMap(({ kind, each }) => (kind === 'signer' ? [{ identity: (each as { identity: string }).identity, issuer: (each as { issuer: string }).issuer }] : [])),
            certificates: [],
            attesters: picked.flatMap(({ kind, each }) => (kind === 'attester' ? [(each as { did: string }).did] : [])),
        };
    };
}

// What became of each suite's members, and the exit code the worst of it
// makes — as 'update' reports its installs.
function reportSuites(results: import('./suite-install.ts').SuiteResult[], io: Console): number {
    let code = 0;
    const { o, e } = styles(io);
    for (const { suite, members, problem } of results) {
        if (problem !== undefined) {
            io.out(o.people ? `${o.bundle(`suite ${o.bold(suite.name)}`)}  ${o.red('✖ not asked')} ${o.dim(`— ${problem}`)}` : `suite ${suite.name}: not asked — ${problem}`);
            code = Math.max(code, 70);
            continue;
        }
        const count = (state: string) => members.filter((member) => member.state === state).length;
        const parts = [['installed', 'installed'], ['present', 'already here'], ['removed', 'removed'], ['kept', 'kept'], ['left-out', 'left out']]
            .flatMap(([state, said]) => (count(state!) ? [`${count(state!)} ${said}`] : []));
        io.out(o.people ? `${o.bundle(`suite ${o.bold(suite.name)}`)}  ${o.dim(parts.join(', ') || 'nothing to do')}` : `suite ${suite.name}: ${parts.join(', ') || 'nothing to do'}`);
        for (const member of members) {
            const what = member.install ?? member.listing;
            if (o.people) {
                if (member.state === 'installed') io.out(`   ${o.green('+')} ${o.bundle(o.bold(what))}  ${o.dim('installed')}`);
                else if (member.state === 'removed') io.out(`   ${o.red('-')} ${o.bundle(o.bold(what))}  ${o.dim('removed')}`);
                else if (member.state !== 'present') {
                    const bad = member.state === 'refused' || member.state === 'failed';
                    io.out(`   ${bad ? o.red('✖') : o.yellow('⚠')} ${o.bundle(o.bold(what))}  ${bad ? o.red(member.state) : o.yellow(member.state)}${member.reason ? o.dim(` — ${member.reason}`) : ''}`);
                }
            } else if (member.state === 'installed' || member.state === 'removed') io.out(`  ${member.state} ${what}`);
            else if (member.state !== 'present') io.out(`  ${what}: ${member.state}${member.reason ? ` — ${member.reason}` : ''}`);
            code = Math.max(code, member.state === 'refused' ? STATES[member.review?.state ?? 'invalid'].code
                : member.state === 'failed' ? 70
                : member.state === 'declined' || member.state === 'unconfirmed' ? UNDECIDED
                : 0);
        }
        if (members.some((member) => member.state === 'unconfirmed')) io.err(`  ${e.dim('run on a terminal to decide, or pass --yes to accept what was shown')}`);
    }
    return code;
}

// The scope `--for` names: an installed app by the name it was installed as,
// which is turned into its package name — the name the app knows itself by at
// runtime, and which survives `--name` — or a package name given directly.
async function scopeFor(value: string, INSTALL: typeof import('./install.ts')): Promise<string> {
    const app = INSTALL.records()[value];
    if (app && app.scope === undefined) return appPackage(value, app, INSTALL);

    // The app as it is listed: `@<handle or did>/<name>` or its at:// address,
    // which is the app installed here from that listing. `@pipobscure.com/dns`
    // could also be read as a package name, but a handle that resolves says
    // which was meant.
    const listed = await listingOf(value);
    if (listed) {
        const host = Object.values(INSTALL.records()).find((record) => record.scope === undefined && INSTALL.sourceOf(record) === listed);
        if (!host) throw new Error(`install: ${value} is ${listed}, which no app installed here came from — install the app first ('bundle install ${value}'), then its plugins`);
        return appPackage(value, host, INSTALL);
    }
    const { isScope } = await import('./policy.ts');
    if (!isScope(value)) throw new Error(`install: --for takes an installed app, @<handle or did>/<name>, a listing's at:// address, or a package name; '${value}' is none of those`);
    return value;
}

// The package name an installed app knows itself by: the scope its plugins go in.
function appPackage(value: string, app: import('./install.ts').InstallRecord, INSTALL: typeof import('./install.ts')): string {
    let name = app.package;
    if (!name) {
        try {
            name = INSTALL.packageName(FS.readFileSync(INSTALL.pathOf(app)));
        } catch {
            // said below
        }
    }
    if (!name) throw new Error(`install: ${value} carries no package name to install plugins for — name the scope instead`);
    return name;
}

// The at:// address a listing reference names, or undefined when it names
// none: an at:// address as it is, and `@<handle or did>/<name>` with its
// handle resolved. A handle that does not resolve is not one, and the value
// is left to be read as a package name.
async function listingOf(value: string): Promise<string | undefined> {
    const LISTING = await import('./listing.ts');
    if (LISTING.parseListingUri(value)) return value;
    const match = /^@([^/]+)\/([^/]+)$/.exec(value);
    if (!match || !LISTING.isName(match[2]!)) return undefined;
    const [, who, name] = match as unknown as [string, string, string];
    if (who.startsWith('did:')) return LISTING.listingUri(who, name);
    if (!who.includes('.')) return undefined;
    try {
        const ATPROTO = await import('./atproto.ts');
        return LISTING.listingUri((await ATPROTO.resolveHandle(who)).did, name);
    } catch {
        return undefined;
    }
}

// Add `bundle shell` to the startup file of the shell `bundle install` was run
// from — asked first, never assumed: it is somebody's own file. With nobody to
// ask, say what to add instead. What decides is the shell, not the platform:
// Git Bash on Windows is bash, and PowerShell is PowerShell wherever it runs.
async function offerShellHook(io: Console): Promise<void> {
    const COMPLETION = await import('./completion.ts');
    const program = await selfProgram();
    const shell = COMPLETION.detectShell();
    const { e } = styles(io);
    if (!shell) {
        // Neither SHELL nor PowerShell is cmd.exe, which has no programmable
        // completion; a SHELL that names something else gets a pointer.
        if (process.env['SHELL']) io.err(e.note("for Tab completion and a daily re-check of installs at shell start, see 'bundle shell --help'"));
        return;
    }
    const file = COMPLETION.startupFile(shell);
    if (COMPLETION.hasHook(file)) {
        io.err(e.note(`${file} already loads bundle's shell setup`));
        return;
    }
    const line = COMPLETION.hookLine(shell, program);
    const answer = io.ask
        ? (await io.ask(e.people
            ? `\n${e.cyan('?')} add Tab completion, and a quiet daily re-check of what you install, to ${e.bold(file)}? ${e.dim('[Y/n]')} `
            : `* add Tab completion, and a quiet daily re-check of what you install, to ${file}? [Y/n] `)).trim().toLowerCase()
        : undefined;
    if (answer === undefined || answer === 'n' || answer === 'no') {
        io.err(e.note(`for Tab completion and a daily re-check of installs at shell start, add to ${file}:`));
        io.err(`    ${e.people ? e.bold(line) : line}`);
        return;
    }
    COMPLETION.addHook(shell, process.env, program);
    io.err(e.note(`added to ${file} — new ${shell} shells have it ('bundle uninstall' takes it out again)`));
}

/** What `install` and `update` both take. */
const INSTALL_OPTIONS = {
    root:      { type: 'string', short: 'r', multiple: true },
    identity:  { type: 'string' },
    issuer:    { type: 'string' },
    attester:  { type: 'string', multiple: true },
    quorum:    { type: 'string' },
    block:     { type: 'string', multiple: true },
    discover:  { type: 'boolean', default: true },
    yes:       { type: 'boolean', short: 'y' },
} as const;

// The exit code for an install that did not happen, and the line that says why.
function refused(err: unknown, io: Console): number {
    const code = (err as { code?: string }).code;
    const { e } = styles(io);
    if (code === 'ERR_BUNDLE_UNCONFIRMED') {
        io.err(e.error(message(err)));
        io.err(`  ${e.dim('nobody accepted for it before vouches for it, so it is up to you: run this on a terminal to choose, or pass --yes to accept what is shown above')}`);
        return UNDECIDED;
    }
    if (code === 'ERR_BUNDLE_DECLINED') {
        io.err(e.people ? e.yellow(message(err)) : message(err));
        return UNDECIDED;
    }
    if (code !== 'ERR_BUNDLE_UNTRUSTED') throw err;
    const state = (err as { state?: VerificationState }).state;
    io.err(e.error(message(err)));
    return state ? STATES[state].code : 2;
}

/** Show everything a review found, numbered where it can be chosen. */
export function showReview(review: REVIEW.Review, about: { name: string; url: string }, io: Console): void {
    const { e } = styles(io);
    if (e.people) {
        showReviewTo(review, about, io, e);
        return;
    }
    io.err(`* ${about.name}: ${review.hashAlg}:${review.hash} (${review.signed ? 'signed' : 'unsigned'})`);
    let n = 0;
    for (const item of review.items) {
        const label = item.evidence.type === 'signature' ? 'signed by'
            : item.evidence.type === 'certificate' ? 'certificate'
            : item.evidence.verdict === 'bad' ? 'WARNING' : 'attested by';
        const when = item.evidence.type === 'attestation' && item.evidence.createdAt ? `, ${item.evidence.createdAt}` : '';
        const what = `${label.padEnd(11)} ${REVIEW.describe(item.evidence)}${when}`;
        if (item.excluded) {
            const why = item.evidence.type === 'attestation' && item.evidence.verdict === 'bad' ? 'marked it bad' : item.excluded;
            io.err(`     ${what} — ${why}`);
        } else {
            io.err(`  ${String(++n).padStart(2)} ${what} — ${item.known ?? 'new'}`);
        }
    }
    if (!review.items.length) io.err('     nothing vouches for it');
    for (const note of review.notes) io.err(`  ! ${note}`);
}

// The same review, for a person: what the bundle is, then each thing that
// vouches for it — a signature, a certificate, an attestation — one to a line,
// numbered where it can be chosen, and what is known of it on the right.
function showReviewTo(review: REVIEW.Review, about: { name: string }, io: Console, e: Style): void {
    io.err('');
    io.err(`${e.bundle(e.bold(about.name))}  ${review.signed ? '' : `${e.yellow('unsigned')}  `}${e.dim(`${review.hashAlg}:${review.hash}`)}`);
    let n = 0;
    for (const item of review.items) {
        const evidence = item.evidence;
        const bad = evidence.type === 'attestation' && evidence.verdict === 'bad';
        const [mark, verb, lines]: [Mark, string, string[]] = evidence.type === 'signature' ? ['signature', 'signed by', signerLines(e, evidence.identity, evidence.issuer)]
            : evidence.type === 'certificate' ? ['signature', 'certificate', [...evidence.subject.split('\n'), ...(evidence.anchored ? [] : [e.yellow('not anchored')])]]
            : ['attestation', bad ? e.red(e.bold('WARNING from')) : 'attested by', [...attesterLines(e, evidence), ...(evidence.createdAt ? [e.dim(`at ${evidence.createdAt}`)] : [])]];
        const standing = item.excluded ? (bad ? e.red('marked it bad') : e.dim(item.excluded)) : item.known ? e.green(item.known) : e.yellow('new — not accepted before');
        const block = marked(e, '      ', mark, verb, [...lines, standing]);
        // The number sits in the margin of the first line, where it can be found.
        if (!item.excluded) block[0] = `  ${e.cyan(String(++n).padStart(2))}  ${block[0]!.trimStart()}`;
        io.err('');
        for (const line of block) io.err(line);
    }
    if (!review.items.length) io.err(`      ${e.yellow('nothing vouches for it')}`);
    if (review.notes.length) io.err('');
    for (const note of review.notes) io.err(`  ${e.warn(note)}`);
}

// A question for the person at the terminal: `  question hint: ` plainly, and
// with the hint dimmed for people.
function prompt(e: Style, question: string, hint: string): string {
    return e.people ? `${e.cyan('?')} ${question} ${e.dim(hint)} ${e.cyan('›')} ` : `  ${question} ${hint}: `;
}

// How an install that needs a decision gets one: everything, with --yes; the
// person at the terminal, if there is one; otherwise nobody, and it stops.
function decider(yes: boolean, io: Console) {
    if (yes) return async (review: REVIEW.Review) => REVIEW.selectable(review);
    const ask = io.ask;
    if (!ask) return undefined;
    return async (review: REVIEW.Review, about: { name: string }) => {
        const choices = REVIEW.selectable(review);
        const { e } = styles(io);
        io.err(e.people ? `${e.bundle(e.bold(about.name))}  ${review.reason}` : `* ${about.name}: ${review.reason}`);
        for (;;) {
            const answer = (await ask(prompt(e, 'accept which?', `numbers (${choices.length > 1 ? '1,2' : '1'}), 'all', or Enter to decline`))).trim().toLowerCase();
            if (!answer || answer === 'n' || answer === 'no' || answer === 'none') return [];
            if (answer === 'all' || answer === 'a' || answer === 'y' || answer === 'yes') return choices;
            const picked = answer.split(/[\s,]+/).map(Number);
            if (picked.every((index) => Number.isInteger(index) && index >= 1 && index <= choices.length)) {
                return [...new Set(picked)].map((index) => choices[index - 1]!);
            }
            io.err(`  ${e.people ? e.yellow(`'${answer}' is not one of 1–${choices.length}`) : `'${answer}' is not one of 1–${choices.length}`}`);
        }
    };
}

// Re-ask the URL an install came from, and replace what is there if the answer
// changed and is accepted — by what was accepted before, or by the person.
async function update(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        allowNegative: true,
        options: OPTIONS.update,
    });

    const INSTALL = await import('./install.ts');
    const SUITES = await import('./suite-install.ts');
    const demands = await policy(values);

    // Suites first: asked what they hold now, members added installed and
    // those taken out removed. Then every install as usual — a suite's, when
    // one is named — less what was just installed.
    const target = positionals[0];
    const suite = target !== undefined && !INSTALL.records()[target] ? SUITES.findSuite(target) : undefined;
    const suited = target === undefined || suite !== undefined
        ? await SUITES.updateSuites(suite, suiteOptions(values, demands, io))
        : [];
    const suiteCode = reportSuites(suited.filter((result) => result.problem !== undefined || result.members.some((member) => !['present', 'left-out'].includes(member.state))), io);
    const fresh = new Set(suited.flatMap((result) => result.members.filter((member) => member.state === 'installed').map((member) => member.install!)));
    const names = suite !== undefined ? SUITES.installsOf(SUITES.suites()[suite]!).filter((name) => INSTALL.records()[name] && !fresh.has(name))
        : target === undefined ? Object.keys(INSTALL.records()).filter((name) => !fresh.has(name)).sort()
        : target;
    const results = await INSTALL.update(names, {
        roots: values.root ?? [], identity: values.identity, issuer: values.issuer,
        attesters: demands.attesters.length ? demands.attesters : undefined,
        quorum: demands.quorum, block: demands.block,
        discover: values.discover,
        onReview: (review, about) => showReview(review, about, io),
        decide: decider(Boolean(values.yes), io),
        log: logger(io),
    });

    const changed = results.filter((result) => result.state === 'updated');
    const stuck = results.filter((result) => result.state !== 'updated' && result.state !== 'unchanged');
    const { o, e } = styles(io);
    if (o.people) {
        io.out('');
        io.out(changed.length
            ? o.bundle(`${o.green(`${changed.length} of ${plural(results.length, 'bundle')} updated`)}: ${changed.map((result) => o.bold(result.record.name)).join(', ')}`)
            : o.bundle(`${plural(results.length, 'bundle')} checked, ${o.green('nothing changed')}`));
        for (const result of stuck) {
            const bad = result.state === 'refused' || result.state === 'failed';
            io.out(`   ${bad ? o.red('✖') : o.yellow('⚠')} ${o.bold(result.record.name)}  ${bad ? o.red(result.state) : o.yellow(result.state)}${result.reason ? o.dim(` — ${result.reason}`) : ''}`);
        }
    } else {
        io.out(changed.length
            ? `${changed.length} of ${results.length} updated: ${changed.map((result) => result.record.name).join(', ')}`
            : `${results.length} checked, nothing changed`);
        for (const result of stuck) io.out(`  ${result.record.name}: ${result.state} — ${result.reason ?? ''}`);
    }
    if (stuck.some((result) => result.state === 'unconfirmed')) {
        io.err(`  ${e.dim('run on a terminal to decide, or pass --yes to accept what was shown')}`);
    }

    // The worst outcome decides the exit code.
    return stuck.reduce((code, result) => Math.max(code,
        result.state === 'refused' ? STATES[result.review?.state ?? 'invalid'].code
        : result.state === 'failed' ? 70
        : UNDECIDED), suiteCode);
}

// What is installed, and whether it is still what was installed. The record
// says what the bytes were; this is where that claim gets checked rather than
// merely printed.
async function installed(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({
        args,
        options: OPTIONS.installed,
    });

    const INSTALL = await import('./install.ts');
    const SUITES = await import('./suite-install.ts');
    // Withdrawn attestations and new warnings only show up if they are asked
    // about; asking is cheap, and a failure leaves the cache to answer.
    const { o, e } = styles(io);
    for (const problem of await INSTALL.refreshInstalled()) io.err(e.warn(`could not fetch an attestation, using the cache: ${problem}`));
    const checks = INSTALL.installed({ roots: values.root ?? [] });

    if (values.json) {
        io.out(JSON.stringify(checks.map(({ record, path, state, sha256, reason, review }) => ({
            name: record.name, scope: record.scope, package: record.package, label: INSTALL.labelOf(record), path,
            commands: record.scope === undefined ? INSTALL.commandsOf(record) : undefined, state, sha256, reason,
            source: INSTALL.sourceOf(record), url: record.url, identity: record.identity, issuer: record.issuer,
            attestedBy: record.attestedBy, accepted: INSTALL.acceptedOf(record), suites: SUITES.suitesOf(record.name),
            warnings: review ? INSTALL.warningsOf(review) : [], at: record.at,
        })), null, 2));
    } else if (!checks.length) {
        io.out(o.people ? o.dim('nothing installed') : 'nothing installed');
    } else if (o.people) {
        showInstalled(checks, io, o, INSTALL, SUITES);
    } else {
        for (const { record, path, state, reason, review } of checks) {
            io.out(`${record.name}  ${state === 'ok' ? 'OK' : state.toUpperCase()}`);
            if (record.scope !== undefined) io.out(`  plugin: ${INSTALL.labelOf(record)} (${record.package}), for ${record.scope}`);
            const suites = SUITES.suitesOf(record.name);
            if (suites.length) io.out(`  suite:  ${suites.join(', ')}`);
            io.out(`  at:     ${path}`);
            if (record.stored !== undefined) {
                const commands = INSTALL.commandsOf(record);
                io.out(`  runs as: ${commands.length ? commands.join(', ') : `nothing — no link in ${record.dir} points at it`}`);
            }
            const source = INSTALL.sourceOf(record);
            if (record.link !== undefined) io.out(`  linked: ${record.link}`);
            else if (source !== record.url) io.out(`  source: ${source}`);
            if (record.link === undefined) io.out(`  from:   ${record.url}`);
            if (record.identity) io.out(`  signer: ${record.identity}${record.issuer ? ` via ${record.issuer}` : ''}`);
            else if (record.subject) io.out(`  signer: ${record.subject.replace(/\n/g, ', ')}`);
            if (record.attestedBy?.length) io.out(`  attested by: ${record.attestedBy.join(', ')}`);
            if (record.link === undefined) io.out(`  sha256: ${record.sha256}`);
            io.out(`  since:  ${record.at}`);
            if (state !== 'ok') io.out(`  ${reason}`);
            for (const warning of review ? INSTALL.warningsOf(review) : []) io.out(`  ${warning}`);
        }
        // The suites, and any of their members that are not installed.
        for (const suite of Object.values(SUITES.suites()).sort((a, b) => a.name.localeCompare(b.name))) {
            io.out(`suite ${suite.name}  ${suite.members.length} member${suite.members.length === 1 ? '' : 's'}`);
            io.out(`  from:   ${suite.label ?? suite.source}`);
            for (const member of suite.members) {
                if (member.removed) io.out(`  left out: ${member.listing}`);
                else if (member.install === undefined || !INSTALL.records()[member.install]) io.out(`  not installed: ${member.listing} — 'bundle update ${suite.name}' tries again`);
            }
        }
    }

    // The worst thing found decides the exit code, so a script can gate on it:
    // anything but `ok` is something a person should look at.
    const worst = checks.reduce((code, { state }) => Math.max(code, state === 'ok' ? 0
        : state === 'missing' || state === 'changed' ? 2
        : STATES[state].code), 0);
    return worst;
}

// What 'installed' prints for a person: each install as a card — its name
// and state, then where it is, where it came from, and who signed and vouched
// for it — and then the suites.
function showInstalled(checks: import('./install.ts').InstalledCheck[], io: Console, o: Style,
    INSTALL: typeof import('./install.ts'), SUITES: typeof import('./suite-install.ts')): void {
    const field = (label: string, value: string) => io.out(`   ${o.dim(label.padEnd(8))} ${value}`);
    for (const [i, { record, path, state, reason, review }] of checks.entries()) {
        const status = state === 'ok' ? o.green('✔ OK')
            : state === 'missing' || state === 'changed' || state === 'invalid' ? o.red(`✖ ${state.toUpperCase()}`)
            : o.yellow(`⚠ ${state.toUpperCase()}`);
        if (i) io.out('');
        io.out(`${o.bundle(o.bold(record.name))}  ${status}`);
        if (state !== 'ok') io.out(`   ${state === 'missing' || state === 'changed' || state === 'invalid' ? o.red(reason ?? '') : o.yellow(reason ?? '')}`);
        for (const warning of review ? INSTALL.warningsOf(review) : []) io.out(`   ${o.attestation(o.red(warning))}`);
        if (record.scope !== undefined) field('plugin', `${INSTALL.labelOf(record)} ${o.dim(`(${record.package})`)}, for ${o.bold(record.scope)}`);
        const suites = SUITES.suitesOf(record.name);
        if (suites.length) field('suite', suites.join(', '));
        field('at', path);
        if (record.stored !== undefined) {
            const commands = INSTALL.commandsOf(record);
            if (!commands.length) field('runs as', o.yellow(`nothing — no link in ${record.dir} points at it`));
            for (const [n, command] of commands.entries()) field(n ? '' : 'runs as', command);
        }
        const source = INSTALL.sourceOf(record);
        if (record.link !== undefined) field('linked', o.yellow(record.link));
        else if (source !== record.url) field('source', source);
        if (record.link === undefined) field('from', o.dim(record.url));
        if (record.identity) for (const line of marked(o, '   ', 'signature', 'signed by', signerLines(o, record.identity, record.issuer))) io.out(line);
        else if (record.subject) for (const line of marked(o, '   ', 'signature', 'signed by', record.subject.split('\n'))) io.out(line);
        for (const attester of record.attestedBy ?? []) for (const line of marked(o, '   ', 'attestation', 'attested by', attesterSpecLines(o, attester))) io.out(line);
        if (record.link === undefined) field('sha256', o.dim(record.sha256));
        field('since', o.dim(record.at));
    }
    for (const suite of Object.values(SUITES.suites()).sort((a, b) => a.name.localeCompare(b.name))) {
        io.out('');
        io.out(`${o.bundle(`suite ${o.bold(suite.name)}`)}  ${o.dim(plural(suite.members.length, 'member'))}`);
        field('from', suite.label ?? suite.source);
        for (const member of suite.members) {
            if (member.removed) field('left out', o.dim(member.listing));
            else if (member.install === undefined || !INSTALL.records()[member.install]) {
                io.out(`   ${o.yellow('⚠')} not installed: ${member.listing} ${o.dim(`— 'bundle update ${suite.name}' tries again`)}`);
            }
        }
    }
}

// List archives under names, from an atproto account: a record naming each
// one's URL, which is how others find it and what `install @<account>/<name>`
// fetches. Several are listed as one batch, under one sign-in.
async function publish(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS.publish });
    const LISTING = await import('./listing.ts');

    // What to list: <name> <url | domain> pairs, and the entries of --from.
    const wanted: { name: string; where: string; title?: string | undefined; description?: string | undefined; for?: string | undefined }[] = [];
    if (positionals.length % 2) throw new Error('publish: each name needs a URL or a domain after it');
    for (let i = 0; i < positionals.length; i += 2) {
        wanted.push({ name: positionals[i]!, where: positionals[i + 1]!, title: values.title, description: values.description, for: values.for });
    }
    if (values.from !== undefined) {
        for (const entry of readListingFile(values.from, 'publish')) wanted.push({ ...entry, for: entry.for ?? values.for });
    }
    if (!wanted.length) throw new Error('publish: a name, and a URL or a domain, are required (or --from <file>)');
    if (wanted.length > 1 && (values.title !== undefined || values.description !== undefined)) {
        throw new Error('publish: --title and --description describe one listing — for several, give each its own in --from');
    }
    for (const { name } of wanted) {
        if (!LISTING.isName(name)) throw new Error(`publish: '${name}' is not a listing name (lowercase letters, digits and '-', at most 64)`);
    }

    // Before anyone signs in: every listing must point at an archive. One
    // that points at nothing, or at something that is not an archive, is a
    // typo nobody should publish — and stops the lot.
    const listings: import('./listing.ts').Publishing[] = [];
    const apps = new Map<string, Awaited<ReturnType<typeof appListing>>>();
    for (const each of wanted) {
        const fetched = await fetchListed(each.where, values.root ?? [], io, 'publish');
        if (typeof fetched === 'number') return fetched;
        const checked = fetched.domain ? { domain: fetched.domain } : { url: fetched.url };
        let app: Awaited<ReturnType<typeof appListing>> | undefined;
        if (each.for !== undefined) {
            app = apps.get(each.for) ?? await appListing('publish', each.for, true);
            apps.set(each.for, app);
            io.err(styles(io).e.note(`listing ${each.name} as a plugin for ${app.label} (${app.uri})`, 'bundle'));
        }
        listings.push({ name: each.name, ...checked, for: app?.uri, title: each.title, description: each.description });
    }

    const session = await signIn('publish', values, io, `atproto repo:${LISTING.LISTING}`);
    try {
        const written = await LISTING.publishAll(session, listings);
        const { o, e } = styles(io);
        for (const [i, { uri, replaced }] of written.entries()) {
            const { name, for: app } = wanted[i]!;
            const installed = app !== undefined ? apps.get(app)?.installed : undefined;
            const command = `bundle install ${app !== undefined ? `--for ${installed ?? '<the app>'} ` : ''}@${session.handle ?? session.did}/${name}`;
            if (o.people) {
                io.out(o.bundle(`${o.green(replaced ? 'updated' : 'published')} ${o.bold(name)}  ${o.dim(`as ${session.did}`)}`));
                io.out(`   ${o.cyan(uri)}`);
                io.err(`   ${e.dim('install it with:')} ${e.bold(command)}`);
            } else {
                io.out(`${replaced ? 'updated' : 'published'} ${name} as ${session.did}`);
                io.out(`  ${uri}`);
                io.err(`  install it with: ${command}`);
            }
        }
    } finally {
        await session.end?.();
    }
    return 0;
}

/** One entry of the file 'publish --from' and 'attest --from' read. */
interface ListingEntry {
    name: string;
    /** The archive's https URL, or a domain whose `nzip:` record names it. */
    where: string;
    title?: string | undefined;
    description?: string | undefined;
    for?: string | undefined;
}

// The file 'publish --from' and 'attest --from' both read: a JSON array of
// { "name", "url" | "domain", "title"?, "description"?, "for"? } — one file
// for a release, which lists it and vouches for it alike.
function readListingFile(file: string, command: string): ListingEntry[] {
    let entries: unknown;
    try {
        entries = JSON.parse(FS.readFileSync(file, 'utf-8'));
    } catch (err) {
        throw new Error(`${command}: ${file} is not JSON: ${message(err)}`);
    }
    if (!Array.isArray(entries)) throw new Error(`${command}: ${file} is not an array of listings`);
    return entries.map((entry, i) => {
        const { name, url, domain, title, description, for: app } = (entry ?? {}) as Record<string, unknown>;
        const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
        if (typeof name !== 'string' || (typeof url === 'string') === (typeof domain === 'string')) {
            throw new Error(`${command}: ${file}, entry ${i + 1}: needs a "name", and a "url" or a "domain"`);
        }
        return { name, where: (url ?? domain) as string, title: text(title), description: text(description), for: text(app) };
    });
}

// What one listing names, fetched and checked: a URL as it is, or a domain —
// which 'publish' lists instead of the URL its `nzip:` record names, so the
// publisher keeps managing that in DNS — and in either case an archive that
// holds together, unless `verify` is false (withdrawing an attestation needs
// only the hash). An exit code, when it does not hold together.
async function fetchListed(where: string, roots: string[], io: Console, command: string, verify = true): Promise<{ url: string; domain?: string | undefined; bytes: Buffer } | number> {
    const LISTING = await import('./listing.ts');
    let url: string;
    let domain: string | undefined;
    const { e } = styles(io);
    if (/^[a-z][a-z0-9+.-]*:/i.test(where)) {
        if (!/^https:\/\//i.test(where)) throw new Error(`${command}: '${where}' is not an https URL`);
        url = where;
    } else {
        domain = where.replace(/\.$/, '').toLowerCase();
        if (!LISTING.isListedDomain(domain)) throw new Error(`${command}: '${where}' is neither an https URL nor a domain name`);
        const INSTALL = await import('./install.ts');
        url = (await INSTALL.resolveAlias(domain)).url;
        io.err(e.note(`${domain} names ${url}`));
    }

    io.err(e.note(`fetching ${url}`));
    const { patientFetch } = await import('./ratelimit.ts');
    const response = await patientFetch(globalThis.fetch, { onWait: logger(io) })(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${command}: ${url}: ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!wholeFileHash(bytes)) throw new Error(`${command}: ${url} is not an archive this tool can install`);
    if (!verify) return { url, domain, bytes };
    const res = await verifyBundle(bytes, { roots, deep: true, integrity: true });
    if (res.state === 'invalid') {
        io.err(e.error(`refusing to ${command} ${url}: ${res.reason}`));
        return STATES.invalid.code;
    }
    if (e.people) {
        io.err(e.bundle(`${e.bold(url)}  ${e.dim(`${plural(res.digests?.size ?? 0, 'member')}, all digests match`)}`));
        if (res.signed) for (const line of marked(e, '   ', 'signature', res.identity ? 'signed by' : 'signed', res.identity ? signerLines(e, res.identity, res.issuer) : [])) io.err(line);
        else io.err(`   ${e.warn('it is unsigned: installs will only accept it on the strength of attestations')}`);
    } else {
        io.err(`* ${url}: ${res.signed ? `signed${res.identity ? ` by ${res.identity}` : ''}` : 'unsigned'}, ${res.digests?.size ?? 0} members, all digests match`);
        if (!res.signed) io.err('  ! it is unsigned: installs will only accept it on the strength of attestations');
    }
    return { url, domain, bytes };
}

// Take listings down: those that are there, as one batch.
async function unpublish(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS.unpublish });
    if (!positionals.length) throw new Error('unpublish: a name is required');
    const LISTING = await import('./listing.ts');
    for (const name of positionals) if (!LISTING.isName(name)) throw new Error(`unpublish: '${name}' is not a listing name`);
    const session = await signIn('unpublish', values, io, `atproto repo:${LISTING.LISTING}`);
    try {
        const { removed, missing } = await LISTING.unpublishAll(session, positionals);
        const { o, e } = styles(io);
        for (const name of removed) io.out(o.people ? o.bundle(`unpublished ${o.bold(name)}  ${o.dim(`from ${session.did}`)}`) : `unpublished ${name} from ${session.did}`);
        for (const name of missing) io.err(e.error(`${session.did} has no listing called '${name}'`));
        return missing.length ? 1 : 0;
    } finally {
        await session.end?.();
    }
}

// The line that says whose account is about to be written to.
function signedIn(session: { did: string; pds: string; how: string }, e: Style): string {
    return e.people
        ? `${e.cyan('›')} signed in as ${e.bold(session.did)}  ${e.dim(`at ${session.pds}, through ${session.how}`)}`
        : `* signed in as ${session.did} at ${session.pds}, through ${session.how}`;
}

// Sign in to write to an account's repository, with access to `scope` only
// where the server supports that: an app password for CI, OAuth otherwise.
async function signIn(command: string, values: { as?: string | undefined; 'password-file'?: string | undefined }, io: Console, scope: string) {
    const identifier = values.as ?? process.env['BUNDLE_ATPROTO_IDENTIFIER'];
    if (!identifier) throw new Error(`${command}: say which account with --as <handle or did>, or BUNDLE_ATPROTO_IDENTIFIER`);
    // Never from an argument: a command line is visible to every process on
    // the machine, and ends up in shell history.
    const password = values['password-file']
        ? FS.readFileSync(values['password-file'], 'utf-8').trim()
        : process.env['BUNDLE_ATPROTO_PASSWORD'];
    const ATPROTO = await import('./atproto.ts');
    const OAUTH = await import('./oauth.ts');
    const session = password
        ? await ATPROTO.login(identifier, password)
        : await OAUTH.oauthLogin(identifier, { log: logger(io), open: io.open, scope });
    io.err(signedIn(session, styles(io).e));
    return Object.assign(session, { handle: identifier.startsWith('did:') ? undefined : identifier.replace(/^@/, '').toLowerCase() });
}

// Search the listings: the local index, synced first when it is stale.
async function search(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS.search });
    const text = positionals.join(' ');
    const LISTING = await import('./listing.ts');
    if (!LISTING.matchQuery(text)) throw new Error('search: say what to search for');
    const app = values.for !== undefined ? await appListing('search', values.for, !values.offline) : undefined;
    await freshIndex(values, io, app?.uri);
    const found = LISTING.search(text, undefined, { for: app?.uri });
    printListings(found, Boolean(values.json), io, app);
    if (!found.length && !values.json) io.err(styles(io).e.dim(`nothing listed${app ? ` for ${app.label}` : ''} matches '${text}'`));
    return 0;
}

// Every listing in the local index, synced first when it is stale.
async function listings(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({ args, options: OPTIONS.listings });
    const LISTING = await import('./listing.ts');
    const app = values.for !== undefined ? await appListing('listings', values.for, !values.offline) : undefined;
    await freshIndex(values, io, app?.uri);
    const found = LISTING.listings(undefined, { for: app?.uri });
    printListings(found, Boolean(values.json), io, app);
    if (!found.length && !values.json) io.err(styles(io).e.dim(app ? `no plugins listed for ${app.label}` : 'nothing listed'));
    return 0;
}

// The app `--for` names, by its listing: an installed app made from a listing,
// `@<handle or did>/<name>`, or a listing's at:// address. Plugins are listed
// against the app's listing, so an app installed from a URL or a domain has
// plugins only by URL or domain — `install --for` still takes those.
async function appListing(command: string, value: string, online: boolean): Promise<{ uri: string; label: string; installed?: string | undefined }> {
    const INSTALL = await import('./install.ts');
    const LISTING = await import('./listing.ts');
    const record = INSTALL.records()[value];
    if (record && record.scope === undefined) {
        const source = INSTALL.sourceOf(record);
        if (!LISTING.parseListingUri(source)) {
            throw new Error(`${command}: ${value} was installed from ${source}, not from a listing, so nothing is listed for it — its plugins install from a URL or a domain, with 'bundle install --for ${value}'`);
        }
        return { uri: source, label: value, installed: value };
    }
    if (LISTING.parseListingUri(value)) return { uri: value, label: value };
    if (!value.startsWith('@')) throw new Error(`${command}: --for takes an installed app, @<handle or did>/<name>, or a listing's at:// address; '${value}' is none of those`);
    if (!online) throw new Error(`${command}: finding ${value} needs the network — name the app as it is installed, or by its at:// address`);
    const found = await LISTING.resolveListing(value);
    if (LISTING.appOf(found.record)) throw new Error(`${command}: ${value} is itself a plugin, for ${LISTING.appOf(found.record)}`);
    return { uri: found.uri, label: value };
}

// Sync the listing index if it is older than an hour, or built from some other
// backlink index, or --refresh says so. A sync that fails leaves the index to
// answer as it is, and says how old that is; only no index at all is an error.
async function freshIndex(values: { refresh?: boolean | undefined; offline?: boolean | undefined }, io: Console, app?: string | undefined): Promise<void> {
    const LISTING = await import('./listing.ts');
    const POLICY = await import('./policy.ts');
    const INSTALL = await import('./install.ts');
    if (values.refresh && values.offline) throw new Error('--refresh and --offline are alternatives');
    const last = LISTING.lastSync();
    // Plugins are followed only for the apps installed here from a listing,
    // and for the one asked about.
    const apps = [...new Set([
        ...Object.values(INSTALL.records()).filter((record) => record.scope === undefined).map((record) => INSTALL.sourceOf(record))
            .filter((source) => LISTING.parseListingUri(source)),
        ...(app ? [app] : []),
    ])];
    if (values.offline) {
        if (!last) throw new Error('there is no listing index yet — run this without --offline once');
        return;
    }
    const index = POLICY.loadPolicy().discovery;
    const { e } = styles(io);
    const stale = (why: string) => {
        if (!last) throw new Error(`no listing index, and ${why}`);
        io.err(e.warn(`${why} — the index is from ${last.at.toISOString()}`));
    };
    if (!index) return stale("discovery is turned off by the policy ('bundle policy')");
    const covered = last !== null && apps.every((uri) => last.subjects.includes(uri));
    if (!values.refresh && last && last.index === index && covered && Date.now() - last.at.getTime() < LISTING.INDEX_AGE) return;

    io.err(e.note(`syncing the listing index from ${index}`));
    try {
        const report = await LISTING.syncIndex({ index, apps });
        const counts = `${report.listings} listing${report.listings === 1 ? '' : 's'} from ${report.publishers} publisher${report.publishers === 1 ? '' : 's'}` +
            `${report.refreshed ? `, ${report.refreshed} refreshed` : ''}${report.removed ? `, ${report.removed} gone` : ''}`;
        io.err(`  ${e.dim(counts)}`);
        for (const { did, error } of report.failed) io.err(`  ${e.warn(`${did}: ${error} — kept what the index had`)}`);
    } catch (err) {
        stale(`could not sync (${message(err)})`);
    }
}

function printListings(found: import('./listing.ts').Listing[], json: boolean, io: Console, app?: { label: string; installed?: string | undefined } | undefined): void {
    if (json) {
        io.out(JSON.stringify(found.map(({ install, did, handle, name, title, description, url, domain, createdAt, for: forApp }) => ({
            install, did, handle, name, title, description, url, domain, for: forApp, createdAt,
        })), null, 2));
        return;
    }
    const { o, e } = styles(io);
    if (app && found.length) io.err(e.note(`plugins for ${app.label}; install one with: bundle install --for ${app.installed ?? '<the app>'} <the first column>`, 'bundle'));
    const width = Math.max(0, ...found.map((each) => each.install.length));
    for (const each of found) {
        const about = [each.title && each.title !== each.name ? each.title : undefined, each.description].filter(Boolean).join(' — ');
        // For people the name is what to copy, so it stands out, and the rest
        // steps back; the padding is computed on the plain name either way.
        if (o.people) io.out(`${o.bundle(o.bold(each.install))}${about ? `${' '.repeat(width - each.install.length)}  ${o.dim(about)}` : ''}`);
        else io.out(about ? `${each.install.padEnd(width)}  ${about}` : each.install);
    }
}

// The lexicons attestations and listings are written in: which there are, where each should
// be published, whether it is, and publishing them.
async function lexicon(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.lexicon,
    });
    const LEXICON = await import('./lexicon.ts');
    const docs = LEXICON.lexicons();
    const [sub] = positionals;
    const { o, e } = styles(io);

    if (sub === undefined) {
        for (const doc of docs) {
            io.out(o.bold(doc.id));
            io.out(`  ${o.dim('dns:   ')} TXT _lexicon.${LEXICON.authorityOf(doc.id)}  "did=<the publishing account's DID>"`);
            io.out(`  ${o.dim('record:')} at://<that DID>/${LEXICON.SCHEMA_COLLECTION}/${doc.id}`);
        }
        return 0;
    }

    if (sub === 'check') {
        let worst = 0;
        for (const status of await LEXICON.checkLexicons()) {
            const what = status.state === 'current' ? 'published, and current'
                : status.state === 'different' ? 'published, but not this version'
                : status.state === 'unpublished' ? `not published by ${status.authority}`
                : `no authority — ${status.dns} has no 'did=' TXT record`;
            io.out(o.people
                ? `${status.state === 'current' ? o.green('✔') : status.state === 'different' ? o.yellow('⚠') : o.red('✖')} ${o.bold(status.nsid)}  ${o.dim(what)}`
                : `${status.nsid}: ${what}`);
            if (status.uri) io.out(`  ${o.people ? o.cyan(status.uri) : status.uri}`);
            if (status.state !== 'current') worst = 1;
        }
        return worst;
    }

    if (sub !== 'publish') throw new Error(`lexicon: unknown subcommand '${sub}' (check or publish)`);
    const identifier = values.as ?? process.env['BUNDLE_ATPROTO_IDENTIFIER'];
    if (!identifier) throw new Error('lexicon: say which account with --as <handle or did>, or BUNDLE_ATPROTO_IDENTIFIER');

    if (values['dry-run']) {
        const ATPROTO = await import('./atproto.ts');
        const { did } = await ATPROTO.resolveAttester(identifier);
        for (const doc of docs) {
            const authority = await LEXICON.authorityDid(doc.id);
            const dns = `_lexicon.${LEXICON.authorityOf(doc.id)}`;
            io.out(o.bold(doc.id));
            io.out(`  would write at://${did}/${LEXICON.SCHEMA_COLLECTION}/${doc.id}`);
            io.out(authority === did ? `  ${dns} names ${did}: ${o.green('good')}`
                : authority ? `  ${dns} names ${authority}, not ${did}: ${o.red('publish would refuse')}`
                : `  ${dns} has no 'did=' record: ${o.yellow(`add TXT "did=${did}" first`)}`);
        }
        return 0;
    }

    const session = await signIn('lexicon', values, io, `atproto repo:${LEXICON.SCHEMA_COLLECTION}`);
    try {
        for (const each of await LEXICON.publishLexicons(session, { force: values.force })) {
            io.out(o.people ? `${o.green('published')} ${o.bold(each.nsid)}` : `published ${each.nsid}`);
            io.out(`  ${o.people ? o.cyan(each.uri) : each.uri}`);
            if (each.authority !== session.did) io.err(`  ${e.warn(`${each.dns} does not name ${session.did} yet, so nothing can resolve it until it does`)}`);
        }
    } finally {
        await session.end?.();
    }
    return 0;
}

// What a shell loads at start: Tab completion, and a quiet re-validation of
// everything installed.
async function shell(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, allowNegative: true, options: OPTIONS.shell });
    const COMPLETION = await import('./completion.ts');
    parseDuration(values.every);
    parseDuration(values.timeout);
    const shell = positionals[0] ?? COMPLETION.currentShell();
    io.out(COMPLETION.script(shell, {
        complete: values.complete, validate: values.validate, every: values.every, timeout: values.timeout,
    }, await selfProgram()).trimEnd());
    return 0;
}

// How a shell runs this package: by whatever name it is installed under —
// `bundle`, or `bundle.nzip` where the extension stays — and, for PowerShell on
// Windows, as node with the installed archive mounted, which is what its file
// association runs, but with output PowerShell can capture.
async function selfProgram(): Promise<import('./completion.ts').Program> {
    const COMPLETION = await import('./completion.ts');
    const INSTALL = await import('./install.ts');
    const urls = [INSTALL.self().url, INSTALL.SELF.url];
    const record = Object.values(INSTALL.records()).find((each) => urls.includes(each.url));
    const name = record?.name ?? 'bundle';
    return process.platform === 'win32' && record
        ? COMPLETION.programAt(name, process.execPath, PATH.join(record.dir, record.name))
        : COMPLETION.programNamed(name);
}

// The rules this machine installs by: what is in force, the files themselves,
// a file to start from, and a check of one.
async function policyCommand(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.policy,
    });
    const POLICY = await import('./policy.ts');
    const [sub, file] = positionals;
    const which = values.system ? POLICY.systemPolicyPath() : POLICY.userPolicyPath();

    if (sub === 'init') {
        if (FS.existsSync(which) && !values.force) throw new Error(`policy: ${which} is already there (--force to replace it)`);
        FS.mkdirSync(PATH.dirname(which), { recursive: true });
        FS.writeFileSync(which, POLICY.formatPolicyFile(POLICY.starterPolicy(), version()));
        const { o, e } = styles(io);
        io.out(o.people ? `${o.green('wrote')} ${o.bold(which)}` : `wrote ${which}`);
        io.err(`  ${e.dim(`its "$schema" is ${POLICY.schemaUrl(version())}`)}`);
        return 0;
    }
    if (sub === 'check') {
        if (!file) throw new Error('policy: check needs a file');
        // `readPolicyFile` is what installs read policies with; null is a file
        // that is not there, which is worth saying differently from a bad one.
        if (!POLICY.readPolicyFile(PATH.resolve(file))) throw new Error(`policy: ${file} does not exist`);
        const { o } = styles(io);
        io.out(o.people ? `${o.green('✔')} ${o.bold(file)}  ${o.dim('a valid policy file')}` : `${file}: a valid policy file`);
        return 0;
    }
    if (sub === 'show') {
        const paths = [
            ...(values.system || !values.user ? [POLICY.systemPolicyPath()] : []),
            ...(values.user || !values.system ? [POLICY.userPolicyPath()] : []),
        ];
        let shown = 0;
        const { e } = styles(io);
        for (const path of paths) {
            const read = POLICY.readPolicyFile(path);
            if (!read) {
                io.err(e.people ? `${e.cyan('›')} ${path}  ${e.dim('none')}` : `* ${path}: none`);
                continue;
            }
            io.err(e.people ? `${e.cyan('›')} ${e.bold(path)}` : `* ${path}`);
            io.out(POLICY.formatPolicyFile(read, version()).trimEnd());
            shown++;
        }
        if (!shown) io.err(`  ${e.dim("no policy files — 'bundle policy init' writes one")}`);
        return 0;
    }
    if (sub !== undefined) throw new Error(`policy: unknown subcommand '${sub}' (show, init or check)`);

    const effective = POLICY.loadPolicy(values.app);
    if (values.json) {
        io.out(JSON.stringify({
            ...effective,
            systemFile: POLICY.systemPolicyPath(), userFile: POLICY.userPolicyPath(),
        }, null, 2));
        return 0;
    }
    const { o } = styles(io);
    if (o.people) {
        showPolicy(effective, io, o, POLICY);
        return 0;
    }
    io.out(`machine policy: ${POLICY.systemPolicyPath()}${effective.files.includes(POLICY.systemPolicyPath()) ? '' : ' (none)'}`);
    io.out(`user policy:    ${POLICY.userPolicyPath()}${effective.files.includes(POLICY.userPolicyPath()) ? '' : ' (none)'}`);
    io.out(`schema:         ${POLICY.schemaUrl(version())}`);
    const list = (items: string[]) => (items.length ? items.join(', ') : 'none');
    io.out(`required:`);
    io.out(`  signature:   ${effective.signature.length ? `yes (${list(effective.signature)})` : 'no'}`);
    io.out(`  same issuer: ${effective.sameIssuer.length ? `yes (${list(effective.sameIssuer)})` : 'no'}`);
    for (const { attesters, quorum, source } of effective.attesters) {
        io.out(`  attesters:   ${quorum ? `${quorum} of ` : ''}${attesters.map(formatAttester).join(', ')} (${source})`);
    }
    for (const { list: issuers, source } of effective.issuers) io.out(`issuers:       ${issuers.join(', ')} (${source})`);
    io.out(`trusted signers:   ${list(effective.trust.signers.map((signer) => `${signer.identity} via ${signer.issuer}`))}`);
    io.out(`trusted attesters: ${list(effective.trust.attesters.map(formatAttester))}`);
    if (effective.trust.certificates.length) io.out(`trusted roots:     ${list(effective.trust.certificates)}`);
    io.out(`blocks on:         ${list(effective.block.map(({ did }) => did))}`);
    io.out(`ignores:           ${list(effective.ignore)}`);
    io.out(`discovery:         ${effective.discovery || 'off'}`);
    if (effective.maxAge !== undefined) io.out(`max age:           ${Math.round(effective.maxAge / 1000)}s`);
    return 0;
}

// The policy in force, for a person: the files it comes from, then what it
// requires, whom it trusts, and whom it will not hear from, grouped.
function showPolicy(effective: ReturnType<typeof import('./policy.ts').loadPolicy>, io: Console, o: Style, POLICY: typeof import('./policy.ts')): void {
    const list = (items: string[]) => (items.length ? items.join(', ') : o.dim('none'));
    const field = (label: string, value: string) => io.out(`   ${o.dim(label.padEnd(12))} ${value}`);
    const file = (path: string) => (effective.files.includes(path) ? path : `${o.dim(path)} ${o.dim('(none)')}`);
    io.out(o.bold('files'));
    field('machine', file(POLICY.systemPolicyPath()));
    field('user', file(POLICY.userPolicyPath()));
    field('schema', o.dim(POLICY.schemaUrl(version())));
    io.out('');
    const out = (lines: string[]) => { for (const line of lines) io.out(line); };
    io.out(o.bold('required'));
    out(marked(o, '   ', 'signature', 'a signature ', [effective.signature.length ? `yes ${o.dim(`(${effective.signature.join(', ')})`)}` : o.dim('no')]));
    out(marked(o, '   ', 'signature', 'same issuer ', [effective.sameIssuer.length ? `yes ${o.dim(`(${effective.sameIssuer.join(', ')})`)}` : o.dim('no')]));
    for (const { attesters, quorum, source } of effective.attesters) {
        out(marked(o, '   ', 'attestation', `attested by${quorum ? ` ${quorum} of` : ''}`, [o.dim(`(${source})`)]));
        for (const attester of attesters) out(attesterLines(o, { did: attester.did, kind: attester.kind }).map((line) => `      ${line}`));
    }
    for (const { list: issuers, source } of effective.issuers) field('issuers', `${issuers.join(', ')} ${o.dim(`(${source})`)}`);
    io.out('');
    io.out(o.bold('trusted'));
    if (!effective.trust.signers.length) out(marked(o, '   ', 'signature', 'signers  ', [o.dim('none')]));
    for (const signer of effective.trust.signers) out(marked(o, '   ', 'signature', 'signed by', signerLines(o, signer.identity, signer.issuer)));
    if (!effective.trust.attesters.length) out(marked(o, '   ', 'attestation', 'attesters', [o.dim('none')]));
    for (const attester of effective.trust.attesters) out(marked(o, '   ', 'attestation', 'attested by', attesterLines(o, { did: attester.did, kind: attester.kind })));
    if (effective.trust.certificates.length) field('roots', list(effective.trust.certificates));
    io.out('');
    field('blocks on', effective.block.length ? o.red(effective.block.map(({ did }) => did).join(', ')) : o.dim('none'));
    field('ignores', list(effective.ignore));
    field('discovery', effective.discovery || o.dim('off'));
    if (effective.maxAge !== undefined) field('max age', `${Math.round(effective.maxAge / 1000)}s`);
}

// Re-check installs against what is known now, and say what has changed since
// the last look — quietly, when nothing has, so it can run at every login.
async function validate(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.validate,
    });
    const INSTALL = await import('./install.ts');
    // One deadline for every request this run makes, so a shell starting
    // without a network waits --timeout at most, and the cache answers.
    const deadline = values.timeout !== undefined ? AbortSignal.timeout(parseDuration(values.timeout)) : undefined;
    const results = await INSTALL.validate(positionals, {
        roots: values.root ?? [],
        every: values.every !== undefined ? parseDuration(values.every) : undefined,
        network: deadline ? { fetch: (input, init) => globalThis.fetch(input, { ...init, signal: deadline }) } : {},
    });

    // What deserves attention: a new warning, or an install that is no longer
    // what it was or no longer vouched for. A new good attestation is news,
    // not a problem.
    const exit = (each: Validation) => Math.max(
        each.added.some((seen) => seen.verdict === 'bad') ? 1 : 0,
        each.check.state === 'ok' ? 0
            : each.check.state === 'missing' || each.check.state === 'changed' || each.check.state === 'invalid' ? 2
            : each.check.state === 'unsigned' ? 3 : 1);
    const code = results.reduce((worst, each) => Math.max(worst, exit(each)), 0);

    if (values.json) {
        io.out(JSON.stringify(results.map((each) => ({
            name: each.record.name, state: each.check.state, reason: each.check.reason, skipped: each.skipped,
            added: each.added, removed: each.removed, problems: each.problems, validatedAt: each.record.validatedAt,
        })), null, 2));
        return code;
    }

    const who = (seen: Seen) => `${seen.handle ? `${seen.handle} (${seen.did})` : seen.did}${seen.kind ? ` as ${seen.kind}` : ''}`;
    const { o, e } = styles(io);
    if (o.people) {
        for (const each of results) {
            const attention = exit(each) > 0;
            if (values.quiet && !attention) continue;
            const name = o.bundle(o.bold(each.record.name));
            if (each.skipped) {
                io.out(`${name}  ${o.dim(`validated ${each.record.validatedAt}, recently enough`)}`);
                continue;
            }
            const bad = each.check.state === 'missing' || each.check.state === 'changed' || each.check.state === 'invalid';
            if (each.check.state !== 'ok') io.out(`${name}  ${(bad ? o.red : o.yellow)(`${bad ? '✖' : '⚠'} ${each.check.state.toUpperCase()}`)} ${o.dim(`— ${each.check.reason}`)}`);
            else if (!attention && !each.added.length && !each.removed.length) io.out(`${name}  ${o.green('✔ OK')} ${o.dim('— nothing new')}`);
            else io.out(name);
            const out = (lines: string[]) => { for (const line of lines) io.out(line); };
            for (const seen of each.added.filter((one) => one.verdict === 'bad')) {
                out(marked(o, '   ', 'attestation', o.red(o.bold('WARNING from')), [...attesterLines(o, seen), o.red('has marked it bad since it was last checked')]));
            }
            if (!values.quiet) {
                for (const seen of each.added.filter((one) => one.verdict === 'good')) out(marked(o, '   ', 'attestation', `${o.green('new:')} attested by`, attesterLines(o, seen)));
                for (const seen of each.removed) out(marked(o, '   ', 'attestation', `${o.yellow('withdrawn:')}${seen.verdict === 'bad' ? ' a warning from' : ''}`, attesterLines(o, seen)));
                for (const problem of each.problems) io.err(`   ${e.warn(`${problem} — the cache answered instead`)}`);
            }
        }
        if (!results.length && !values.quiet) io.out(o.dim('nothing installed'));
        return code;
    }
    for (const each of results) {
        const attention = exit(each) > 0;
        if (values.quiet && !attention) continue;
        const name = each.record.name;
        if (each.skipped) {
            io.out(`${name}: validated ${each.record.validatedAt}, recently enough`);
            continue;
        }
        if (each.check.state !== 'ok') io.out(`${name}: ${each.check.state.toUpperCase()} — ${each.check.reason}`);
        for (const seen of each.added.filter((one) => one.verdict === 'bad')) io.out(`${name}: WARNING — ${who(seen)} has marked it bad since it was last checked`);
        if (!values.quiet) {
            for (const seen of each.added.filter((one) => one.verdict === 'good')) io.out(`${name}: new — attested by ${who(seen)}`);
            for (const seen of each.removed) io.out(`${name}: withdrawn — ${who(seen)}${seen.verdict === 'bad' ? ' (a warning)' : ''}`);
            if (!attention && !each.added.length && !each.removed.length) io.out(`${name}: OK — nothing new`);
            for (const problem of each.problems) io.err(`! ${problem} — the cache answered instead`);
        }
    }
    if (!results.length && !values.quiet) io.out('nothing installed');
    return code;
}

// Remove an install: the file, and the record of where it came from. With no
// argument it is this package's own, which is what somebody who typed
// `bundle uninstall` means.
async function uninstall(args: string[], io: Console): Promise<number> {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: OPTIONS.uninstall });
    const INSTALL = await import('./install.ts');
    const SUITES = await import('./suite-install.ts');
    const which = positionals[0];
    const { o, e } = styles(io);

    // A suite: what it brought goes, and what was here anyway stays.
    const suite = which !== undefined && !INSTALL.records()[which] ? SUITES.findSuite(which) : undefined;
    if (suite !== undefined) {
        const { suite: gone, members } = await SUITES.uninstallSuite(suite);
        io.out(o.people ? o.bundle(`${o.red('removed')} suite ${o.bold(gone.name)}`) : `removed suite ${gone.name}`);
        io.err(`  ${e.dim(`it came from ${gone.source}`)}`);
        for (const member of members) {
            if (member.state === 'removed') io.out(o.people ? `   ${o.red('-')} ${o.bundle(o.bold(member.install!))}` : `removed ${member.install}`);
            else if (member.install !== undefined) io.err(e.people ? `   ${e.green('=')} ${e.bundle(e.bold(member.install))}  ${e.dim(`kept: ${member.reason}`)}` : `  kept ${member.install}: ${member.reason}`);
        }
        return 0;
    }

    const record = INSTALL.uninstall(which);
    io.out(o.people ? `${o.bundle(`${o.red('removed')} ${o.bold(record.name)}`)}  ${o.dim(`from ${record.dir}`)}` : `removed ${record.name} from ${record.dir}`);
    io.err(`  ${e.dim(`it came from ${record.url}`)}`);
    // Uninstalled by itself, it is left out of its suites from now on.
    for (const name of SUITES.forget([record.name], record.plugins.map((plugin) => plugin.name))) {
        io.err(`  ${e.dim(`it was in suite ${name}, which leaves it out from now on — installing it again brings it back`)}`);
    }
    // Its plugins went with it — unless another install of the same app
    // still loads them.
    for (const plugin of record.plugins) {
        io.out(o.people
            ? `   ${o.red('-')} ${o.bundle(`plugin ${o.bold(INSTALL.labelOf(plugin) ?? plugin.name)}`)}  ${o.dim(`(${plugin.package}) from ${plugin.dir}`)}`
            : `removed its plugin ${INSTALL.labelOf(plugin)} (${plugin.package}) from ${plugin.dir}`);
    }
    if (record.sharedWith.length) {
        io.err(`  ${e.dim(`its plugins stay: ${record.sharedWith.join(', ')} ${record.sharedWith.length === 1 ? 'is' : 'are'} the same app, and ${record.sharedWith.length === 1 ? 'loads' : 'load'} them too`)}`);
    }
    // This package going takes its shell hook with it — the hook would only
    // look for a `bundle` that is no longer there.
    if (!positionals[0]) {
        const COMPLETION = await import('./completion.ts');
        for (const file of COMPLETION.removeHooks()) io.err(`  ${e.dim(`took bundle's shell setup out of ${file}`)}`);
    }
    return 0;
}

// Suites, as their publisher writes them: a spec file that 'add' and 'remove'
// edit, 'show' reads, and 'publish' writes to an atproto account — or that is
// served from a URL, which is all publishing by DNS takes.
async function suite(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, allowNegative: true, options: OPTIONS.suite });
    const SUITE = await import('./suite.ts');
    const [sub, ...rest] = positionals;
    const file = values.suite;
    const { o, e } = styles(io);
    // What a member requires, for people: a heading, then each requirement under it.
    const requires = (require: import('./suite.ts').SuiteRequire | undefined, indent: string, out = io.out, style = o) => {
        out(`${indent}${style.dim('requires')}`);
        for (const line of requireLines(require, style, `${indent}  `)) out(line);
    };

    if (sub === 'add') {
        if (!rest.length) throw new Error('suite add: name the listings to add, as @<handle or did>/<name> or at:// addresses');
        const spec = SUITE.readSpec(file, { create: true });
        const where = values.for !== undefined ? await suiteFor(values.for) : undefined;
        if (where) {
            const outside = await pluginOutside(where.for, spec.members);
            if (outside) throw new Error(`suite add: --for ${where.label}: ${outside}`);
        }
        for (const target of rest) {
            const member = await suiteMember(target, where, spec.members, values, io);
            const at = spec.members.findIndex((each) => each.listing === member.listing);
            if (at >= 0) spec.members[at] = member;
            else spec.members.push(member);
            const required = [
                ...(member.require?.identity ? [`signed by ${member.require.identity} via ${member.require.issuer}`] : []),
                ...(member.require?.attesters ?? []).map((attester) => `attested by ${attester}`),
            ];
            if (o.people) {
                io.out(o.bundle(`${o.green(at >= 0 ? 'updated' : 'added')} ${o.bold(target)} in ${o.bold(spec.name)}  ${o.dim(`(${file})${where ? `, for ${where.label}` : ''}`)}`));
                requires(member.require, '   ');
            } else {
                io.out(`${at >= 0 ? 'updated' : 'added'} ${target} in ${spec.name} (${file})${where ? `, for ${where.label}` : ''}`);
                io.out(required.length ? `  requiring: ${required.join('; ')}` : '  requiring nothing: each install decides on its own');
            }
        }
        SUITE.writeSpec(file, spec, version());
        return 0;
    }
    if (sub === 'remove') {
        if (!rest.length) throw new Error('suite remove: name the listings to remove');
        const spec = SUITE.readSpec(file);
        let missing = 0;
        for (const target of rest) {
            const uri = await memberUri(target, spec);
            const at = spec.members.findIndex((each) => each.listing === uri);
            if (at < 0) {
                io.err(e.error(`${spec.name} has no member ${target}`));
                missing++;
                continue;
            }
            spec.members.splice(at, 1);
            io.out(o.people ? o.bundle(`${o.red('removed')} ${o.bold(target)} from ${o.bold(spec.name)}  ${o.dim(`(${file})`)}`) : `removed ${target} from ${spec.name} (${file})`);
            const dependent = spec.members.filter((each) => each.for === uri);
            if (dependent.length) io.err(`  ${e.warn(`still for it: ${dependent.map((each) => each.label ?? each.listing).join(', ')} — remove them too: for now, 'suite publish' refuses plugins for an app not in the suite`)}`);
        }
        SUITE.writeSpec(file, spec, version());
        return missing ? 1 : 0;
    }
    // A published suite, for 'validate', 'show' and 'attest' to read as they
    // would read the spec — so whoever is asked to permit one can check it.
    const named = async (target: string): Promise<import('./suite.ts').SuiteSpec> => {
        const found = await (await import('./suite-install.ts')).fetchTarget(target);
        io.err(e.note(`${target} is ${found.uri}`, 'bundle'));
        return { name: found.name, title: found.record.title, description: found.record.description, members: found.record.members };
    };
    if (sub === 'validate') {
        // The file first — readSpec refuses one that does not hold together —
        // then each member as it is published now, against what the suite
        // requires of it, and nothing else: this machine's policy is not the
        // suite's business.
        const spec = rest[0] !== undefined ? await named(rest[0]) : SUITE.readSpec(file);
        const LISTING = await import('./listing.ts');
        const POLICY = await import('./policy.ts');
        const problems: string[] = [];
        if (!spec.members.length) problems.push('it has no members');
        const apps = new Map<string, Promise<string | undefined>>();
        const appProblem = (uri: string) => apps.get(uri) ?? apps.set(uri, LISTING.followListing(uri).then(
            (found) => (LISTING.appOf(found.record) ? `it is for ${uri}, which is itself a plugin` : undefined),
            (err: unknown) => `it is for ${uri}: ${message(err)}`)).get(uri)!;
        for (const member of spec.members) {
            const label = member.label ?? member.listing;
            const floor = SUITE.minimumOf(member.require, `suite ${spec.name}`);
            let inspected: Awaited<ReturnType<typeof inspectMember>>;
            try {
                inspected = await inspectMember(member.listing, values, (floor?.attesters ?? []).map(({ did }) => did));
            } catch (err) {
                problems.push(`${label}: ${message(err)}`);
                io.out(o.people ? `${o.red('✖')} ${o.bundle(o.bold(label))}  ${o.red(message(err))}` : `FAIL  ${label} — ${message(err)}`);
                continue;
            }
            const app = LISTING.appOf(inspected.found.record);
            const mine: string[] = [];
            if (member.for !== undefined && LISTING.parseListingUri(member.for)) {
                const wrong = await appProblem(member.for);
                if (wrong) mine.push(wrong);
                if (app !== undefined && app !== member.for) mine.push(`its listing says it is a plugin for ${app}, not for ${member.for}`);
            }
            const outside = await pluginOutside(member.for ?? app, spec.members);
            if (outside) mine.push(outside);
            const review = REVIEW.judge(inspected.gathered, { policy: { ...POLICY.emptyPolicy(), discovery: false }, minimum: floor ? [floor] : [] });
            mine.push(...review.unmet);
            problems.push(...mine.map((problem) => `${label}: ${problem}`));
            if (o.people) {
                io.out(`${mine.length ? o.red('✖') : o.green('✔')} ${o.bundle(o.bold(label))}  ${o.dim(inspected.url)}`);
                io.out(`     ${o.dim(`${inspected.gathered.hashAlg}:${inspected.gathered.hash}`)}`);
                for (const problem of mine) io.out(`     ${o.red(problem)}`);
                if (!mine.length) requires(member.require, '     ');
            } else {
                io.out(`${mine.length ? 'FAIL' : 'OK  '}  ${label} — ${inspected.url}, ${inspected.gathered.hashAlg}:${inspected.gathered.hash}`);
                for (const problem of mine) io.out(`      ${problem}`);
                if (!mine.length) io.out(`      requires ${describeRequire(member.require)}`);
            }
        }
        if (o.people) io.out('');
        io.out(o.people
            ? problems.length
                ? o.red(`${o.bold(spec.name)}: ${plural(problems.length, 'problem')}`)
                : `${o.green('✔')} ${o.bold(spec.name)}: consistent, and every member carries what it requires`
            : problems.length
            ? `${spec.name}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`
            : `${spec.name}: consistent, and every member carries what it requires`);
        return problems.length ? 1 : 0;
    }
    if (sub === 'update') {
        // Ask again, member by member, what the suite should require — shown
        // what each carries now, and what is required of it now.
        const spec = SUITE.readSpec(file);
        const uris = rest.length ? await Promise.all(rest.map((target) => memberUri(target, spec))) : spec.members.map((member) => member.listing);
        for (const [i, uri] of uris.entries()) {
            const member = spec.members.find((each) => each.listing === uri);
            if (!member) throw new Error(`suite update: ${spec.name} has no member ${rest[i]}`);
            const label = member.label ?? member.listing;
            const inspected = await inspectMember(member.listing, values, (member.require?.attesters ?? []).map((spec) => parseAttester(spec).subject));
            io.err(e.note(`${label} is at ${inspected.url}`, 'bundle'));
            const require = await chooseRequire(label, inspected, values, io, member.require ?? {});
            if (require && Object.keys(require).length) member.require = require;
            else delete member.require;
            SUITE.writeSpec(file, spec, version());
            if (o.people) {
                io.out(o.bundle(o.bold(label)));
                requires(member.require, '   ');
            } else io.out(`${label}: requiring ${describeRequire(member.require)}`);
        }
        return 0;
    }
    if (sub === 'attest') {
        // A suite is attested by the hash of what it says: its members, where
        // each goes, and what each must carry — the spec, or a suite as it is
        // published. A good attestation counts for each member installed from
        // it; a bad one refuses the suite, and only the suite.
        if (values.kind !== undefined && !/^[A-Za-z0-9._-]+$/.test(values.kind)) throw new Error(`suite attest: '${values.kind}' is not a valid kind`);
        if (values.verdict !== 'good' && values.verdict !== 'bad') throw new Error(`suite attest: --verdict is good or bad, not '${values.verdict}'`);
        const verdict: 'good' | 'bad' = values.verdict;
        const { name, members } = rest[0] !== undefined ? await named(rest[0]) : SUITE.readSpec(file);
        if (!members.length) throw new Error(`suite attest: ${name} has no members`);
        const { hashAlg, hex } = SUITE.suiteHash({ members });
        if (e.people) {
            io.err(e.bundle(`suite ${e.bold(name)}  ${e.dim(`${hashAlg}:${hex}`)}, which says:`));
            for (const member of members) {
                io.err(`   ${e.bundle(e.bold(member.listing))}${member.for !== undefined ? e.dim(` for ${member.for}`) : ''}`);
                requires(member.require, '      ', io.err, e);
            }
        } else {
            io.err(`* suite ${name}: ${hashAlg}:${hex}, which says:`);
            for (const member of members) {
                io.err(`  ${member.listing}${member.for !== undefined ? ` for ${member.for}` : ''}`);
                io.err(`    requires ${describeRequire(member.require)}`);
            }
        }
        const { COLLECTION } = await import('./attestation.ts');
        const session = await signIn('suite attest', values, io, `atproto repo:${COLLECTION}`);
        try {
            const ATPROTO = await import('./atproto.ts');
            if (values.revoke) {
                await ATPROTO.revokeAll(session, [hex]);
                io.out(o.people
                    ? o.attestation(`withdrew suite ${o.bold(name)}  ${o.dim(`${hashAlg}:${hex}`)}`)
                    : `withdrew ${session.did}'s attestation of suite ${name} (${hashAlg}:${hex})`);
            } else {
                const [written] = await ATPROTO.attestAll(session, [{ hashAlg, hex, kind: values.kind, verdict, note: values.note }]);
                if (o.people) {
                    io.out(o.attestation(`${verdict === 'bad' ? o.red(o.bold('marked bad')) : o.green('attested')} suite ${o.bold(name)}${values.kind ? ` as ${values.kind}` : ''}`));
                    io.out(`   ${o.dim(`${hashAlg}:${hex}`)}`);
                    io.out(`   ${o.cyan(written!.uri)}`);
                } else {
                    io.out(`${verdict === 'bad' ? 'marked bad' : 'attested'} suite ${name} (${hashAlg}:${hex}) as ${session.did}${values.kind ? ` (${values.kind})` : ''}`);
                    io.out(`  ${written!.uri}`);
                }
            }
        } finally {
            await session.end?.();
        }
        return 0;
    }
    if (sub === 'show') {
        const spec = rest[0] !== undefined ? await named(rest[0]) : SUITE.readSpec(file);
        if (values.json) {
            io.out(JSON.stringify(spec, null, 2));
            return 0;
        }
        const { hashAlg, hex } = SUITE.suiteHash(spec);
        if (o.people) {
            io.out(`${o.bundle(`suite ${o.bold(spec.name)}`)}${spec.title ? ` — ${spec.title}` : ''}  ${o.dim(`(${rest[0] ?? file})`)}`);
            if (spec.description) io.out(`   ${spec.description}`);
            io.out(`   ${o.dim(`${hashAlg}:${hex} — what an attestation of it names`)}`);
            for (const member of spec.members) {
                io.out('');
                io.out(`   ${o.bundle(o.bold(member.label ?? member.listing))}${member.for !== undefined ? `  ${o.dim(`for ${member.forLabel ?? member.for}`)}` : ''}`);
                if (member.label) io.out(`      ${o.dim(member.listing)}`);
                requires(member.require, '      ');
            }
            if (!spec.members.length) io.err(`   ${e.dim(`no members yet — 'bundle suite add --suite ${file} <listing>'`)}`);
            return 0;
        }
        io.out(`${spec.name}${spec.title ? ` — ${spec.title}` : ''}  (${rest[0] ?? file})`);
        io.out(`  ${hashAlg}:${hex} — what an attestation of it names`);
        if (spec.description) io.out(`  ${spec.description}`);
        for (const member of spec.members) {
            io.out(`  ${member.label ?? member.listing}${member.for !== undefined ? `  for ${member.forLabel ?? member.for}` : ''}`);
            if (member.label) io.out(`    ${member.listing}`);
            if (member.require?.identity || member.require?.issuer) io.out(`    signed by ${member.require.identity ?? 'any identity'} via ${member.require.issuer ?? 'any issuer'}`);
            if (member.require?.attesters?.length) {
                io.out(`    attested by ${member.require.quorum !== undefined ? `${member.require.quorum} of ` : ''}${member.require.attesters.join(', ')}`);
            }
        }
        if (!spec.members.length) io.err(`  no members yet — 'bundle suite add --suite ${file} <listing>'`);
        return 0;
    }
    if (sub === 'publish') {
        const spec = SUITE.readSpec(file);
        if (!spec.members.length) throw new Error(`suite publish: ${file} has no members`);
        // Before anyone signs in: every member, and every app one is for, must
        // be a listing that is there.
        const LISTING = await import('./listing.ts');
        const apps = new Map<string, string | undefined>();
        for (const uri of new Set(spec.members.flatMap((each) => [each.listing, ...(each.for !== undefined && LISTING.parseListingUri(each.for) ? [each.for] : [])]))) {
            apps.set(uri, LISTING.appOf((await LISTING.followListing(uri)).record));
        }
        const outside: string[] = [];
        for (const member of spec.members) {
            const why = await pluginOutside(member.for ?? apps.get(member.listing), spec.members);
            if (why) outside.push(`${member.label ?? member.listing}: ${why}`);
        }
        if (outside.length) throw new Error(`suite publish: ${outside.join('; ')}`);
        const session = await signIn('suite publish', values, io, `atproto repo:${SUITE.SUITE}`);
        try {
            // `@<account>/<name>` installs a listing of that name when there is one.
            const ATPROTO = await import('./atproto.ts');
            if (await ATPROTO.getRecord(session.did, LISTING.LISTING, spec.name)) {
                throw new Error(`suite publish: ${session.did} lists a bundle called '${spec.name}', which @<account>/${spec.name} installs instead — give the suite another name`);
            }
            const { uri, replaced } = await SUITE.publishSuite(session, spec);
            const command = `bundle install @${session.handle ?? session.did}/${spec.name}`;
            if (o.people) {
                io.out(o.bundle(`${o.green(replaced ? 'updated' : 'published')} suite ${o.bold(spec.name)}  ${o.dim(`as ${session.did}`)}`));
                io.out(`   ${o.cyan(uri)}`);
                io.err(`   ${e.dim('install it with:')} ${e.bold(command)}`);
            } else {
                io.out(`${replaced ? 'updated' : 'published'} suite ${spec.name} as ${session.did}`);
                io.out(`  ${uri}`);
                io.err(`  install it with: ${command}`);
            }
        } finally {
            await session.end?.();
        }
        return 0;
    }
    if (sub === 'unpublish') {
        if (rest.length !== 1) throw new Error('suite unpublish: name the suite to take down');
        const session = await signIn('suite unpublish', values, io, `atproto repo:${SUITE.SUITE}`);
        try {
            if (!await SUITE.unpublishSuite(session, rest[0]!)) {
                io.err(e.error(`${session.did} has no suite called '${rest[0]}'`));
                return 1;
            }
            io.out(o.people ? o.bundle(`unpublished suite ${o.bold(rest[0]!)}  ${o.dim(`from ${session.did}`)}`) : `unpublished suite ${rest[0]} from ${session.did}`);
        } finally {
            await session.end?.();
        }
        return 0;
    }
    throw new Error(`suite: say what to do — add, remove, update, validate, show, publish, unpublish or attest ('bundle suite --help')`);
}

// What 'suite add --for' names: an app's listing — '@<handle or did>/<name>',
// or an at:// address — or a scope, a package name, such as a suite's shared
// one. '@acme/suite' is a scope; '@acme.dev/app', whose account is a handle or
// a DID, is a listing.
async function suiteFor(value: string): Promise<{ for: string; label: string }> {
    const LISTING = await import('./listing.ts');
    if (/^@(?:did:|[^/]*\.)/.test(value)) {
        const found = await LISTING.resolveListing(value);
        if (LISTING.appOf(found.record)) throw new Error(`suite: ${value} is itself a plugin, for ${LISTING.appOf(found.record)}`);
        return { for: found.uri, label: value };
    }
    if (LISTING.parseListingUri(value)) {
        const found = await LISTING.followListing(value);
        if (LISTING.appOf(found.record)) throw new Error(`suite: ${value} is itself a plugin, for ${LISTING.appOf(found.record)}`);
        return { for: value, label: value };
    }
    if ((await import('./scopes.ts')).isScope(value)) return { for: value, label: value };
    throw new Error(`suite: --for takes an app's listing (@<handle or did>/<name>, or an at:// address) or a scope (a package name); '${value}' is neither`);
}

type SpecMember = import('./suite.ts').SpecMember;
type SuiteValues = { root?: string[] | undefined; yes?: boolean | undefined; discover?: boolean | undefined };

// One listing, as a suite would install it now: the listing fetched from its
// PDS and verified, the archive it names fetched, and everything that vouches
// for it gathered — anyone `ask` names included, so whether they have
// attested is known even where discovery would not say.
async function inspectMember(target: string, values: SuiteValues, ask: string[] = []) {
    const LISTING = await import('./listing.ts');
    const INSTALL = await import('./install.ts');
    const POLICY = await import('./policy.ts');
    const found = LISTING.parseListingUri(target) ? await LISTING.followListing(target) : await LISTING.resolveListing(target);
    const url = found.record.domain ? (await INSTALL.resolveAlias(found.record.domain)).url : found.record.url!;
    const { patientFetch } = await import('./ratelimit.ts');
    const response = await patientFetch()(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const policy = POLICY.loadPolicy();
    const gathered = await REVIEW.gather(bytes, {
        roots: values.root ?? [], candidates: ask, discovery: values.discover === false ? false : policy.discovery, ignore: policy.ignore,
    });
    return { found, url, gathered, policy };
}

// Which of what vouches for a member the suite should require of it: shown,
// numbered as the review numbers it, and asked. Everything, with --yes. On
// 'suite update', what is required now is marked, and Enter keeps it.
async function chooseRequire(target: string, inspected: Awaited<ReturnType<typeof inspectMember>>, values: SuiteValues, io: Console,
    current?: import('./suite.ts').SuiteRequire | undefined): Promise<import('./suite.ts').SuiteRequire | undefined> {
    const review = REVIEW.judge(inspected.gathered, { policy: inspected.policy });
    showReview(review, { name: target, url: inspected.url }, io);
    const numbered = REVIEW.selectable(review);
    // What a suite can require: a sigstore signer, and good attestations.
    const offered = numbered.filter(({ evidence }) => evidence.type === 'signature' || (evidence.type === 'attestation' && evidence.verdict === 'good'));
    const now = (item: REVIEW.ReviewItem) => {
        const e = item.evidence;
        if (e.type === 'signature') return current?.identity === e.identity && current?.issuer === e.issuer;
        if (e.type !== 'attestation') return false;
        return (current?.attesters ?? []).some((spec) => { const { subject, kind } = parseAttester(spec); return subject === e.did && (!kind || kind === e.kind); });
    };
    const { e } = styles(io);
    if (current) {
        const kept = offered.filter(now).map((item) => numbered.indexOf(item) + 1);
        if (e.people) {
            io.err('');
            io.err(`${e.cyan('›')} required now${kept.length ? e.dim(` — ${kept.join(', ')} above`) : ''}`);
            for (const line of requireLines(current, e, '    ')) io.err(line);
        } else io.err(e.note(`required now: ${describeRequire(current)}${kept.length ? ` — ${kept.join(', ')} above` : ''}`));
        const gone = describeMissing(current, offered.filter(now));
        if (gone.length) io.err(`  ${e.warn(`not carried by what it serves now: ${gone.join(', ')}`)}`);
    }
    let chosen = offered;
    if (!offered.length) {
        io.err(`  ${e.dim(`nothing it carries can be required${current ? ': what is required stays' : ': it is added requiring nothing'}`)}`);
        return current;
    }
    if (!values.yes) {
        if (!io.ask) throw new Error(`suite: choosing what to require of ${target} needs a terminal — or --yes, for all of it`);
        const among = offered.map((item) => numbered.indexOf(item) + 1).join(', ');
        for (;;) {
            const answer = (await io.ask(prompt(e, `require which of ${among}?`, `numbers, 'all', 'none', or Enter to ${current ? 'keep what is required now' : 'require nothing'}`))).trim().toLowerCase();
            if (!answer) return current;
            if (answer === 'none' || answer === 'n' || answer === 'no') { chosen = []; break; }
            if (answer === 'all' || answer === 'a') { chosen = offered; break; }
            const picked = answer.split(/[\s,]+/).map(Number).map((n) => numbered[n - 1]);
            if (picked.every((item) => item && offered.includes(item))) { chosen = [...new Set(picked as REVIEW.ReviewItem[])]; break; }
            io.err(`  ${e.people ? e.yellow(`'${answer}' is not among ${among}`) : `'${answer}' is not among ${among}`}`);
        }
    }
    const signature = chosen.find(({ evidence }) => evidence.type === 'signature')?.evidence as Extract<REVIEW.Evidence, { type: 'signature' }> | undefined;
    const attesters = [...new Set(chosen.flatMap(({ evidence }) => (evidence.type === 'attestation' ? [formatAttester({ did: evidence.did, kind: evidence.kind })] : [])))];
    const require = {
        ...(signature ? { identity: signature.identity, issuer: signature.issuer } : {}),
        ...(attesters.length ? { attesters } : {}),
    };
    return Object.keys(require).length ? require : undefined;
}

function describeRequire(require: import('./suite.ts').SuiteRequire | undefined): string {
    const parts = [
        ...(require?.identity || require?.issuer ? [`signed by ${require.identity ?? 'any identity'} via ${require.issuer ?? 'any issuer'}`] : []),
        ...(require?.attesters?.length ? [`attested by ${require.quorum !== undefined ? `${require.quorum} of ` : ''}${require.attesters.join(', ')}`] : []),
    ];
    return parts.join('; ') || 'nothing';
}

// The same, for people: each requirement on its own lines, under its mark,
// indented by `indent`.
function requireLines(require: import('./suite.ts').SuiteRequire | undefined, style: Style, indent: string): string[] {
    const lines: string[] = [];
    if (require?.identity || require?.issuer) {
        lines.push(...marked(style, indent, 'signature', 'signed by', require.identity
            ? signerLines(style, require.identity, require.issuer)
            : [style.bold('any identity'), style.dim(`via ${require.issuer}`)]));
    }
    if (require?.attesters?.length) {
        lines.push(...marked(style, indent, 'attestation', `attested by${require.quorum !== undefined ? ` ${require.quorum} of` : ''}`, []));
        for (const spec of require.attesters) lines.push(...attesterSpecLines(style, spec).map((line) => `${indent}   ${line}`));
    }
    return lines.length ? lines : [`${indent}${style.dim('nothing required: each install decides on its own')}`];
}

// What is required that none of `carried` is.
function describeMissing(require: import('./suite.ts').SuiteRequire, carried: REVIEW.ReviewItem[]): string[] {
    const missing: string[] = [];
    if (require.identity && !carried.some(({ evidence }) => evidence.type === 'signature')) missing.push(`the signature by ${require.identity}`);
    for (const spec of require.attesters ?? []) {
        const { subject, kind } = parseAttester(spec);
        if (!carried.some(({ evidence }) => evidence.type === 'attestation' && evidence.did === subject && (!kind || kind === evidence.kind))) missing.push(spec);
    }
    return missing;
}

// For now, 'bundle suite' writes suites of apps and of plugins for the apps
// in them, and nothing else: a plugin goes in only with its app, and nothing
// goes into a shared scope. How suites of plugins alone should work is not
// settled, and a suite published now would be a precedent to support. So
// the rule is this tool's, as it writes suites — add, validate and publish —
// and nothing else's: the lexicon, the schema and installing say nothing of
// it, and lifting it later breaks nothing. Why `host`, where a member is to
// be installed, keeps it out; or undefined.
async function pluginOutside(host: string | undefined, members: SpecMember[]): Promise<string | undefined> {
    if (host === undefined) return undefined;
    const LISTING = await import('./listing.ts');
    if (!LISTING.parseListingUri(host)) {
        return `it would go into the scope '${host}', and for now a suite holds plugins only for the apps in it`;
    }
    if (!members.some((member) => member.listing === host)) {
        return `it is a plugin for ${host}, which is not in the suite — for now a suite holds plugins only for the apps in it: add the app first`;
    }
    return undefined;
}

// One listing, made a member of a spec: inspected, and what to require of it asked.
async function suiteMember(target: string, where: { for: string; label: string } | undefined, members: SpecMember[], values: SuiteValues, io: Console): Promise<SpecMember> {
    const LISTING = await import('./listing.ts');
    const inspected = await inspectMember(target, values);
    const { found, url } = inspected;
    const app = LISTING.appOf(found.record);
    if (where && app && where.for !== app && LISTING.parseListingUri(where.for)) {
        throw new Error(`suite add: ${target} is a plugin for ${app}, not for ${where.label}`);
    }
    const outside = where ? undefined : await pluginOutside(app, members);
    if (outside) throw new Error(`suite add: ${target}: ${outside}`);
    io.err(styles(io).e.note(`${target} is ${found.uri}, at ${url}`, 'bundle'));
    const require = await chooseRequire(target, inspected, values, io);
    return {
        listing: found.uri,
        label: target.startsWith('@') ? target : undefined,
        ...(where ? { for: where.for, forLabel: where.label !== where.for ? where.label : undefined } : {}),
        ...(require ? { require } : {}),
    };
}

// Which member of a spec 'suite remove' means: as it was added, by its
// address, or by '@<handle or did>/<name>', resolved.
async function memberUri(target: string, spec: import('./suite.ts').SuiteSpec): Promise<string> {
    const known = spec.members.find((each) => each.listing === target || each.label === target);
    if (known) return known.listing;
    const LISTING = await import('./listing.ts');
    const parsed = LISTING.parseListingTarget(target);
    if (!parsed) return target;
    if (parsed.who.startsWith('did:')) return LISTING.listingUri(parsed.who, parsed.name);
    const ATPROTO = await import('./atproto.ts');
    return LISTING.listingUri((await ATPROTO.resolveHandle(parsed.who)).did, parsed.name);
}

// The audit gate. The review itself needs judgement, so this command does the
// two mechanical halves around it: say what is about to be reviewed, and refuse
// to let signing proceed without a clean verdict over exactly these bytes.
function audit(args: string[], io: Console): number {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.audit,
    });
    const bundle = positionals[0];
    if (!bundle) throw new Error('audit: an archive path is required');
    if (values.check && values.approve) throw new Error('audit: --check and --approve are alternatives');
    const options = { bundle, verdict: values.verdict, baseline: values.baseline };
    const { o, e } = styles(io);

    if (values.check) {
        const verdict = AUDIT.check(options);
        const notes = (verdict.findings ?? []).length;
        if (e.people) {
            io.err(e.bundle(`${e.bold(bundle)}  ${e.green(`✔ audited: ${verdict.summary ?? 'pass'}`)}`));
            io.err(`   ${e.dim(`${verdict.reviewed ?? '?'} of ${verdict.members ?? '?'} members reviewed, ${plural(notes, 'finding')}` +
                `${verdict.baselineSha256 ? `, as a diff against ${verdict.baselineSha256.slice(0, 16)}…` : ''}`)}`);
            return 0;
        }
        io.err(`* audited: ${verdict.summary ?? 'pass'}`);
        io.err(`  ${verdict.reviewed ?? '?'} of ${verdict.members ?? '?'} members reviewed, ` +
            `${notes} finding${notes === 1 ? '' : 's'}`);
        if (verdict.baselineSha256) io.err(`  as a diff against ${verdict.baselineSha256.slice(0, 16)}…`);
        return 0;
    }

    if (values.approve) {
        const verdict = AUDIT.approve({ ...options, note: values.note });
        io.err(e.people
            ? e.bundle(`${e.green('recorded a pass')} over ${e.bold(bundle)}  ${e.dim(`${verdict.sha256!.slice(0, 16)}… in ${AUDIT.verdictPath(bundle, values.verdict)}`)}`)
            : `* recorded a pass over ${verdict.sha256!.slice(0, 16)}… in ${AUDIT.verdictPath(bundle, values.verdict)}`);
        return 0;
    }

    const found = AUDIT.prepare(options);
    if (o.people) {
        showAudit(found, bundle, io, o, e);
        return 0;
    }
    io.out(`${found.bundle}: ${STATES[found.state as VerificationState]?.label ?? found.state}, ${found.members.length} members`);
    io.out(`  sha256: ${found.sha256}`);
    if (found.state === 'unsigned') {
        io.out('  unsigned, as an archive that has not been signed yet should be');
    }
    // The prefix runs before anything in the archive does, so it is reviewed
    // with it: a launcher in full, anything else by size and hash.
    if (found.prefix?.script) {
        io.out(`  prefix: a ${found.prefix.bytes}-byte #! launcher, which runs first:`);
        for (const line of found.prefix.script.trimEnd().split('\n')) io.out(`    | ${line}`);
    } else if (found.prefix) {
        io.out(`  prefix: ${found.prefix.bytes} bytes of binary, which runs first (sha256 ${found.prefix.sha256.slice(0, 16)}…)`);
    }
    if (found.baseline) {
        io.out(`  against ${found.baseline.path} (${found.baseline.sha256.slice(0, 16)}…)`);
        io.out(`  ${found.baseline.added.length} added, ${found.baseline.removed.length} removed, ` +
            `${found.baseline.carried} carried over${found.prefix ? `, prefix ${found.baseline.samePrefix ? 'unchanged' : 'CHANGED'}` : ''}`);
        for (const name of found.baseline.added.slice(0, 10)) io.out(`    + ${name}`);
        for (const name of found.baseline.removed.slice(0, 10)) io.out(`    - ${name}`);
    } else {
        io.out('  no baseline — the review is of everything, not a diff');
    }

    io.err('');
    io.err('* review it, then record the verdict:');
    io.err(`    BUNDLE_AUDIT_VERDICT=${found.verdict} \\`);
    io.err(found.baseline
        ? `      claude "/audit-bundle ${bundle} against ${found.baseline.path}"`
        : `      claude "/audit-bundle ${bundle}"`);
    io.err('  or, having read it yourself:');
    io.err(`    bundle audit --approve --note '<what you checked>' ${bundle}`);
    io.err("* then gate signing on it: bundle audit --check ... && bundle sign ...");
    return 0;
}

// What is about to be reviewed, for a person: the bundle, what runs first,
// what changed since the baseline, and the two ways to record a verdict.
function showAudit(found: ReturnType<typeof AUDIT.prepare>, bundle: string, io: Console, o: Style, e: Style): void {
    const state = found.state as VerificationState;
    const label = STATES[state]?.label ?? found.state;
    io.out(`${o.bundle(o.bold(found.bundle))}  ${state === 'unsigned' ? o.dim(`${label} — not signed yet, as it should be`) : STATES[state] ? o.state(state, label) : label}`);
    io.out(`   ${o.dim(`${plural(found.members.length, 'member')}  sha256:${found.sha256}`)}`);
    if (found.prefix?.script) {
        io.out(`   ${o.yellow('runs first:')} a ${bytes(found.prefix.bytes)} #! launcher`);
        for (const line of found.prefix.script.trimEnd().split('\n')) io.out(`     ${o.dim('│')} ${line}`);
    } else if (found.prefix) {
        io.out(`   ${o.yellow('runs first:')} ${bytes(found.prefix.bytes)} of binary ${o.dim(`(sha256 ${found.prefix.sha256.slice(0, 16)}…)`)}`);
    }
    if (found.baseline) {
        io.out(`   ${o.dim('against')} ${found.baseline.path} ${o.dim(`(${found.baseline.sha256.slice(0, 16)}…)`)}`);
        io.out(`   ${o.green(`${found.baseline.added.length} added`)}, ${o.red(`${found.baseline.removed.length} removed`)}, ${found.baseline.carried} carried over` +
            `${found.prefix ? `, prefix ${found.baseline.samePrefix ? 'unchanged' : o.yellow(o.bold('CHANGED'))}` : ''}`);
        for (const name of found.baseline.added.slice(0, 10)) io.out(`     ${o.green('+')} ${name}`);
        for (const name of found.baseline.removed.slice(0, 10)) io.out(`     ${o.red('-')} ${name}`);
    } else {
        io.out(`   ${o.dim('no baseline — the review is of everything, not a diff')}`);
    }
    io.err('');
    io.err(`${e.cyan('›')} review it, then record the verdict:`);
    io.err(`    ${e.bold(`BUNDLE_AUDIT_VERDICT=${found.verdict} \\`)}`);
    io.err(`      ${e.bold(found.baseline ? `claude "/audit-bundle ${bundle} against ${found.baseline.path}"` : `claude "/audit-bundle ${bundle}"`)}`);
    io.err(`  ${e.dim('or, having read it yourself:')}`);
    io.err(`    ${e.bold(`bundle audit --approve --note '<what you checked>' ${bundle}`)}`);
    io.err(`${e.signature('then gate signing on it:')} ${e.bold('bundle audit --check ... && bundle sign ...')}`);
}

// Wrap an archive in a node runtime that verifies itself before running it.
// The signing half is the same as `sign` — the finished executable is one
// signed file whose hash covers the runtime, the verifier and the application
// alike, which is what lets it check itself with something inside itself.
async function sea(args: string[], io: Console): Promise<number> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        // `--no-sigstore` is spelled as the negation of `sigstore`.
        allowNegative: true,
        options: OPTIONS.sea,
    });
    const app = positionals[0];
    if (!values.output) throw new Error('sea: --output is required');

    const SEA = await import('./sea.ts');
    // A policy baked into a runtime is the last word: it would be no policy at
    // all if the command line could drop it. Nothing baked, nothing to seal —
    // that runtime takes its policy from flags and the environment, the way
    // `bundle run` does.
    const { attesters, quorum, maxAge, block } = await policy(values);
    const bootstrap = {
        roots: values.root,
        identity: values.identity,
        issuer: values.issuer,
        attesters: attesters.length ? attesters.map(formatAttester) : undefined,
        quorum,
        maxAge,
        block: block.length ? block.map(({ did }) => did) : undefined,
        allowUntrusted: values.untrusted,
        sealed: Boolean(values.root?.length || values.identity || values.issuer || attesters.length),
    };

    if (!app) {
        if (values.base) throw new Error('sea: --base reuses a runtime; without an archive there is nothing to add to it');
        io.err(styles(io).e.note('building a verifying node (node runtime + verifier, no application)'));
        const built = await SEA.createSeaBase({
            output: values.output,
            node: values.node,
            sigstore: values.sigstore,
            bootstrap,
        });
        const { e } = styles(io);
        io.err(e.people ? `${e.cyan('›')} wrote ${e.bold(built.output)}  ${e.dim(`${bytes(built.size)}, ${built.verifier.length} verifier members`)}`
            : `* wrote ${built.output} (${built.size} bytes, ${built.verifier.length} verifier members)`);
        io.err(e.note(`run an archive with it: ${built.output} <archive> [args...]`, 'bundle'));
        return 0;
    }

    // Built here, signed by 'bundle sign': the executable is reviewed as it
    // will run, and what is signed is what was reviewed.
    const res = await SEA.buildSea({
        app,
        output: values.output,
        node: values.node,
        base: values.base,
        sigstore: values.sigstore,
        hashAlg: values.hash,
        bootstrap,
        log: logger(io),
    });
    if (res.output) {
        const { e } = styles(io);
        io.err(e.people ? e.bundle(`wrote ${e.bold(res.output)}  ${e.dim(`${bytes(res.size!)}, unsigned`)}`) : `* wrote ${res.output} (${res.size} bytes, unsigned)`);
        io.err(e.note(`review it, then sign it: bundle sign ${res.output}${res.output.includes('.unsigned') ? '' : ' (in place)'}`, 'signature'));
    }
    return 0;
}

// Refresh the trust material. Verification is deliberately offline — it will
// not reach for the network to decide whether to mount something — so what it
// checks against has to be fetched by an explicit step like this one: the
// sigstore trust root, over TUF, which is signed metadata with its own root of
// trust rather than a plain download; and the attestations of every attester
// this machine knows about, each proof verified before it is kept.
async function trust(args: string[], io: Console): Promise<number> {
    const { values } = parseArgs({
        args,
        allowNegative: true,
        options: OPTIONS.trust,
    });
    let failed = false;

    if (values.sigstore) {
        const SIGSTORE = await import('./sigstore.ts');
        const path = await SIGSTORE.refreshTrustedRoot(values.mirror ? { mirror: values.mirror } : {});
        const { o } = styles(io);
        io.out(o.people ? o.signature(`sigstore trust root refreshed  ${o.dim(path)}`) : `sigstore trust root refreshed: ${path}`);
    }

    // Everyone whose attestations something on this machine may ask about:
    // named here, named in the environment the preload reads, pinned by an
    // install, or already cached because a verification once needed them.
    const ATPROTO = await import('./atproto.ts');
    const INSTALL = await import('./install.ts');
    // Each attester's DID document is fetched once, however often it comes up.
    const network = { documents: new Map() };
    const dids = new Set<string>();
    for (const spec of values.attester ?? []) dids.add((await ATPROTO.resolveAttester(spec, network)).did);
    const POLICY = await import('./policy.ts');
    const environment = policyFromEnvironment();
    for (const { did } of [...environment.attesters, ...(environment.block ?? [])]) dids.add(did);
    const policies = [POLICY.loadPolicy(), ...Object.values(INSTALL.records()).map((record) => INSTALL.policyOf(record))];
    for (const each of policies) {
        for (const { attesters } of each.attesters) for (const { did } of attesters) dids.add(did);
        for (const { did } of [...each.trust.attesters, ...each.block]) dids.add(did);
    }
    for (const record of Object.values(INSTALL.records())) for (const did of INSTALL.acceptedOf(record).attesters) dids.add(did);
    for (const did of cachedDids()) dids.add(did);
    for (const each of policies) for (const did of each.ignore) dids.delete(did);

    for (const did of [...dids].sort()) {
        try {
            const { present, fetched, removed } = await ATPROTO.refreshAttester(did, network);
            const { o } = styles(io);
            io.out(o.people
                ? o.attestation(`${o.bold(did)}  ${plural(present, 'attestation')}${fetched ? o.green(`, ${fetched} new`) : ''}${removed ? o.yellow(`, ${removed} withdrawn`) : ''}`)
                : `${did}: ${present} attestation${present === 1 ? '' : 's'}` +
                `${fetched ? `, ${fetched} new` : ''}${removed ? `, ${removed} withdrawn` : ''}`);
        } catch (err) {
            io.err(styles(io).e.error(`${did}: ${message(err)}`));
            failed = true;
        }
    }
    return failed ? 1 : 0;
}

// Install the auditing skill into a project, so whoever is about to run an
// archive has the review procedure to hand rather than having to find it here.
function skill(args: string[], io: Console): number {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: OPTIONS.skill,
    });

    const available = SKILLS.skills();
    if (values.list) {
        if (!available.length) io.out('this package carries no skills');
        for (const entry of available) io.out(`${entry.name}\n  ${entry.description}`);
        return 0;
    }

    const names = positionals.length ? positionals : available.map((entry) => entry.name);
    if (!names.length) throw new Error('skill: this package carries no skills to install');

    for (const name of names) {
        const res = SKILLS.install(name, { dir: values.dir, force: values.force });
        const { o, e } = styles(io);
        for (const file of res.written) io.err(e.line(`+ ${PATH.relative(process.cwd(), file)}`));
        for (const file of res.skipped) io.err(e.line(`= ${PATH.relative(process.cwd(), file)} (already there; --force to overwrite)`));
        io.out(o.people
            ? `${o.green('installed')} skill ${o.bold(res.name)}  ${o.dim(`into ${PATH.relative(process.cwd(), res.path) || res.path}`)}`
            : `installed skill '${res.name}' into ${PATH.relative(process.cwd(), res.path) || res.path}`);
    }
    return 0;
}

/** What `sign` and `sea` both accept to decide how the signature is made. */
interface SignerChoice {
    key?: string | undefined;
    chain?: string | undefined;
    sign?: string | undefined;
    flow?: string | undefined;
    token?: string | undefined;
    'oidc-issuer'?: string | undefined;
    connector?: string | undefined;
    fulcio?: string | undefined;
    rekor?: string | undefined;
    tsa?: string | undefined;
}

// Two signers, one interface. Either way the certificate has to be in hand
// before the archive is built, because AUTHORITY.PEM carries it and
// AUTHORITY.PEM is inside the region the hash covers — so this runs first and
// the signature itself is made later, over the finished bytes.
async function chooseSigner(values: SignerChoice, io: Console) {
    if (values.key && values.chain) {
        io.err(styles(io).e.note('signing against the supplied certificate chain', 'signature'));
        return fileSigner({ key: values.key, chain: values.chain, signAlg: values.sign });
    }
    const SIGSTORE = await import('./sigstore.ts');
    io.err(styles(io).e.note('signing through sigstore', 'signature'));
    return await SIGSTORE.signer({
        signAlg: values.sign,
        flow: values.flow as 'auto' | 'ci' | 'browser' | 'device' | undefined,
        token: values.token,
        issuer: values['oidc-issuer'],
        connector: values.connector,
        fulcioURL: values.fulcio,
        rekorURL: values.rekor,
        tsaURL: values.tsa,
        log: logger(io),
    });
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk: string) => { data += chunk; })
            .on('end', () => resolve(data))
            .on('error', reject);
    });
}

/**
 * Every command's options, as `parseArgs` takes them — the one place they are
 * defined. The commands parse with these, and completion (completion.ts)
 * offers exactly these, so what Tab suggests is what a command accepts.
 */
export const OPTIONS = {
    create: {
        base:   { type: 'string', short: 'b', default: '.' },
        launcher: { type: 'boolean', short: 'l' },
        prefix: { type: 'string', short: 'p' },
        files:  { type: 'string', short: 'f' },
        output: { type: 'string', short: 'o' },
        key:    { type: 'string', short: 'k' },
        chain:  { type: 'string', short: 'c' },
        hash:   { type: 'string', default: 'sha256' },
        sign:   { type: 'string', default: 'sha256' },
        date:   { type: 'string' },
    },
    sign: {
        output:     { type: 'string',  short: 'o' },
        executable: { type: 'boolean', short: 'x' },
        key:        { type: 'string',  short: 'k' },
        chain:      { type: 'string',  short: 'c' },
        hash:       { type: 'string',  default: 'sha256' },
        sign:       { type: 'string',  default: 'sha256' },
        flow:       { type: 'string',  default: 'auto' },
        token:      { type: 'string' },
        'oidc-issuer': { type: 'string' },
        connector:  { type: 'string' },
        fulcio:     { type: 'string' },
        rekor:      { type: 'string' },
        tsa:        { type: 'string' },
    },
    audit: {
        baseline: { type: 'string',  short: 'b' },
        verdict:  { type: 'string',  short: 'v' },
        note:     { type: 'string',  short: 'n' },
        check:    { type: 'boolean' },
        approve:  { type: 'boolean' },
    },
    verify: {
        archive:  { type: 'string', short: 'a' },
        root:     { type: 'string', short: 'r', multiple: true },
        identity: { type: 'string' },
        issuer:   { type: 'string' },
        'sigstore-root': { type: 'string' },
        json:     { type: 'boolean' },
        ...POLICY_OPTIONS,
    },
    attest: {
        as:              { type: 'string' },
        from:            { type: 'string' },
        kind:            { type: 'string' },
        note:            { type: 'string' },
        verdict:         { type: 'string', default: 'good' },
        'password-file': { type: 'string' },
        revoke:          { type: 'boolean' },
        root:            { type: 'string', short: 'r', multiple: true },
    },
    publish: {
        as:              { type: 'string' },
        for:             { type: 'string' },
        title:           { type: 'string' },
        description:     { type: 'string' },
        from:            { type: 'string' },
        'password-file': { type: 'string' },
        root:            { type: 'string', short: 'r', multiple: true },
    },
    unpublish: {
        as:              { type: 'string' },
        'password-file': { type: 'string' },
    },
    suite: {
        suite:           { type: 'string', short: 's', default: 'suite.json' },
        for:             { type: 'string' },
        yes:             { type: 'boolean', short: 'y' },
        discover:        { type: 'boolean', default: true },
        root:            { type: 'string', short: 'r', multiple: true },
        json:            { type: 'boolean' },
        as:              { type: 'string' },
        'password-file': { type: 'string' },
        kind:            { type: 'string' },
        verdict:         { type: 'string', default: 'good' },
        note:            { type: 'string' },
        revoke:          { type: 'boolean' },
    },
    run: RUN_OPTIONS,
    search: {
        for:     { type: 'string' },
        refresh: { type: 'boolean' },
        offline: { type: 'boolean' },
        json:    { type: 'boolean' },
    },
    listings: {
        for:     { type: 'string' },
        refresh: { type: 'boolean' },
        offline: { type: 'boolean' },
        json:    { type: 'boolean' },
    },
    install: {
        ...INSTALL_OPTIONS,
        name:      { type: 'string', short: 'n' },
        dir:       { type: 'string', short: 'd' },
        for:       { type: 'string' },
        shell:     { type: 'boolean', default: true },
    },
    update: INSTALL_OPTIONS,
    installed: { root: { type: 'string', short: 'r', multiple: true }, json: { type: 'boolean' } },
    validate: {
        quiet:   { type: 'boolean', short: 'q' },
        every:   { type: 'string' },
        timeout: { type: 'string' },
        root:    { type: 'string', short: 'r', multiple: true },
        json:    { type: 'boolean' },
    },
    uninstall: {},
    sea: {
        output:    { type: 'string',  short: 'o' },
        node:      { type: 'string' },
        base:      { type: 'string' },
        sigstore:  { type: 'boolean', default: true },
        untrusted: { type: 'boolean' },
        root:      { type: 'string',  short: 'r', multiple: true },
        identity:  { type: 'string' },
        issuer:    { type: 'string' },
        hash:      { type: 'string',  default: 'sha256' },
        ...POLICY_OPTIONS,
    },
    trust: {
        mirror:   { type: 'string' },
        attester: { type: 'string', multiple: true },
        sigstore: { type: 'boolean', default: true },
    },
    policy: {
        app:    { type: 'string', short: 'a' },
        json:   { type: 'boolean' },
        system: { type: 'boolean' },
        user:   { type: 'boolean' },
        force:  { type: 'boolean', short: 'f' },
    },
    lexicon: {
        as:              { type: 'string' },
        'dry-run':       { type: 'boolean' },
        force:           { type: 'boolean' },
        'password-file': { type: 'string' },
    },
    shell: {
        every:    { type: 'string', default: '1d' },
        timeout:  { type: 'string', default: '5s' },
        validate: { type: 'boolean', default: true },
        complete: { type: 'boolean', default: true },
    },
    skill: {
        dir:   { type: 'string',  short: 'd' },
        force: { type: 'boolean', short: 'f' },
        list:  { type: 'boolean', short: 'l' },
    },
} as const;
