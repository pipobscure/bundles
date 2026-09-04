import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Stats } from 'node:fs';
import type { Mount } from './mounts.ts';

// Validators and freshness: the two halves of a cache header set, and the part
// of a static server worth getting exactly right.
//
// **The ETag is a hash of the content**, not of the metadata. The cheap trick is
// `"<size>-<mtime>"`, which is what most servers do — but a ZIP entry's mtime is
// whatever the archive recorded, two servers on the same bytes disagree, and a
// rebuild that changed nothing still busts every cache. Hashing costs one read
// of each file, once, and buys a validator that means what it says: same etag,
// same bytes, wherever they were served from.
//
// The hash is kept against (size, mtime), so the second request answers a
// conditional GET without opening the file at all — which is the whole point of
// having a validator.

const etags = new Map<string, { stamp: string; etag: string }>();

/** The strong ETag for a file, computed once per (path, size, mtime). */
export function etagFor(mount: Mount, path: string, stats: Stats): string {
    const key = `${mount.source} ${path}`;
    const stamp = `${stats.size}:${stats.mtimeMs}`;
    const hit = etags.get(key);
    if (hit?.stamp === stamp) return hit.etag;

    const etag = digest(mount.vfs.readFileSync(path));
    etags.set(key, { stamp, etag });
    return etag;
}

/** A strong ETag over bytes already in hand. */
export function digest(body: Buffer): string {
    return `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
}

/**
 * The `Cache-Control` for a path. Three policies, because static content splits
 * three ways and one number cannot serve all of them:
 *
 *   * A **fingerprinted** file — `app.9f2c1a7d.js`, the shape every bundler
 *     emits — cannot change without changing its name, so it is immutable for a
 *     year. This is the only case where a long max-age is safe.
 *   * **HTML** is the entry to everything else and carries no fingerprint of its
 *     own, so it must be revalidated every time. `max-age=0, must-revalidate`
 *     with an ETag costs one 304 and never serves a stale page.
 *   * **Everything else** gets the configured max-age: fresh for a while, then
 *     revalidated.
 */
export function cacheControl(path: string, type: string, options: { maxAge: number }): string {
    if (isFingerprinted(path)) return 'public, max-age=31536000, immutable';
    if (type.startsWith('text/html')) return 'public, max-age=0, must-revalidate';
    return `public, max-age=${options.maxAge}`;
}

// `name.<hash>.ext`, where the hash is a run of at least eight hex digits
// between dots — deliberately narrow, because marking an ordinary file immutable
// for a year is the one mistake here that cannot be taken back once a client has
// cached it.
const FINGERPRINT = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

export function isFingerprinted(path: string): boolean {
    return FINGERPRINT.test(path);
}

/**
 * Whether a conditional request means "you already have this".
 *
 * `If-None-Match` wins outright when present, and `If-Modified-Since` is only
 * consulted in its absence — RFC 9110 §13.1.3: a validator the origin chose
 * beats a timestamp the client inferred. Comparison is weak (a `W/` prefix is
 * ignored), which is what a GET wants: the representations have to be
 * equivalent, not byte-identical.
 */
export function isFresh(req: IncomingMessage, etag: string, lastModified: Date): boolean {
    const noneMatch = req.headers['if-none-match'];
    if (noneMatch !== undefined) {
        if (noneMatch.trim() === '*') return true;
        const wanted = weaken(etag);
        return noneMatch.split(',').some((candidate) => weaken(candidate.trim()) === wanted);
    }

    const since = req.headers['if-modified-since'];
    if (since !== undefined) {
        const stamp = Date.parse(since);
        // An HTTP-date carries whole seconds, so compare at that resolution: a
        // file written 400ms after the timestamp a client holds is not a file it
        // needs to fetch again.
        if (!Number.isNaN(stamp)) return Math.floor(lastModified.getTime() / 1000) * 1000 <= stamp;
    }

    return false;
}

function weaken(etag: string): string {
    return etag.startsWith('W/') ? etag.slice(2) : etag;
}
