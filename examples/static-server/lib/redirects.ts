import { readFileSync } from 'node:fs';

// Redirect rules, from a JSON file:
//
//   {
//     "^/old/(.*)$": { "location": "/new/$1", "code": 301 },
//     "^/docs$":     { "location": "/docs/guide/" },
//     "https?://":   { "location": "/intercept?$0", "code": 302 }
//   }
//
// The key is a regular expression matched against the request path, and the
// location is the replacement — so this is `String.prototype.replace()`, with
// `$1` and the rest of its substitutions available. `$0` is accepted as a
// spelling of `$&`, the whole match, because that is what everyone reaches for
// first.
//
// **Every rule is applied, in file order, each to what the last one produced.**
// That is what makes the pair above work: the first turns `/site/x` into
// `https://external.site/x`, and the second sees that result and hands it to an
// interceptor. First-match-wins would leave the second rule unreachable for
// exactly the paths it exists to catch.
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

        // `$&` is the whole match. `$0` means nothing to String.replace and so
        // has never meant anything else, which leaves it free to mean the
        // obvious thing. The replacement has to be a function: as a string,
        // `'$&'` would itself be substituted — with the text it just matched,
        // which is `$0`, making the whole line a no-op.
        const location = rule.location.replaceAll('$0', () => '$&');
        redirects.push({ pattern, location, code });
    }
    return redirects;
}

/**
 * Runs `path` through every rule in order and reports where it ended up, or
 * `null` when nothing moved it.
 *
 * Each rule sees what the rule before it produced, so rules compose: one can
 * rewrite a prefix and the next can act on the result. The code comes from the
 * last rule that actually changed the value — the final say belongs to whichever
 * rule decided where this ends up.
 *
 * A pass that leaves the path exactly as it was is not a redirect: answering it
 * would send a client to where it already is, which browsers report as a loop
 * and users report as a broken site. Longer loops — `/a` to `/b` to `/a` across
 * two rules — are still yours to avoid; nothing here can see them.
 */
export function redirectFor(redirects: Redirect[], path: string): { location: string; code: number } | null {
    let location = path;
    let code = 0;

    for (const redirect of redirects) {
        if (!redirect.pattern.test(location)) continue;
        const next = location.replace(redirect.pattern, redirect.location);
        if (next === location) continue;
        location = next;
        code = redirect.code;
    }

    return code === 0 ? null : { location, code };
}
