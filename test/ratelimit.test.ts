import test from 'node:test';
import assert from 'node:assert/strict';
import { patiently, patientFetch, waitFor } from '../src/ratelimit.ts';

// Being told to slow down: how long each kind of answer says to wait, and what
// is done about it. No real waiting — the sleeps are recorded instead.

const URL_ = 'https://pds.test/xrpc/com.atproto.repo.putRecord';
const NOW = Date.parse('2026-10-09T12:00:00Z');

function answer(status: number, headers: Record<string, string> = {}): Response {
    return new Response(status === 200 ? '{}' : JSON.stringify({ error: 'RateLimitExceeded' }), { status, headers });
}

/** Answers in turn, recording each request made and each wait asked for. */
function scripted(...answers: Response[]) {
    const slept: number[] = [];
    const lines: string[] = [];
    let sent = 0;
    const send = async () => { sent++; return answers.shift() ?? answer(200); };
    const patience = { onWait: (line: string) => lines.push(line), sleep: async (ms: number) => { slept.push(ms); } };
    return { send, patience, slept, lines, sent: () => sent };
}

test('Retry-After is read as seconds, or as a date measured from the server\'s own clock', () => {
    assert.deepEqual(waitFor(answer(429, { 'retry-after': '17' })), { ms: 17_000, why: 'as it asks (Retry-After)' });
    const date = new Date(NOW).toUTCString();
    assert.equal(waitFor(answer(429, { 'retry-after': new Date(NOW + 90_000).toUTCString(), date }))!.ms, 90_000);
    assert.equal(waitFor(answer(429, { 'retry-after': new Date(NOW - 5_000).toUTCString(), date }))!.ms, 0, 'a time already past is no wait');
});

test('without Retry-After, atproto\'s ratelimit-reset says when — as a time, or as seconds from now — else a backoff', () => {
    const date = new Date(NOW).toUTCString();
    assert.deepEqual(waitFor(answer(429, { 'ratelimit-reset': String(NOW / 1000 + 120), date })), { ms: 121_000, why: 'until its limit resets (ratelimit-reset)' });
    assert.equal(waitFor(answer(429, { 'ratelimit-reset': '30' }))!.ms, 31_000);
    assert.deepEqual([0, 1, 2].map((attempt) => waitFor(answer(429), attempt)!.ms), [2000, 4000, 8000]);
    assert.equal(waitFor(answer(429, { 'retry-after': '3', 'ratelimit-reset': '300' }))!.ms, 3000, 'Retry-After first');
});

test('only 429, and a 503 that says when, are waited for', () => {
    assert.equal(waitFor(answer(200)), undefined);
    assert.equal(waitFor(answer(503)), undefined, 'a 503 that names no time is an error');
    assert.equal(waitFor(answer(503, { 'retry-after': '5' }))!.ms, 5000);
    assert.equal(waitFor(answer(500, { 'retry-after': '5' })), undefined);
});

test('a request is made again, afresh, after each wait, and each wait is said', async () => {
    const run = scripted(answer(429, { 'retry-after': '2' }), answer(503, { 'retry-after': '1' }));
    const response = await patiently(run.send, URL_, run.patience);
    assert.equal(response.status, 200);
    assert.equal(run.sent(), 3);
    assert.deepEqual(run.slept, [2000, 1000]);
    assert.deepEqual(run.lines, [
        '  ! pds.test (com.atproto.repo.putRecord) is rate limiting (429): waiting 2s, as it asks (Retry-After)',
        '  ! pds.test (com.atproto.repo.putRecord) is rate limiting (503): waiting 1s, as it asks (Retry-After)',
    ]);
});

test('a wait longer than allowed fails at once, saying until when; so does a server that never relents', async () => {
    const long = scripted(answer(429, { 'retry-after': '3600' }));
    await assert.rejects(patiently(long.send, URL_, { ...long.patience, maxWait: 60_000 }), (err: Error & { code?: string; status?: number }) =>
        err.code === 'ERR_BUNDLE_RATE_LIMITED' && err.status === 429
        && /asks to wait 60m, until \d{4}-\d\d-\d\dT.* longer than the 60s this waits/.test(err.message));
    assert.deepEqual(long.slept, [], 'nothing waited for');

    process.env['BUNDLE_RATE_LIMIT_WAIT'] = '7200';
    try {
        const allowed = scripted(answer(429, { 'retry-after': '3600' }));
        assert.equal((await patiently(allowed.send, URL_, allowed.patience)).status, 200, 'BUNDLE_RATE_LIMIT_WAIT allows more');
    } finally {
        delete process.env['BUNDLE_RATE_LIMIT_WAIT'];
    }

    const stubborn = scripted(...Array.from({ length: 10 }, () => answer(429, { 'retry-after': '1' })));
    await assert.rejects(patiently(stubborn.send, URL_, { ...stubborn.patience, retries: 3 }), /still rate limiting after 3 retries/);
    assert.equal(stubborn.sent(), 4);
});

test('a fetch can be made patient, and an abort ends its wait', async () => {
    const answers = [answer(429, { 'retry-after': '1' })];
    const seen: string[] = [];
    const fetch = patientFetch(async (input) => { seen.push(String(input)); return answers.shift() ?? answer(200); },
        { onWait: () => {}, sleep: async () => {} });
    assert.equal((await fetch(URL_)).status, 200);
    assert.deepEqual(seen, [URL_, URL_]);

    const controller = new AbortController();
    const waiting = patientFetch(async () => answer(429, { 'retry-after': '60' }), { onWait: () => controller.abort() })(URL_, { signal: controller.signal });
    await assert.rejects(waiting, { name: 'AbortError' });
});
