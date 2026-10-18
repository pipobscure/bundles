import * as CRYPTO from 'node:crypto';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import * as REVIEW from './review.ts';
import type { Offer } from './suite-install.ts';
import type { Accepted, Review, ReviewItem } from './review.ts';

// The decisions of an install, made in a window rather than at a terminal:
// what clicking an `nzip:` link opens, and what Setup shows. A person who
// never sees a terminal still gets every question a terminal would ask, with
// the same information, and answers it the same way.
//
// It is a page served by this process on 127.0.0.1, at a path holding a
// random token, opened in a Chromium browser's app window when there is one
// here (Edge always is, on Windows) and in the default browser otherwise.
// Nothing about the browser matters to what is decided: the page only shows
// what this process tells it and posts back which choices were ticked.
//
//   GET  /<token>/          the page
//   GET  /<token>/events    what to show, as server-sent events: everything
//                           so far on every connect, so a reload loses nothing
//   POST /<token>/answer    { id, picked: [indices] } for an open question
//
// The token is the whole of the access control, and the rest makes sure it
// stays that: the server listens on the loopback address only, answers only
// requests whose Host is that address and port — a page elsewhere that points
// a DNS name at 127.0.0.1 is refused — and takes answers only as JSON from
// its own origin. The page renders every string as text, never as HTML, and
// its Content-Security-Policy allows nothing but itself.
//
// A question nobody can answer is declined, never assumed: when the window
// has been closed — no page connected — for `grace` milliseconds, every open
// question is answered with nothing.

/** One thing that vouches, as the window shows it. */
export interface ShownItem {
    /** Where it can be chosen: its number among the choices; absent when it cannot. */
    choice?: number | undefined;
    /** `signed by`, `certificate`, `attested by`, `WARNING from`. */
    label: string;
    lines: string[];
    /** What is known of it: accepted before, trusted by policy, new, or why it does not count. */
    standing: string;
    tone: 'known' | 'new' | 'bad' | 'excluded';
}

type Event =
    | { type: 'title'; text: string }
    | { type: 'log'; text: string }
    | { type: 'review'; name: string; url: string; hash: string; signed: boolean; items: ShownItem[]; notes: string[] }
    | { type: 'ask'; id: string; question: string; reason: string; choices: { index: number; label: string; lines: string[]; detail?: string | undefined; tone?: ShownItem['tone'] | undefined }[]; accept: string; decline: string }
    | { type: 'answered'; id: string; picked: number[] }
    | { type: 'done'; ok: boolean; text: string; lines: string[] };

export interface WindowOptions {
    /** What the window is called, and says at the top. */
    title?: string | undefined;
    /**
     * How the page is opened, given its URL: by default in a Chromium app
     * window, else the default browser (`openPage()`). Tests pass their own.
     */
    open?: ((url: string) => void) | undefined;
    /** How long a closed window waits to be opened again before its questions are declined (default: 60s). */
    grace?: number | undefined;
}

/** A window an install's decisions are made in. */
export interface DecisionWindow {
    url: string;
    log(line: string): void;
    /** Show what a review found: `onReview`. */
    review(review: Review, about: { name: string; url: string }): void;
    /** Ask which of a review's items to accept: `decide`. None declines. */
    decide(review: Review, about: { name: string; url: string }): Promise<ReviewItem[]>;
    /** Ask whom, of everyone a suite expects, to accept for its members: `confirm`. */
    confirm(offer: Offer, about: { name: string; source: string }): Promise<Accepted>;
    /** Say how it ended. The page stays until it is closed, or `close()`. */
    finish(ok: boolean, text: string, lines?: string[] | undefined): void;
    /** Stop serving it. */
    close(): Promise<void>;
}

/** Open a window to make an install's decisions in. */
export async function openWindow(options: WindowOptions = {}): Promise<DecisionWindow> {
    const token = CRYPTO.randomBytes(24).toString('base64url');
    const nonce = CRYPTO.randomBytes(16).toString('base64');
    const grace = options.grace ?? 60_000;
    const events: Event[] = [{ type: 'title', text: options.title ?? 'bundle' }];
    const clients = new Set<ServerResponse>();
    const pending = new Map<string, { size: number; resolve: (picked: number[]) => void }>();
    let unwatched: NodeJS.Timeout | undefined;
    let next = 0;

    const emit = (event: Event) => {
        events.push(event);
        for (const client of clients) client.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // With questions open and nobody to see them, the clock runs; a page connecting stops it.
    const watch = () => {
        if (clients.size || !pending.size) {
            if (unwatched) clearTimeout(unwatched);
            unwatched = undefined;
            return;
        }
        unwatched ??= setTimeout(() => {
            unwatched = undefined;
            for (const [id, question] of pending) {
                pending.delete(id);
                emit({ type: 'answered', id, picked: [] });
                question.resolve([]);
            }
        }, grace);
        unwatched.unref?.();
    };

    const server: Server = createServer((req, res) => {
        handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const base = `/${token}/`;
    const url = `${origin}${base}`;

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = (req.url ?? '').split('?')[0]!;
        if (req.headers.host !== `127.0.0.1:${port}` || !path.startsWith('/') || !sameToken(path.slice(1, 1 + token.length), token) || path.slice(1 + token.length, 2 + token.length) !== '/') {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('not here');
            return;
        }
        const rest = path.slice(base.length);
        if (req.method === 'GET' && rest === '') {
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
                'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            }).end(page(nonce));
            return;
        }
        if (req.method === 'GET' && rest === 'events') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
            for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
            clients.add(res);
            watch();
            req.on('close', () => { clients.delete(res); watch(); });
            return;
        }
        if (req.method === 'POST' && rest === 'answer') {
            if (req.headers.origin !== origin || !/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
                res.writeHead(403).end();
                return;
            }
            const body = await read(req, 64 * 1024);
            let answer: { id?: unknown; picked?: unknown };
            try {
                answer = JSON.parse(body) as typeof answer;
            } catch {
                res.writeHead(400).end();
                return;
            }
            const question = typeof answer.id === 'string' ? pending.get(answer.id) : undefined;
            const picked = Array.isArray(answer.picked) ? answer.picked : undefined;
            if (!question || !picked || !picked.every((n) => Number.isInteger(n) && n >= 0 && n < question.size)) {
                res.writeHead(409).end();
                return;
            }
            const chosen = [...new Set(picked as number[])].sort((a, b) => a - b);
            pending.delete(answer.id as string);
            emit({ type: 'answered', id: answer.id as string, picked: chosen });
            watch();
            question.resolve(chosen);
            res.writeHead(204).end();
            return;
        }
        res.writeHead(404).end();
    }

    const ask = (question: string, reason: string, choices: Extract<Event, { type: 'ask' }>['choices'], accept: string, decline: string): Promise<number[]> => {
        const id = `q${++next}`;
        return new Promise((resolve) => {
            pending.set(id, { size: choices.length, resolve });
            emit({ type: 'ask', id, question, reason, choices, accept, decline });
            watch();
        });
    };

    (options.open ?? openPage)(url);

    return {
        url,
        log: (line) => emit({ type: 'log', text: line }),
        review: (review, about) => emit({ type: 'review', name: about.name, url: about.url, hash: `${review.hashAlg}:${review.hash}`, signed: review.signed, items: shown(review), notes: review.notes }),
        decide: async (review, about) => {
            const choices = REVIEW.selectable(review);
            const items = shown(review).filter((item) => item.choice !== undefined);
            const picked = await ask(`Install ${about.name}?`, review.reason,
                items.map((item, index) => ({ index, label: item.label, lines: item.lines, detail: item.standing, tone: item.tone })),
                'Accept the ticked ones and install', 'Decline');
            return picked.map((index) => choices[index]!);
        },
        confirm: async (offer, about) => {
            const lines = [
                ...offer.signers.map((each) => ({ kind: 'signer' as const, each, label: 'signed by', lines: signer(each.identity, each.issuer) })),
                ...offer.attesters.map((each) => ({ kind: 'attester' as const, each, label: 'attested by', lines: [`${each.did}${each.kind ? ` as ${each.kind}` : ''}`] })),
            ];
            const short = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
            const picked = await ask(`Suite ${about.name} expects its members to carry:`,
                'Accepting someone here accepts them for those members only. Anything not accepted is asked about member by member.',
                lines.map((line, index) => ({ index, label: line.label, lines: line.lines, detail: `for ${line.each.members.map(short).join(', ')}` })),
                'Accept the ticked ones', 'Decide each member on its own');
            const chosen = picked.map((index) => lines[index]!);
            return {
                signers: chosen.flatMap((line) => (line.kind === 'signer' ? [{ identity: (line.each as { identity: string }).identity, issuer: (line.each as { issuer: string }).issuer }] : [])),
                certificates: [],
                attesters: chosen.flatMap((line) => (line.kind === 'attester' ? [(line.each as { did: string }).did] : [])),
            };
        },
        finish: (ok, text, lines = []) => emit({ type: 'done', ok, text, lines }),
        close: async () => {
            if (unwatched) clearTimeout(unwatched);
            for (const client of clients) client.end();
            for (const [id, question] of pending) { pending.delete(id); question.resolve([]); }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function sameToken(given: string, token: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && CRYPTO.timingSafeEqual(a, b);
}

function read(req: IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

/** A review's items as the window shows them: what each is, what is known of it, and its number where it can be chosen. */
export function shown(review: Review): ShownItem[] {
    let choice = 0;
    return review.items.map((item) => {
        const evidence = item.evidence;
        const bad = evidence.type === 'attestation' && evidence.verdict === 'bad';
        const label = evidence.type === 'signature' ? 'signed by' : evidence.type === 'certificate' ? 'certificate' : bad ? 'WARNING from' : 'attested by';
        const lines = evidence.type === 'signature' ? signer(evidence.identity, evidence.issuer)
            : evidence.type === 'certificate' ? [...evidence.subject.split('\n'), ...(evidence.anchored ? [] : ['not anchored'])]
            : [`${evidence.handle ?? evidence.did}${evidence.kind ? ` as ${evidence.kind}` : ''}`, ...(evidence.handle ? [evidence.did] : []),
                ...(evidence.via ? [`via ${evidence.via}`] : []), ...(evidence.createdAt ? [`at ${evidence.createdAt}`] : [])];
        if (item.excluded) return { label, lines, standing: bad ? 'marked it bad' : item.excluded, tone: bad ? 'bad' as const : 'excluded' as const };
        return { choice: choice++, label, lines, standing: item.known ?? 'new — not accepted before', tone: item.known ? 'known' as const : 'new' as const };
    });
}

function signer(identity: string, issuer: string | undefined): string[] {
    const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/\.github\/workflows\/([^@]+)@(.+)$/.exec(identity);
    if (github && (!issuer || issuer === 'https://token.actions.githubusercontent.com')) {
        return [`${github[1]} via GitHub Actions`, `${github[2]} @ ${github[3]!.replace(/^refs\/(?:heads|tags)\//, '')}`];
    }
    return [identity, ...(issuer ? [`via ${issuer}`] : [])];
}

// ------------------------------------------------------------ the browser ---

/**
 * A Chromium browser here — Chrome, Edge, Chromium or Brave — whose `--app`
 * window shows a page as an application of its own: looked for where each
 * installs itself, never by asking anything to run. Undefined when there is
 * none. `env`, `platform` and `exists` are for tests.
 */
export function chromium({ env = process.env, platform = process.platform, exists = (path: string) => FS.existsSync(path) }: {
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
    exists?: ((path: string) => boolean) | undefined;
} = {}): string | undefined {
    const candidates: string[] = [];
    if (platform === 'win32') {
        const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].filter((root): root is string => Boolean(root));
        for (const root of roots) {
            candidates.push(
                PATH.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                PATH.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
                PATH.win32.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
                PATH.win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
            );
        }
    } else if (platform === 'darwin') {
        for (const root of ['/Applications', PATH.posix.join(env['HOME'] ?? '', 'Applications')]) {
            candidates.push(
                PATH.posix.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
                PATH.posix.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
                PATH.posix.join(root, 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
                PATH.posix.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
            );
        }
    } else {
        const dirs = (env['PATH'] ?? '').split(':').filter(Boolean);
        for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
            for (const dir of dirs) candidates.push(PATH.posix.join(dir, name));
        }
    }
    return candidates.find((candidate) => exists(candidate));
}

/**
 * Open `url` for a person: as a Chromium app window with a profile of its own
 * (so it is a window of its own, not a tab in their browser, and leaves their
 * profile alone), else in the default browser. A browser that does not start
 * is not an error: the URL is also said where the install says things.
 */
export function openPage(url: string, { profile }: { profile?: string | undefined } = {}): void {
    // As for signing in: no browser is started, and the URL that is said is the way in.
    if (process.env['BUNDLE_NO_BROWSER']) return;
    const browser = process.getuid?.() === 0 ? undefined : chromium();
    const quiet = { detached: true, stdio: 'ignore' as const, windowsHide: false };
    try {
        if (browser) {
            const args = [`--app=${url}`, '--no-first-run', '--no-default-browser-check', '--window-size=760,820'];
            if (profile) args.push(`--user-data-dir=${profile}`);
            spawn(browser, args, quiet).on('error', () => fallback(url)).unref();
            return;
        }
        fallback(url);
    } catch {
        // The URL is printed too; a browser that will not start is not the install failing.
    }
}

function fallback(url: string): void {
    const [command, ...args] = process.platform === 'darwin' ? ['open', url]
        : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url];
    try {
        spawn(command!, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } catch {
        // as above
    }
}

// ---------------------------------------------------------------- the page ---

// The page: nothing but this, its own script and style allowed. Everything it
// shows arrives as events and is put in with textContent.
function page(nonce: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bundle</title>
<style nonce="${nonce}">
:root { --bg: #f7f6f2; --card: #ffffff; --ink: #1d2320; --dim: #5d6862; --line: #dcded8; --accent: #2f7a4f; --accent-ink: #ffffff; --warn: #9a6a00; --bad: #b3261e; --new: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #151917; --card: #1e2421; --ink: #e6ebe7; --dim: #9aa69f; --line: #323b36; --accent: #5cb784; --accent-ink: #0d1510; --warn: #e0b04a; --bad: #f2867e; --new: #e0b04a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h1 .tree { margin-right: 6px; }
.sub { color: var(--dim); margin: 0 0 20px; word-break: break-all; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 16px; }
section h2 { font-size: 16px; margin: 0 0 8px; }
.item { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
.list .item:first-child { border-top: 0; }
.list { margin-top: 6px; }
.item input { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--accent); }
.label { color: var(--dim); font-size: 13px; }
.main-line { font-weight: 600; word-break: break-word; }
.line { color: var(--dim); font-size: 13px; word-break: break-all; }
.standing { font-size: 13px; margin-top: 2px; }
.known { color: var(--accent); } .new { color: var(--new); } .bad { color: var(--bad); font-weight: 600; } .excluded { color: var(--dim); }
.reason { margin: 0 0 8px; }
.note { color: var(--warn); font-size: 13px; }
.buttons { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
button { font: inherit; border-radius: 8px; padding: 9px 16px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
#log { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dim); white-space: pre-wrap; word-break: break-all; margin: 0; }
details summary { cursor: pointer; color: var(--dim); }
.done.ok h2 { color: var(--accent); } .done.failed h2 { color: var(--bad); }
.gone { color: var(--dim); }
</style>
</head>
<body>
<main>
<h1><span class="tree" aria-hidden="true">🌳</span><span id="title">bundle</span></h1>
<p class="sub" id="sub">Nothing is installed until you say so.</p>
<div id="content"></div>
<section><details id="log-box"><summary>What is happening</summary><pre id="log"></pre></details></section>
</main>
<script nonce="${nonce}">
(() => {
  const base = location.pathname;
  const content = document.getElementById('content');
  const log = document.getElementById('log');
  const sections = new Map();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const item = (label, lines, standing, tone) => {
    const box = el('div');
    box.append(el('div', 'label', label));
    lines.forEach((line, i) => box.append(el('div', i === 0 ? 'main-line' : 'line', line)));
    if (standing) box.append(el('div', 'standing ' + (tone || ''), standing));
    return box;
  };
  const show = (event) => {
    if (event.type === 'title') { document.getElementById('title').textContent = event.text; document.title = event.text; }
    else if (event.type === 'log') { log.textContent += event.text + '\\n'; }
    else if (event.type === 'review') {
      const s = el('section');
      s.append(el('h2', '', event.name), el('div', 'line', event.hash + (event.signed ? '' : ' — unsigned')));
      if (!event.items.length) s.append(el('p', 'note', 'Nothing vouches for it.'));
      const list = el('div', 'list');
      for (const each of event.items) { const row = el('div', 'item'); row.append(item(each.label, each.lines, each.standing, each.tone)); list.append(row); }
      s.append(list);
      for (const note of event.notes) s.append(el('p', 'note', note));
      content.append(s);
    } else if (event.type === 'ask') {
      const s = el('section');
      s.append(el('h2', '', event.question), el('p', 'reason', event.reason));
      const boxes = [];
      const list = el('div', 'list');
      for (const choice of event.choices) {
        const row = el('label', 'item');
        const box = el('input'); box.type = 'checkbox'; box.value = String(choice.index);
        boxes.push(box);
        row.append(box, item(choice.label, choice.lines, choice.detail, choice.tone || 'excluded'));
        list.append(row);
      }
      s.append(list);
      const buttons = el('div', 'buttons');
      const accept = el('button', 'primary', event.accept);
      const decline = el('button', '', event.decline);
      const send = async (picked) => {
        accept.disabled = decline.disabled = true;
        const res = await fetch(base + 'answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: event.id, picked }) });
        if (!res.ok) { accept.disabled = decline.disabled = false; }
      };
      accept.addEventListener('click', () => send(boxes.filter((b) => b.checked).map((b) => Number(b.value))));
      decline.addEventListener('click', () => send([]));
      buttons.append(accept, decline);
      s.append(buttons);
      sections.set(event.id, { s, boxes, accept, decline });
      content.append(s);
      s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (event.type === 'answered') {
      const q = sections.get(event.id);
      if (q) {
        q.boxes.forEach((b) => { b.checked = event.picked.includes(Number(b.value)); b.disabled = true; });
        q.accept.disabled = q.decline.disabled = true;
        q.s.append(el('p', 'gone', event.picked.length ? 'Answered.' : 'Declined.'));
      }
    } else if (event.type === 'done') {
      const s = el('section', 'done ' + (event.ok ? 'ok' : 'failed'));
      s.append(el('h2', '', event.text));
      for (const line of event.lines) s.append(el('div', 'line', line));
      s.append(el('p', 'gone', 'You can close this window.'));
      content.append(s);
      document.getElementById('sub').textContent = event.ok ? 'Done.' : 'Nothing more will happen here.';
      s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  let shownCount = 0;
  let seen = 0;
  const source = new EventSource(base + 'events');
  source.onmessage = (message) => {
    // A reconnect replays everything: skip what is already on the page.
    const index = seen++;
    if (index < shownCount) return;
    shownCount++;
    show(JSON.parse(message.data));
  };
  source.onopen = () => { seen = 0; };
})();
</script>
</body>
</html>
`;
}
