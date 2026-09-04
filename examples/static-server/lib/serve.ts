import * as PATH from 'node:path';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { Stats } from 'node:fs';
import { find, list, type Mount } from './mounts.ts';
import { contentType } from './mime.ts';
import { cacheControl, digest, etagFor, isFresh } from './cache.ts';
import { builtin, directoryPage, errorPage, mountsPage } from './listing.ts';
import { redirectFor, type Redirect } from './redirects.ts';

// One request, start to finish.
//
// The order of the checks below is the specification's rather than a
// convenience: a conditional request is evaluated *after* the representation is
// selected and *before* any range is applied (RFC 9110 §13.2), because a 304 has
// to answer for the whole representation and a 206 has to be a slice of the one
// the client already validated.

export interface Config {
    mounts: Mount[];
    listing: boolean;
    maxAge: number;
    redirects: Redirect[];
}

export function handle(req: IncomingMessage, res: ServerResponse, config: Config): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('405 method not allowed\n');
        return;
    }

    let path: string | null;
    try {
        path = requestPath(req.url ?? '/');
    } catch {
        // decodeURIComponent throws on a malformed escape, which is a bad
        // request rather than a missing file.
        send(req, res, 400, errorPage(400, 'The request path could not be understood.'));
        return;
    }
    if (path === null) {
        send(req, res, 403, errorPage(403, 'That path tried to leave the served tree.'));
        return;
    }

    // Rules first, before anything is looked for. A redirect table is a
    // statement about where things live, and a file that happened to sit at the
    // old path should not quietly outrank it — the surprising server is the one
    // where adding a file silently disables a redirect.
    const redirect = redirectFor(config.redirects, path);
    if (redirect !== null) {
        res.writeHead(redirect.code, {
            'Location': locationHeader(redirect.location, req.url ?? ''),
            // A permanent redirect a browser caches forever is the expensive
            // kind of typo, so only the permanent ones are cacheable at all.
            'Cache-Control': redirect.code === 301 || redirect.code === 308
                ? `public, max-age=${config.maxAge}`
                : 'no-cache',
            'Content-Length': 0,
        });
        res.end();
        return;
    }

    const hit = find(config.mounts, path);

    if (hit !== null && hit.stats.isDirectory()) {
        // Without the trailing slash every relative link on the page below
        // would resolve one level too high, so correct the URL rather than
        // serve a page whose links are all wrong.
        if (!path.endsWith('/')) {
            res.writeHead(301, {
                'Location': encodePath(`${path}/`) + queryOf(req.url ?? ''),
                'Cache-Control': 'no-cache',
            });
            res.end();
            return;
        }
        const index = find(config.mounts, `${path}index.html`);
        if (index !== null) {
            sendFile(req, res, index.mount, `${path}index.html`, index.stats, config);
            return;
        }
        if (!config.listing) {
            send(req, res, 403, errorPage(403, 'This directory has no index, and listings are off.'));
            return;
        }
        send(req, res, 200, pageFor(path, config));
        return;
    }

    if (hit !== null) {
        sendFile(req, res, hit.mount, path, hit.stats, config);
        return;
    }

    // Nothing matched. At the root that still has an answer — what is mounted —
    // because a root exists whether or not any source has a file at it.
    if (path === '/') {
        send(req, res, 200, pageFor('/', config));
        return;
    }

    // Only now the built-ins. Searching the mounts first is what lets a site
    // carry its own `/builtin.css` or `/favicon.ico` and have it win — the
    // fallback is for what nobody supplied, which on a freshly stood-up server
    // is usually the favicon a browser asks for without being told to.
    const own = builtin(path);
    if (own !== null) {
        sendBuffer(req, res, own.body, {
            type: own.type,
            etag: digest(own.body),
            cacheControl: `public, max-age=${config.maxAge}`,
        });
        return;
    }

    send(req, res, 404, errorPage(404, `Nothing is mounted at ${path}`));
}

/**
 * The generated page for a directory with no `index.html`. The root gets the
 * enumeration of the mounted sources — the question "what is this server
 * serving?" is only interesting at the top — and everything below it gets the
 * ordinary listing.
 */
function pageFor(path: string, config: Config): string {
    const entries = list(config.mounts, path);
    return path === '/'
        ? mountsPage(config.mounts, entries)
        : directoryPage(path, entries, config.mounts);
}

/**
 * Turns a request target into a path inside the served trees, or `null` when it
 * has no business being served.
 *
 * Decoding happens first, so `%2e%2e%2f` meets the same rule as `../` — the
 * traversal that gets through is always the encoded one. A `..` segment is then
 * refused outright rather than normalised away: collapsing `/../../etc/passwd`
 * to `/etc/passwd` is safe, but it answers a question the client did not ask,
 * and a refusal is the honest reply to a path that tried to leave.
 */
export function requestPath(target: string): string | null {
    const raw = decodeURIComponent(target.split('?')[0]!.split('#')[0]!);
    if (raw.includes('\0')) return null;

    // Backslashes are path separators on Windows, so a served tree must not be
    // reachable through them here either.
    const slashed = raw.replaceAll('\\', '/');
    if (slashed.split('/').includes('..')) return null;

    const normalised = PATH.posix.normalize(slashed.startsWith('/') ? slashed : `/${slashed}`);
    // normalize() drops a trailing slash from anything but the root, and the
    // directory handling above needs it back.
    return slashed.endsWith('/') && !normalised.endsWith('/') ? `${normalised}/` : normalised;
}

function sendFile(
    req: IncomingMessage, res: ServerResponse, mount: Mount, path: string, stats: Stats, config: Config,
): void {
    const type = contentType(path);
    const etag = etagFor(mount, path, stats);
    const lastModified = new Date(Math.floor(stats.mtimeMs / 1000) * 1000);
    const headers: OutgoingHttpHeaders = {
        'Content-Type': type,
        'ETag': etag,
        'Last-Modified': lastModified.toUTCString(),
        'Cache-Control': cacheControl(path, type, config),
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'X-Served-By': mount.id,
    };

    if (isFresh(req, etag, lastModified)) {
        // A 304 carries what the client needs to update what it holds, and no
        // body: no Content-Length, no Content-Type.
        res.writeHead(304, {
            'ETag': etag,
            'Last-Modified': headers['Last-Modified'],
            'Cache-Control': headers['Cache-Control'],
            'X-Served-By': mount.id,
        });
        res.end();
        return;
    }

    const range = wantsRange(req, etag, lastModified) ? parseRange(req.headers.range, stats.size) : null;

    if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stats.size}`, 'Content-Length': 0 });
        res.end();
        return;
    }

    const start = range === null ? 0 : range.start;
    const end = range === null ? Math.max(stats.size - 1, 0) : range.end;
    const length = stats.size === 0 ? 0 : end - start + 1;

    if (range !== null) headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
    headers['Content-Length'] = length;

    res.writeHead(range === null ? 200 : 206, headers);
    if (req.method === 'HEAD' || length === 0) {
        res.end();
        return;
    }

    const stream = mount.vfs.createReadStream(path, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}

/**
 * Whether a `Range` should be honoured at all. `If-Range` is the client saying
 * "only if this is still the representation I have", so a mismatch means send
 * the whole thing rather than a slice of something else.
 */
function wantsRange(req: IncomingMessage, etag: string, lastModified: Date): boolean {
    if (req.headers.range === undefined) return false;
    // `If-Range` is not one of the headers node types as single-valued, and a
    // repeated one is a client bug rather than a reason to guess: take the first
    // and let a mismatch fall through to the whole representation.
    const raw = req.headers['if-range'];
    const ifRange = Array.isArray(raw) ? raw[0] : raw;
    if (ifRange === undefined) return true;
    if (ifRange.startsWith('"') || ifRange.startsWith('W/')) return ifRange === etag;
    const stamp = Date.parse(ifRange);
    return !Number.isNaN(stamp) && lastModified.getTime() <= stamp;
}

/**
 * A single byte range, `'unsatisfiable'`, or `null` to serve the whole thing.
 * Multiple ranges are answered in full on purpose: a server may always ignore a
 * `Range` it does not want to honour, and multipart/byteranges is a lot of
 * machinery for a case a static site never hits.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
    if (header === undefined) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (match === null) return null;

    const from = match[1]!;
    const to = match[2]!;
    if (from === '' && to === '') return null;

    if (from === '') {
        // `bytes=-500` is the last 500 bytes, clamped to what there is.
        const suffix = Number(to);
        if (suffix === 0) return 'unsatisfiable';
        return { start: Math.max(size - suffix, 0), end: size - 1 };
    }

    const start = Number(from);
    if (start >= size) return 'unsatisfiable';
    const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
    if (end < start) return 'unsatisfiable';
    return { start, end };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, html: string): void {
    sendBuffer(req, res, Buffer.from(html, 'utf-8'), {
        type: 'text/html; charset=utf-8',
        // A generated page describes what is mounted right now, so it is never
        // worth caching: the tree it describes can change without any file in it
        // changing.
        cacheControl: 'no-store',
    }, status);
}

function sendBuffer(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    meta: { type: string; cacheControl: string; etag?: string },
    status = 200,
): void {
    const headers: OutgoingHttpHeaders = {
        'Content-Type': meta.type,
        'Content-Length': body.length,
        'Cache-Control': meta.cacheControl,
        'X-Content-Type-Options': 'nosniff',
    };
    if (meta.etag !== undefined) {
        headers['ETag'] = meta.etag;
        const noneMatch = req.headers['if-none-match'];
        if (noneMatch !== undefined && noneMatch.split(',').some((c) => c.trim() === meta.etag)) {
            res.writeHead(304, { 'ETag': meta.etag, 'Cache-Control': meta.cacheControl });
            res.end();
            return;
        }
    }
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * The `Location` for a redirect rule. An absolute URL is used exactly as
 * written; a path is percent-encoded segment by segment, because the
 * replacement may have carried decoded text — a filename with a space in it
 * would otherwise produce a header no client can parse. A query the rule did not
 * write itself is carried over from the request, so `?page=2` survives a move.
 */
function locationHeader(location: string, url: string): string {
    const absolute = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(location);
    const mark = location.search(/[?#]/);
    const head = mark === -1 ? location : location.slice(0, mark);
    const rest = mark === -1 ? '' : location.slice(mark);
    return (absolute ? head : encodePath(head)) + (rest === '' ? queryOf(url) : rest);
}

function queryOf(url: string): string {
    const mark = url.indexOf('?');
    return mark === -1 ? '' : url.slice(mark);
}

/** Percent-encodes a path for a header or a link, leaving the separators alone. */
export function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}
