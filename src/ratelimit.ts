import { setTimeout as sleep } from 'node:timers/promises';

// Being told to slow down, and doing so. A server that answers 429 — or 503
// with a Retry-After — is asked again once the time it names has passed:
// `Retry-After` first (seconds, or an HTTP date), then atproto's
// `ratelimit-reset`, and without either a short backoff. A wait longer than
// anyone would sit through is not waited for: it fails, saying when to try
// again.
//
// Every request is made afresh for each attempt, by the `send` it is given, so
// whatever has to be new each time — a DPoP proof — is. Only requests that are
// safe to send twice come through here: reads, records written at a key of
// our choosing, sign-ins.

export interface Patience {
    /** Where a wait is reported (default: stderr). */
    onWait?: ((line: string) => void) | undefined;
    /** The longest single wait, in milliseconds (default: `BUNDLE_RATE_LIMIT_WAIT` seconds, else 10 minutes). */
    maxWait?: number | undefined;
    /** How many times one request is retried (default: 5). */
    retries?: number | undefined;
    /** Ends a wait early, as it would end the request. */
    signal?: AbortSignal | null | undefined;
    /** For tests: how a wait is waited. */
    sleep?: ((ms: number, signal?: AbortSignal | null | undefined) => Promise<void>) | undefined;
}

const DEFAULT_MAX_WAIT = 10 * 60_000;
const DEFAULT_RETRIES = 5;

/** Send a request, and again — as often as `retries` — for as long as the server says to wait. */
export async function patiently(send: () => Promise<Response>, url: string, patience: Patience = {}): Promise<Response> {
    const retries = patience.retries ?? DEFAULT_RETRIES;
    const maxWait = patience.maxWait ?? configuredMaxWait();
    const report = patience.onWait ?? ((line: string) => process.stderr.write(`${line}\n`));
    const wait = patience.sleep ?? ((ms: number, signal?: AbortSignal | null) => sleep(ms, undefined, signal ? { signal } : {}));
    const what = describe(url);

    for (let attempt = 0; ; attempt++) {
        const response = await send();
        const asked = waitFor(response, attempt);
        if (asked === undefined) return response;
        if (attempt >= retries) {
            throw rateLimited(`${what} is still rate limiting after ${retries} ${retries === 1 ? 'retry' : 'retries'} (${response.status}) — try again later`, response);
        }
        if (asked.ms > maxWait) {
            const until = new Date(Date.now() + asked.ms);
            throw rateLimited(`${what} is rate limiting (${response.status}), and asks to wait ${duration(asked.ms)}, until ${until.toISOString()} — ` +
                `longer than the ${duration(maxWait)} this waits; try again then, or allow more with BUNDLE_RATE_LIMIT_WAIT=<seconds>`, response);
        }
        await response.body?.cancel().catch(() => {});
        report(`  ! ${what} is rate limiting (${response.status}): waiting ${duration(asked.ms)}, ${asked.why}`);
        await wait(asked.ms, patience.signal);
    }
}

/**
 * How long a response says to wait before asking again, or nothing when it
 * does not say to: a 429, or a 503 with `Retry-After`. Times the server gives
 * as dates are measured from its own `Date`, so a skewed clock here does not
 * skew the wait.
 */
export function waitFor(response: Response, attempt = 0): { ms: number; why: string } | undefined {
    const retryAfter = response.headers.get('retry-after')?.trim();
    if (response.status !== 429 && !(response.status === 503 && retryAfter)) return undefined;
    const now = Date.parse(response.headers.get('date') ?? '') || Date.now();
    if (retryAfter) {
        if (/^\d+$/.test(retryAfter)) return { ms: Number(retryAfter) * 1000, why: 'as it asks (Retry-After)' };
        const at = Date.parse(retryAfter);
        if (!Number.isNaN(at)) return { ms: Math.max(0, at - now), why: 'as it asks (Retry-After)' };
    }
    // atproto's PDSes say when the window resets, as seconds since the epoch;
    // the IETF draft these headers come from says seconds from now. A number
    // that could only be one of them is read as that one.
    const reset = response.headers.get('ratelimit-reset')?.trim();
    if (reset && /^\d+$/.test(reset)) {
        const seconds = Number(reset);
        const ms = seconds > 1e9 ? seconds * 1000 - now : seconds * 1000;
        return { ms: Math.max(0, ms) + 1000, why: 'until its limit resets (ratelimit-reset)' };
    }
    return { ms: 2000 * 2 ** attempt, why: 'as it gave no time to wait' };
}

/** A fetch that waits when told to: for code that hands a fetch on. */
export function patientFetch(fetch: typeof globalThis.fetch = globalThis.fetch, patience: Patience = {}): typeof globalThis.fetch {
    const { onWait, maxWait, retries, sleep: wait } = patience;
    return (input, init) => patiently(() => fetch(input, init), String(input instanceof Request ? input.url : input), {
        onWait, maxWait, retries, sleep: wait, signal: init?.signal ?? patience.signal,
    });
}

function configuredMaxWait(): number {
    const configured = process.env['BUNDLE_RATE_LIMIT_WAIT'];
    return configured && /^\d+$/.test(configured) ? Number(configured) * 1000 : DEFAULT_MAX_WAIT;
}

// The host, and for XRPC the method: what a person needs to know is being slow.
function describe(url: string): string {
    try {
        const parsed = new URL(url);
        const method = /^\/xrpc\/([^/?]+)/.exec(parsed.pathname)?.[1];
        return method ? `${parsed.host} (${method})` : parsed.host;
    } catch {
        return url;
    }
}

function duration(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function rateLimited(text: string, response: Response): Error {
    return Object.assign(new Error(text), { code: 'ERR_BUNDLE_RATE_LIMITED', status: response.status });
}
