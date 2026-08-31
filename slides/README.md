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
**green** when you are ahead. Planned runtime is **25:05** of content across 23 slides,
leaving room for questions in a 30-minute slot. Per-slide budgets live in each
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
- **Check the status slide** (`0x13`). It lists six work packages and asserts five are in
  Node. As of Aug 2026 two were still in flight — the Zip VFS provider (~2 weeks out) and
  the `--vfs-mount` / `--vfs-load` flags (~4–6 weeks). If either slipped, change that row.
  The speaker note repeats this.
- **Verify the Shai-Hulud framing** on `0x03`. Reporting varies by source and wave; the
  notes recommend "hundreds of packages across two waves in late 2025, and CISA issued an
  advisory" over a precise count you would have to defend.
- **Decide the Sigstore demo** (`0x10`): live from CI, pre-recorded, or slide-only. The
  notes cover all three. Signing now works for real — `npm run sigstore` opens a GitHub
  sign-in — but it needs network and a browser, so decide in advance whether you trust the
  room's wifi with it.
- **The audit skill (`0x12`) is built** (`skills/audit-bundle/`). Run
  `/audit-bundle app.run` once before the talk to check it still behaves, and plant
  something findable in the tree if you want the demo to land.
- **Terminal hygiene:** font size up, scrollback cleared, short prompt, already `cd`'d in,
  and `cp app.run /tmp/app.run.bak` before the tamper demo so the later demos still work.
- **Pre-build the artifacts:** `npm run build` produces `app.bundle`, `app.signed.bundle`
  and `app.run` offline against the test PKI, so a failed network call on stage costs you
  nothing. Note the demo is now two commands — `npm run create` then `npm run archive` —
  because signing is a separate step; that is deliberate and slide `0x0E` shows both.

## Structure

| | Act | Slides |
|---|---|---|
| `0x00` | | title |
| `0x01`–`0x06` | I — where this comes from | the recurring problems, then examples: durchblicker, Bloomberg ×2, TC39, prior art |
| `0x07`–`0x0C` | II — the primitive | mechanism vs policy, trees not blobs, `baseOffset`, mount/load, `registerProvider`, why the signature format stays out of the runtime |
| `0x0D`–`0x12` | III — the optional layer | the signing scheme, then five demos |
| `0x13`–`0x16` | IV — close | status, limitations, the ask, questions |

Slide offsets, act labels and kicker numbers are all derived from position at runtime, so
inserting or reordering a slide cannot leave them inconsistent.

## Editing

It is one HTML file with the CSS and JS inline at the top. Slides are `<section
class="slide" data-act="…" data-t="seconds">`; speaker notes are a `<div class="notes"
hidden>` at the end of each section and are rendered into the notes panel as HTML.

To add a slide, copy an existing `<section>`, set `data-act` and `data-t`, and leave the
`.off`, `.act` and kicker-number spans empty — they fill themselves in.
