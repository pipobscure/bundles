// Content types, by extension. Short on purpose: an example that shipped a
// thousand-entry table would be a table with a server attached.
//
// Everything textual carries `; charset=utf-8`, because a browser left to guess
// an encoding will eventually guess wrong.

const TYPES = new Map<string, string>(Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.webmanifest': 'application/manifest+json',
}));

/**
 * The content type for a path, or `application/octet-stream` when the extension
 * is unknown — never a guess at the bytes, which is how a text file ends up
 * offered as a download and a download ends up rendered as text.
 */
export function contentType(path: string): string {
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    if (dot <= slash + 1) return 'application/octet-stream';
    return TYPES.get(path.slice(dot).toLowerCase()) ?? 'application/octet-stream';
}
