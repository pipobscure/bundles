import { readFileSync } from 'node:fs';

// Redirect rules, from a JSON file:
//
//   {
//     "^/old/(.*)$":      { "location": "/new/$1", "code": 301 },
//     "^/docs$":          { "location": "/docs/guide/" },
//     "^/blog/(\\d+)-.*$": { "location": "https://example.com/p/$1", "code": 302 }
//   }
//
// The key is a regular expression matched against the request path, and the
// location is the replacement — so this is `String.prototype.replace()`, with
// `$1` and the rest of its substitutions available. Rules are tried in the order
// the file lists them and the first match wins.
//
// Everything is compiled and checked when the file is read rather than when a
// request arrives: a typo in a pattern should stop the server starting, not
// surface as a 500 on the one request that happened to reach it.

export interface Redirect {
    pattern: RegExp;
    location: string;
    code: number;
}

/**
 * The codes a redirect may use. 300 (multiple choices) and 304 (not modified)
 * are redirection-class but not redirects, and a rule that produced either would
 * be a rule that does not work.
 */
const CODES = new Set([301, 302, 303, 307, 308]);

export function loadRedirects(file: string): Redirect[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (error) {
        throw new Error(`cannot read redirects from ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file}: expected an object of { "<pattern>": { "location": "<target>", "code": 301 } }`);
    }

    const redirects: Redirect[] = [];
    for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error(`${file}: ${source} must map to an object with a "location"`);
        }
        const rule = value as { location?: unknown; code?: unknown };

        if (typeof rule.location !== 'string' || rule.location === '') {
            throw new Error(`${file}: ${source} needs a non-empty "location"`);
        }
        // 301 by default: a mapping written down in a file is a statement about
        // where something lives now, which is what "permanent" means.
        const code = rule.code === undefined ? 301 : rule.code;
        if (typeof code !== 'number' || !CODES.has(code)) {
            throw new Error(`${file}: ${source} has code ${String(code)}; use one of ${[...CODES].join(', ')}`);
        }

        let pattern: RegExp;
        try {
            pattern = new RegExp(source);
        } catch (error) {
            throw new Error(`${file}: ${source} is not a regular expression: ${error instanceof Error ? error.message : String(error)}`);
        }

        redirects.push({ pattern, location: rule.location, code });
    }
    return redirects;
}

/**
 * The first rule that matches `path`, already substituted — or `null` when none
 * does.
 *
 * A rule whose replacement leaves the path unchanged is skipped rather than
 * answered: it would redirect a client to where it already is, which browsers
 * report as a loop and users report as a broken site. Longer loops (`/a` to
 * `/b` to `/a`) are still yours to avoid; nothing here can see them.
 */
export function redirectFor(redirects: Redirect[], path: string): { location: string; code: number } | null {
    for (const redirect of redirects) {
        if (!redirect.pattern.test(path)) continue;
        const location = path.replace(redirect.pattern, redirect.location);
        if (location === path) continue;
        return { location, code: redirect.code };
    }
    return null;
}
