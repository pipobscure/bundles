import * as PATH from 'node:path';
import { readFileSync } from 'node:fs';
import { encodePath } from './serve.ts';
import type { Entry, Mount } from './mounts.ts';

// The pages the server generates itself: the mount enumeration, a directory
// listing, and the error pages.
//
// They are styled by `assets/page.css`, read out of the *server's own tree* — so
// when the server runs as a signed archive, that stylesheet is a member of that
// archive, fetched through the same mount the code was loaded from. It is the
// smallest possible demonstration of what this project is about: an application
// is a tree, and its assets travel with it.
//
// It is also the file that makes the observation step honest. Nothing reads it
// until a *generated* page is served, so a run that only fetches content leaves
// it out of the archive — see the README's step 1.

const ASSETS = PATH.join(import.meta.dirname, '..', 'assets');
const cached = new Map<string, { body: Buffer; type: string }>();

/**
 * One of the server's own files, by name — and only the ones named here. A
 * server that resolves its own directory from a request path is a server that
 * eventually serves its own source.
 */
export function ownAsset(name: string): { body: Buffer; type: string } | null {
    if (name !== 'page.css') return null;
    const hit = cached.get(name);
    if (hit !== undefined) return hit;

    let body: Buffer;
    try {
        body = readFileSync(PATH.join(ASSETS, name));
    } catch {
        return null;
    }
    const asset = { body, type: 'text/css; charset=utf-8' };
    cached.set(name, asset);
    return asset;
}

/**
 * The root page: every mounted source, in precedence order, and what sits at the
 * top of the merged tree. This is what you get when nothing supplies an
 * `index.html` of its own.
 */
export function mountsPage(mounts: Mount[], entries: Entry[]): string {
    if (mounts.length === 0) {
        return page('Nothing mounted', `
    <h1>Nothing mounted</h1>
    <p class="lead">This server has nothing to serve. Name a directory or an archive on the command
      line and it appears here, along with everything in it.</p>
    <p class="foot">Starting up read every module this server has, and this page is the last code
      path — bar the stylesheet it links, which your browser is fetching separately. That pair is a
      complete observation run, with nothing mounted at all.</p>`);
    }

    const rows = mounts.map((mount, index) => `
      <tr>
        <td class="n">${index + 1}</td>
        <td><code>${escape(mount.id)}</code><div class="src">${escape(mount.source)}</div></td>
        <td><span class="kind ${mount.kind}">${mount.kind}</span></td>
      </tr>`).join('');

    return page('Mounted content', `
    <h1>Mounted content</h1>
    <p class="lead">${mounts.length} ${mounts.length === 1 ? 'source is' : 'sources are'} being served, in
      precedence order — an earlier one shadows a later one, the way a search path does.</p>
    <table class="mounts">
      <thead><tr><th></th><th>source</th><th>kind</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${entriesTable('/', entries)}
    <p class="foot">No <code>index.html</code> at the root, so this page stands in for one. Put one in any
      mounted source and it is served instead.</p>`);
}

/** A directory with no `index.html` of its own. */
export function directoryPage(path: string, entries: Entry[], mounts: Mount[]): string {
    const parent = parentOf(path);
    return page(path, `
    <h1>${escape(path)}</h1>
    <p class="lead">Merged across ${mounts.length} mounted ${mounts.length === 1 ? 'source' : 'sources'}.</p>
    ${parent === null ? '' : `<p><a class="up" href="${encodePath(parent)}">↑ ${escape(parent)}</a></p>`}
    ${entriesTable(path, entries)}`);
}

export function errorPage(status: number, detail: string): string {
    const titles: Record<number, string> = {
        400: 'Bad request',
        403: 'Forbidden',
        404: 'Not found',
        405: 'Method not allowed',
    };
    return page(String(status), `
    <h1 class="err">${status} <span>${escape(titles[status] ?? 'Error')}</span></h1>
    <p class="lead">${escape(detail)}</p>
    <p><a class="up" href="/">↑ everything that is mounted</a></p>`);
}

function entriesTable(path: string, entries: Entry[]): string {
    if (entries.length === 0) return '<p class="empty">Nothing here.</p>';
    const rows = entries.map((entry) => {
        const href = encodePath(`${path}${entry.name}${entry.directory ? '/' : ''}`);
        return `
      <tr>
        <td><a href="${href}">${escape(entry.name)}${entry.directory ? '/' : ''}</a></td>
        <td class="size">${entry.directory ? '' : bytes(entry.size)}</td>
        <td class="from"><code>${escape(entry.mount.id)}</code></td>
      </tr>`;
    }).join('');
    return `<table class="entries">
      <thead><tr><th>name</th><th class="size">size</th><th class="from">from</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function parentOf(path: string): string | null {
    if (path === '/') return null;
    const parent = PATH.posix.dirname(path.replace(/\/$/, ''));
    return parent.endsWith('/') ? parent : `${parent}/`;
}

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="/__server__/page.css">
</head>
<body>
<main>${body}</main>
<footer>served by <code>static-server</code>, out of a mounted archive</footer>
</body>
</html>
`;
}

function bytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function escape(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
