# static-server — an example application

A static web server that serves the directories and ZIP archives it is handed,
merged into one tree. It exists to be **bundled**: five TypeScript modules and a
stylesheet that become one signed file you can run by name.

```sh
./static-server.run ./site docs.zip            # a directory and an archive, one tree
./static-server.run --port=8080 --host=0.0.0.0 ./site
```

It is not published with `@pipobscure/bundle` — `package.json`'s `files` list
does not mention `examples/`, so it ships with the repository and never with the
package.

---

## What it demonstrates

**An application is a tree.** The server is an entry point, a `lib/` of seven
modules, and two files in `assets/` — a stylesheet and a favicon — that it reads
at runtime through `import.meta.dirname`. Bundled, all of that is inside one
archive, and the assets are fetched out of the same mount the code was loaded
from. A bundler would have collapsed the JavaScript and left both behind.

**TypeScript runs as it is.** The sources are erasable-syntax TypeScript, and the
archive contains the `.ts` files. Node strips the types on the way in — from
inside a ZIP mount, the same as from disk. There is no build step and nothing
generated: what you read is what is signed.

**Mounting is an ordinary library call.** The server mounts what it serves with
`vfs.create()` and the two built-in providers, choosing between them by what the
source *is* rather than what it is called — the same rule `--vfs-mount` uses.

---

## Why the server mounts the content itself

The obvious design is to let node do it: `./static-server.run --vfs-mount site/`
and have the program serve whatever is mounted. That does not work, for two
reasons worth knowing:

- **Nothing enumerates the mounts.** A mount lives at a reserved path node
  assigns, and no API hands that path back. A program can be *served from* a
  mount it did not make, but it cannot discover one.
- **The launcher's `--` is load-bearing.** The prefix this package writes ends
  its node invocation with `--`, so everything after the archive's own name is
  the program's argument. That is what makes `./static-server.run --port=9000`
  reach the program instead of node — and it means a `--vfs-mount` written there
  would never be seen by node anyway.

So the sources are the program's arguments, and the program mounts them. The
cost is one `vfs.create()` per source; what it buys is a command line that means
what it says, and a launcher whose shape does not have to change.

Running from source, the `--` is yours to write:

```sh
node --experimental-vfs --vfs-load=. -- --port=8080 ./content/site-a docs.zip
```

Leave it out and `--port=8080` is node's, and node will refuse it.

---

## Building it

The four steps this package is about, over this example:

```sh
cd examples/static-server

# 1. observe — run it once and write down every file it actually reads.
#    (Inside this repository the preload is ../../dist/record.js; in your own
#    project it is @pipobscure/bundle/record.)
BUNDLE_MANIFEST=server.manifest node --experimental-vfs \
    -r ../../dist/record.js --vfs-load=. -- --port=8080 &
curl -s -o /dev/null localhost:8080/             # startup, and a generated page
curl -s -o /dev/null localhost:8080/builtin.css  # the stylesheet that page links
curl -s -o /dev/null localhost:8080/favicon.ico  # and the icon a browser would ask for
kill %1

# 2. create — archive exactly that
npx bundle create --base . --files server.manifest --output static-server.bundle

# 3. audit — read it before standing behind it
npx bundle audit --check static-server.bundle

# 4. sign — behind the launcher prefix, so the result is a program
npx bundle sign --launcher --output static-server.run static-server.bundle
chmod +x static-server.run
```

The result is about 17 kB. `unzip -l static-server.run` lists every file in it,
and `bundle verify static-server.run` says who signed it.

**Note what step 1 serves: nothing.** With no sources the root still answers —
with an empty enumeration — and that is deliberate: startup reads every module
and `package.json`, and one generated page needs no content at all. Nothing has
to be mounted to exercise the program.

**And note that it takes three requests, not one.** The stylesheet and the icon
are *separate* HTTP requests that a browser makes after parsing the page, and
`curl` is not a browser: fetch only `/` and the server never opens either asset,
so the archive is complete right up until someone hits a page — at which point
the server 404s its own CSS. Nothing about the source tree says that; only running
it does.

That is the shape of the warning in general. Observation records the files a run
*read*, so a path never taken is a file never archived — a lazily-required
module, an error template, a locale file. Exercise those paths deliberately, or
pair the observation with a computed closure; the root
[README](../../README.md#1-observe) has the longer version.

A content archive is any ZIP: `zip -r docs.zip docs/`, or `bundle create` if you
would rather use one tool. An archive built by `bundle create` carries an
`AUTHORITY.PEM` manifest member, and the server will list and serve it like any
other file — it is content as far as HTTP is concerned.

---

## What it does as a web server

**Caching** splits three ways, because one max-age cannot serve every kind of
file:

| | `Cache-Control` | why |
|---|---|---|
| `app.9f2c1a7d.js` | `public, max-age=31536000, immutable` | a fingerprinted name cannot change meaning |
| `*.html` | `public, max-age=0, must-revalidate` | the entry to everything else, and never fingerprinted |
| everything else | `public, max-age=<--max-age>` | fresh for a while, then revalidated |
| generated listings | `no-store` | they describe the mounts, not a file |

**ETags are content hashes**, not `size-mtime`. A ZIP entry's mtime is whatever
the archive recorded, so two servers on the same bytes would otherwise disagree,
and a rebuild that changed nothing would invalidate every cache. The hash is
computed once per (path, size, mtime) and kept, so a conditional request is
answered without reading the file.

**Conditional requests** follow RFC 9110: `If-None-Match` first and
`If-Modified-Since` only in its absence, weak comparison, `*` honoured, 304 with
the validators and no body.

**Range requests**: single ranges, `bytes=0-99`, `bytes=100-`, `bytes=-100`,
with `If-Range` honoured and 416 plus `Content-Range: bytes */size` when the
range cannot be met. Multiple ranges are answered in full, which a server is
always allowed to do.

**Redirects**, from a JSON file, applied before anything is looked for:

```jsonc
{
  "^/old/(.*)$":       { "location": "/$1", "code": 301 },
  "^/guide$":          { "location": "/guide/", "code": 308 },
  "^/docs/(.*)$":      { "location": "/guide/$1" },          // 301 by default
  "^/elsewhere/(.*)$": { "location": "https://example.com/$1", "code": 302 }
}
```

```sh
./static-server.run --redirects=redirects.json ./site
```

The key is a regular expression matched against the request path and the
location is the replacement, so this is `String.prototype.replace()` — `$1` and
its siblings work, `$0` is accepted for `$&`, and a pattern is unanchored unless
you anchor it. See [`redirects.example.json`](redirects.example.json).

**Every rule is applied, in file order, each to what the last one produced**, so
rules compose:

```jsonc
{
  "^/site/":   { "location": "https://external.site/", "code": 301 },
  "https?://": { "location": "/redirect-intercept?$0", "code": 302 }
}
```

`/site/foo` becomes `https://external.site/foo` by the first rule, and the second
sees *that* and hands it to an interceptor:
`/redirect-intercept?https://external.site/foo`. First-match-wins would leave the
second rule unreachable for exactly the paths it exists to catch. The response
code comes from the last rule that actually changed the value.

Four more details worth knowing:

- **Rules run before the mounts.** A redirect table says where things live, and a
  file that happens to sit at the old path does not quietly outrank it.
- **The file is checked at startup.** A bad pattern, a missing `location` or a
  code that is not 301/302/303/307/308 stops the server with a message naming the
  rule, rather than surfacing as a 500 on the one request that reaches it.
- **A pass that changes nothing is not a redirect**, so a rule mapping a path
  to itself is skipped rather than answered as a loop. Longer loops — `/a` to
  `/b` to `/a` across two rules — are still yours to avoid.
- **The query survives.** If the rule's location carries no `?`, the request's
  own query is appended, so `?page=2` lives through a move. Permanent redirects
  (301, 308) are cacheable for `--max-age`; the temporary ones are `no-cache`,
  because a permanent redirect a browser has cached forever is the expensive kind
  of typo.

**Markdown is rendered, so an archive of `.md` files is a documentation site.**
A `.md` request comes back as a page styled by `/builtin.css`, and `README.md`
stands in for `index.html` as a directory's default — the rule the place these
files usually live already uses.

```sh
./static-server.run docs.zip        # and / is docs/README.md, rendered
```

The renderer is [`lib/markdown.ts`](lib/markdown.ts): headings with GitHub-style
anchors, emphasis, code spans and fences, links and images, nested and ordered
and task lists, blockquotes, GFM tables with alignment, and rules. Relative links
between documents work as written, because a `.md` file is rendered where it
lies rather than moved somewhere else. `?raw` serves the source instead — with
its own ETag, since it is a different representation of the same file. Rendered
pages are cached in memory against the source's size and mtime.

**HTML passes through, and so does every link scheme.** A `<details>` block,
an inline `<kbd>`, a `mailto:` or a `javascript:` href all arrive as written —
markdown still renders inside an HTML block, and never inside a tag, so an
`href` full of underscores stays an href. GitHub sanitises both because it
renders documents strangers uploaded on its own origin; this renders an archive
you chose and can read, and a viewer that stripped `<details>` would be useless
for the documents that need it. Only code is escaped, spans and fences alike,
because a `<script>` inside backticks is meant to be read.

Reference links, footnotes and setext headings are not supported; the renderer
says so at the top of the file rather than dropping them quietly. One departure
from CommonMark, deliberately: a bullet indented four spaces at the top level is
a list rather than a code block, because that is what somebody who indented a
list meant.

**Two built-in files, as a fallback.** `/builtin.css` styles the generated pages
and `/favicon.ico` answers the request every browser makes without being asked —
the 404 you always see in the log of a freshly stood-up server. Both are looked
for in the **mounts first**: put a `builtin.css` or a `favicon.ico` in any source
you serve and yours wins, with no flag and no configuration. The built-in is only
what nobody supplied.

The stock favicon is [@pipobscure](https://github.com/pipobscure)'s avatar, which
is a fine default for a demo in this repository and almost certainly not what you
want on your own site — so replace it by putting a `favicon.ico` in your content.
That is the override working, and it is one file.

**Everything else you would want**: `HEAD`, 405 with `Allow` for anything else,
301 for a directory without its trailing slash, `index.html` for a directory that
has one, a listing for a directory that does not, `X-Content-Type-Options:
nosniff`, and a refusal for any path containing a `..` segment — checked after
percent-decoding, because the traversal that gets through is always the encoded
one.

`X-Served-By` names the mount that answered, which is how you can see the merge
working.

**Deliberately not here**: compression, HTTP/2, TLS, virtual hosts, and
multipart range responses. Each is worth having in a real server and none of them
would teach you anything about mounting an archive.

---

## Options

```
--host=<addr>     address to listen on (default localhost; 0.0.0.0 for all)
--port=<n>        port to listen on (default 8080; 0 picks a free one)
--max-age=<secs>  freshness for ordinary files (default 3600)
--redirects=<f>   JSON file of redirect rules, applied before anything is served
--no-listing      404 a directory that has no index.html, instead of listing it
--help
```

## The example content

`content/docs` is a small documentation tree — zip it and serve it to see the
markdown viewer with nothing else configured. `content/site-a` is a plain
directory; `content/site-b` is meant to be zipped.
Serve both and the merge is visible: the page in the archive is styled by the
stylesheet in the directory, and neither knows the difference. The root has no
`index.html` unless `site-a` is mounted, so serving only the archive shows the
enumeration page instead — every mounted source, in precedence order.

## Requirements

The same unreleased node the rest of this repository needs — `node:vfs`,
`ZipProvider`, and the `--vfs-mount` / `--vfs-load` flags. See the root
[README](../../README.md#requirements).
