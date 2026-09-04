# Caching a rendered page

The page you are reading is generated, so the validator has to describe the
*rendered* bytes rather than the file behind them:

- The **ETag** is a hash of the rendered HTML. Ask for `?raw` and you get a
  different representation with a different etag, which is correct — they are
  different bytes.
- **`Cache-Control`** is the HTML policy: `max-age=0, must-revalidate`. Docs
  change, and a stale page is worse than a round trip.
- The render itself is **cached in memory** against the source's size and mtime,
  so the second reader does not pay for it again.

---

*Rendered by a server that fits in a 30 kB archive.*
