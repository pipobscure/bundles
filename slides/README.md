# Ship the Tree — talk deck

A self-contained conference deck. `index.html` is the whole thing: open it in a browser,
no build step, no server, no dependencies. The only thing it fetches from the network is
two Google Fonts (Archivo and JetBrains Mono); everything else — layout, diagrams, the
chart, the speaker notes — is in the file.

```sh
xdg-open index.html          # or just drag it into a browser
```

## Controls

| Key | |
|---|---|
| <kbd>→</kbd> <kbd>↓</kbd> <kbd>space</kbd> | next slide |
| <kbd>←</kbd> <kbd>↑</kbd> | previous |
| <kbd>Home</kbd> / <kbd>End</kbd> | first / last |
| <kbd>S</kbd> | speaker notes |
| <kbd>O</kbd> | overview grid |
| <kbd>T</kbd> | start / pause the pace timer |
| <kbd>R</kbd> | reset the timer |
| <kbd>F</kbd> | fullscreen |
| <kbd>?</kbd> | controls |

The pace timer turns **red** when you are behind the plan for the current slide and
**green** when you are ahead. Planned runtime is **28:15** of content across 24 slides.
That is tight for a 30-minute slot with questions, so decide your cuts in advance rather
than discovering them on stage: `0x13` (the tool as a bundle of itself) goes first — it is
the most satisfying beat in Act III and the least load-bearing — then `0x11` (open it with
`unzip`), which makes a point the audit slide makes again. Per-slide budgets live in each
`<section data-t="seconds">`; the notes panel shows the planned start time for the slide
you are on.

The deck deep-links by slide number (`index.html#12`), so you can resume where you left off.

Everything is laid out on a fixed 1280×720 stage that is scaled to fit the window, so type
is identical on any projector. It is deliberately single-theme dark — a presented deck
should not follow the room's OS theme.

## Refreshing the npm chart before you present

Slide `0x02` charts npm's own published incident record and makes a specific claim in the
caption ("one every N days"). That window moves, so re-derive it near the talk rather than
presenting a stale number:

```sh
node tools/refresh-chart.mjs             # fetch fresh, redraw, rewrite the caption
node tools/refresh-chart.mjs --offline   # redraw from the cached copy
```

It rewrites the SVG between the `CHART:START` / `CHART:END` markers in `index.html` and
updates the incident count, span, cadence and major/critical count in the caption to match.
It is idempotent. Don't hand-edit between the markers.

`data/npm-incidents.json` is the cached response, refreshed on every online run.

**Caveat worth knowing:** the API returns only the 50 most recent incidents, so this is a
moving window over the recent past, not a complete history. The caption says so.

## Before you present — checklist

- **Re-run the chart** (above) so the cadence figure is current.
- **Check the status slide** (`0x14`). It lists seven work packages: five asserted as in
  Node, the userland layer, and SEA-assets-behind-a-VFS-mount as proposed
  (nodejs/node#65675, not merged). If any of those moved, change the row. The talk is
  planned for whenever a compatible Node actually ships, so this slide is the one most
  likely to be wrong by then. The speaker note repeats this.
- **Verify the Shai-Hulud framing** on `0x03`. Reporting varies by source and wave; the
  notes recommend "hundreds of packages across two waves in late 2025, and CISA issued an
  advisory" over a precise count you would have to defend.
- **Decide the Sigstore demo** (`0x10`): live from CI, pre-recorded, or slide-only. The
  notes cover all three. Signing works for real — `bundle sign` with no `--key` opens a
  GitHub sign-in — but it needs network and a browser, so decide in advance whether you
  trust the room's wifi with it.
- **The audit (`0x12`) is built and is now a build step**, not a closing demo:
  `observe → create → audit → sign`, with `tools/audit.ts --check` refusing to sign
  without a clean verdict pinned to the archive's sha256. Run `/audit-bundle` once before
  the talk to check the skill still behaves, and plant something findable in the tree if
  you want the review itself to land. If you are short on time, show the refusal and skip
  the review — the refusal is the point.
- **`0x13` claims the tool ships as a bundle of itself**, which is true as of this build:
  `npm run release:cli` then `npm run sign:cli`. Check `npm pack --dry-run` still lists
  `bundle.run`, and that `package.json`'s `bin` still points straight at it — the slide's
  whole point is that there is no wrapper script, and a regression there makes it false.
- **Terminal hygiene:** font size up, scrollback cleared, short prompt, already `cd`'d in,
  and `cp app.run /tmp/app.run.bak` before the tamper demo so the later demos still work.
- **Pre-build the artifacts** so a failed network call on stage costs you nothing. The test
  PKI is generated rather than committed, so this now starts with `npm run testpki`:

  ```sh
  npm run build && npm run testpki
  bundle create --base ./app -f app.manifest -o app.bundle
  bundle sign --key build/certs/leaf.key --chain build/certs/chain.pem \
      --prefix shell-base -o app.run app.bundle
  ```

  The demo is deliberately two commands — `create` then `sign` — because signing is a
  separate step, and slide `0x0F` shows both.
- **`head -c 89 app.run` on `0x0F` shows the current prefix**, which is a two-line
  `#!/bin/sh` that `exec`s node with `"$0"` and a `--`. If you are tempted to describe it as
  the `env -S` one-liner, don't: that form is prettier and broken, because the user's
  arguments land after the kernel-appended path with nowhere to put the `--`, so
  `app.run --help` prints node's help. Slide `0x0A` still describes the trailing-flag trick
  correctly — that is about the flag, not about this prefix.

## Structure

| | Act | Slides |
|---|---|---|
| `0x00` | | title |
| `0x01`–`0x06` | I — where this comes from | the recurring problems, then examples: durchblicker, Bloomberg ×2, TC39, prior art |
| `0x07`–`0x0C` | II — the primitive | mechanism vs policy, trees not blobs, `baseOffset`, mount/load, `registerProvider`, why the signature format stays out of the runtime |
| `0x0D`–`0x13` | III — the optional layer | the signing scheme, then six demos — ending with the tool applying all of it to itself |
| `0x14`–`0x17` | IV — close | status, limitations, the ask, questions |

Slide offsets, act labels and kicker numbers are all derived from position at runtime, so
inserting or reordering a slide cannot leave them inconsistent.

## Editing

It is one HTML file with the CSS and JS inline at the top. Slides are `<section
class="slide" data-act="…" data-t="seconds">`; speaker notes are a `<div class="notes"
hidden>` at the end of each section and are rendered into the notes panel as HTML.

To add a slide, copy an existing `<section>`, set `data-act` and `data-t`, and leave the
`.off`, `.act` and kicker-number spans empty — they fill themselves in.

Keep the deck in step with the repository as the tool changes; it is a talk about a thing
that is still moving, and a slide asserting something the code stopped doing is worse than
no slide. The claims most likely to rot are the status table (`0x14`), anything with a
command in it, and the two "this is built" statements on `0x12` and `0x13`.

The deck is also published as a Claude artifact. It is the same file — the artifact is the
body-only form, which is exactly what `index.html` already is — so republishing is a
straight upload of this file, not a conversion.
