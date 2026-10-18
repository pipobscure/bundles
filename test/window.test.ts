import test from 'node:test';
import assert from 'node:assert/strict';
import * as HTTP from 'node:http';
import { chromium, openWindow, shown, type DecisionWindow } from '../src/window.ts';
import type { Review } from '../src/review.ts';

// The window an install's decisions are made in: who may talk to it, what it
// shows, how an answer comes back — and that a question nobody can answer is
// declined. Everything over real HTTP, against the server itself; no browser.

const review: Review = {
    hashAlg: 'sha256', hash: 'ab'.repeat(32), signed: true, unmet: [], blocked: [], alarms: [], notes: ['a note'],
    decision: 'ask', reason: 'nobody accepted for it before vouches for it', state: 'valid',
    items: [
        { evidence: { type: 'signature', identity: 'https://github.com/alice/tool/.github/workflows/release.yml@refs/heads/main', issuer: 'https://token.actions.githubusercontent.com' } },
        { evidence: { type: 'attestation', did: 'did:plc:bad', verdict: 'bad', kind: 'malware' }, excluded: 'bad verdict' },
        { evidence: { type: 'attestation', did: 'did:plc:audit', handle: 'audit.example', verdict: 'good', kind: 'audited' }, known: 'trusted by policy' },
    ],
} as Review;

async function withWindow(run: (window: DecisionWindow, opened: string) => Promise<void>, grace?: number): Promise<void> {
    let opened = '';
    const window = await openWindow({ title: 'Install tool', open: (url) => { opened = url; }, grace });
    try {
        await run(window, opened);
    } finally {
        await window.close();
    }
}

/** A GET or POST with full control of the headers, which fetch does not give over Host. */
function request(url: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: HTTP.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = HTTP.request(url, { method, headers }, (res) => {
            let data = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** The events stream, read until `until` has seen what it wants; then the connection is dropped. */
async function events(url: string, until: (seen: { type: string; [key: string]: unknown }[]) => boolean): Promise<{ type: string; [key: string]: unknown }[]> {
    const controller = new AbortController();
    const res = await fetch(`${url}events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const seen: { type: string; [key: string]: unknown }[] = [];
    let buffered = '';
    try {
        while (!until(seen)) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += Buffer.from(value).toString('utf-8');
            let at: number;
            while ((at = buffered.indexOf('\n\n')) >= 0) {
                const chunk = buffered.slice(0, at);
                buffered = buffered.slice(at + 2);
                if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
            }
        }
    } finally {
        controller.abort();
    }
    return seen;
}

const answer = (url: string, body: unknown, origin = new URL(url).origin) =>
    request(`${url}answer`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the window is opened at a loopback URL with a token, and only that URL, at that host, answers', async () => {
    await withWindow(async (window, opened) => {
        assert.equal(opened, window.url);
        assert.match(window.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/$/);
        const page = await request(window.url);
        assert.equal(page.status, 200);
        assert.match(page.headers['content-security-policy'] as string, /^default-src 'none'; script-src 'nonce-[^']+'; style-src 'nonce-[^']+'; connect-src 'self'/);
        assert.match(page.body, /<script nonce="/);
        assert.doesNotMatch(page.body, /innerHTML/, 'text goes in as text');

        const { origin } = new URL(window.url);
        assert.equal((await request(`${origin}/${'x'.repeat(32)}/`)).status, 404, 'another token');
        assert.equal((await request(`${origin}/`)).status, 404);
        assert.equal((await request(window.url, { headers: { host: 'attacker.example' } })).status, 404, 'a name pointed at 127.0.0.1 is not this host');
    });
});

test('a question is asked through the page, and the ticked choices come back as the review\'s items', async () => {
    await withWindow(async (window) => {
        window.log('* fetching tool');
        window.review(review, { name: 'tool', url: 'https://example.com/tool.nzip' });
        const decided = window.decide(review, { name: 'tool', url: 'https://example.com/tool.nzip' });
        const seen = await events(window.url, (all) => all.some((event) => event.type === 'ask'));
        assert.deepEqual(seen.map((event) => event.type), ['title', 'log', 'review', 'ask']);
        const shownReview = seen[2] as unknown as { items: { choice?: number; label: string; lines: string[]; standing: string; tone: string }[] };
        assert.deepEqual(shownReview.items.map((item) => [item.choice, item.label, item.tone]), [[0, 'signed by', 'new'], [undefined, 'WARNING from', 'bad'], [1, 'attested by', 'known']]);
        assert.deepEqual(shownReview.items[0]!.lines, ['alice/tool via GitHub Actions', 'release.yml @ main']);
        const ask = seen[3] as unknown as { id: string; question: string; choices: unknown[] };
        assert.equal(ask.question, 'Install tool?');
        assert.equal(ask.choices.length, 2, 'what is excluded cannot be chosen');

        assert.equal((await answer(window.url, { id: ask.id, picked: [1] }, 'http://evil.example')).status, 403, 'not from its own page');
        assert.equal((await request(`${window.url}answer`, { method: 'POST', headers: { origin: new URL(window.url).origin, 'content-type': 'text/plain' }, body: '{}' })).status, 403, 'only JSON');
        assert.equal((await answer(window.url, { id: ask.id, picked: [2] })).status, 409, 'no such choice');
        assert.equal((await answer(window.url, { id: 'q99', picked: [] })).status, 409, 'no such question');
        assert.equal((await answer(window.url, { id: ask.id, picked: [1, 1] })).status, 204);
        assert.deepEqual(await decided, [review.items[2]]);
        assert.equal((await answer(window.url, { id: ask.id, picked: [0] })).status, 409, 'answered once');

        // A reload replays everything, the answer included.
        const again = await events(window.url, (all) => all.some((event) => event.type === 'answered'));
        assert.deepEqual(again.at(-1), { type: 'answered', id: ask.id, picked: [1] });
    });
});

test('a suite\'s offer is answered the same way, as who is accepted', async () => {
    await withWindow(async (window) => {
        const offer = {
            signers: [{ identity: 'https://github.com/a/b/.github/workflows/r.yml@refs/heads/main', issuer: 'https://token.actions.githubusercontent.com', members: ['at://did:plc:x/com.pipobscure.bundle.listing/one'] }],
            attesters: [{ did: 'did:plc:it', kind: 'permitted', members: ['at://did:plc:x/com.pipobscure.bundle.listing/one', 'at://did:plc:x/com.pipobscure.bundle.listing/two'] }],
        };
        const confirmed = window.confirm(offer, { name: 'devtools', source: 'at://…' });
        const ask = (await events(window.url, (all) => all.some((event) => event.type === 'ask'))).at(-1) as unknown as { id: string; choices: { detail: string }[] };
        assert.equal(ask.choices[1]!.detail, 'for one, two');
        await answer(window.url, { id: ask.id, picked: [1] });
        assert.deepEqual(await confirmed, { signers: [], certificates: [], attesters: ['did:plc:it'] });
    });
});

test('a question with no window to answer it is declined once the grace period is over', async () => {
    await withWindow(async (window) => {
        assert.deepEqual(await window.decide(review, { name: 'tool', url: 'u' }), [], 'nobody connected, ever');
        // A window that was open and is closed again is the same.
        const decided = window.decide(review, { name: 'tool', url: 'u' });
        await events(window.url, (all) => all.some((event) => event.type === 'ask'));
        assert.deepEqual(await decided, []);
    }, 50);
});

test('how it ended is the last thing the page is told', async () => {
    await withWindow(async (window) => {
        window.finish(true, 'tool installed', ['in ~/.local/bin']);
        const seen = await events(window.url, (all) => all.some((event) => event.type === 'done'));
        assert.deepEqual(seen.at(-1), { type: 'done', ok: true, text: 'tool installed', lines: ['in ~/.local/bin'] });
    });
});

test('shown marks what is known, what is new, and what cannot count', () => {
    assert.deepEqual(shown(review).map((item) => item.standing), ['new — not accepted before', 'marked it bad', 'trusted by policy']);
});

test('a Chromium browser is looked for where each installs itself, on each platform', () => {
    const only = (...paths: string[]) => (path: string) => paths.includes(path);
    assert.equal(chromium({ platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\PF86' }, exists: only('C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe') }), 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe');
    assert.equal(chromium({ platform: 'darwin', env: { HOME: '/Users/u' }, exists: only('/Users/u/Applications/Chromium.app/Contents/MacOS/Chromium') }), '/Users/u/Applications/Chromium.app/Contents/MacOS/Chromium');
    assert.equal(chromium({ platform: 'linux', env: { PATH: '/usr/bin:/snap/bin' }, exists: only('/snap/bin/chromium') }), '/snap/bin/chromium');
    assert.equal(chromium({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), undefined);
});
