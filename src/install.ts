import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { verifyBundleSync } from './api.ts';
import { STATES, message, type VerificationResult } from './manifest.ts';

const require = createRequire(import.meta.url);

// Getting a signed archive onto your PATH, and keeping it current.
//
// This is `curl | sh` with the two things that make that pattern dangerous
// removed: nothing is executed to install it, and nothing lands on disk that
// did not verify first. The whole operation is download, check the signature,
// rename into place, remember where it came from.
//
//   bundle install https://example.com/tool.nzip
//   bundle update tool.nzip
//   bundle update
//
// **The first install decides who the publisher is.** Whatever identity signed
// the archive is written into the record, and every later update of that name
// must carry the same one. That is trust on first use — the same bargain SSH
// makes — and it is the honest description: the first fetch is the one you have
// to judge yourself, and `--identity` lets you say up front who you expect.
// Afterwards the record is doing the judging, and a publisher swapping identity
// is a refusal rather than a silent success.
//
// Updates are conditional requests. The record keeps the ETag the server gave,
// an update sends it back as `If-None-Match`, and a 304 means there is nothing
// to do — so `bundle update` over a dozen installs is a dozen cheap requests.

/**
 * Where this package's own release lives, and who is allowed to have signed it
 * — what `bundle install` with no URL fetches.
 *
 * It is a constant rather than something read out of `package.json`, because it
 * is a *trust* statement: the identity below is what makes a self-install
 * meaningful, and a value that could be edited by whatever is being installed
 * would not be worth checking. `BUNDLE_SELF_SOURCE` overrides the URL for a
 * mirror; the identity still has to match, unless `--identity` says otherwise.
 */
export const SELF = {
    url: 'https://github.com/pipobscure/bundles/releases/latest/download/bundle.run',
    identity: 'https://github.com/pipobscure/bundles/.github/workflows/publish.yml@refs/heads/main',
    issuer: 'https://token.actions.githubusercontent.com',
} as const;

/** The self-install target, with the environment's override applied. */
export function self(): { url: string; identity: string; issuer: string } {
    return { ...SELF, url: process.env['BUNDLE_SELF_SOURCE'] || SELF.url };
}

/** What an installed archive is, and where it came from. */
export interface InstallRecord {
    /** The file name it was installed as, which is the key in the record. */
    name: string;
    /** Where it was fetched from, and where an update refetches. */
    url: string;
    /** The server's ETag, for the conditional request an update makes. */
    etag?: string | undefined;
    /** `Last-Modified`, used when there is no ETag. */
    lastModified?: string | undefined;
    /** The sigstore identity that signed it, pinned for later updates. */
    identity?: string | undefined;
    /** The OIDC issuer that vouched for that identity. */
    issuer?: string | undefined;
    /** The certificate subject, for an archive signed against an ordinary CA. */
    subject?: string | undefined;
    /** sha256 of the file as installed. */
    sha256: string;
    /** When it was installed or last updated, ISO 8601. */
    at: string;
    /** Where it was installed to, so an update can find it again. */
    dir: string;
}

export interface InstallOptions {
    /** Where to install (default: `installDir()`). */
    dir?: string | undefined;
    /** Extra trusted roots, as PEM text or paths to PEM files. */
    roots?: string[] | undefined;
    /** Require this sigstore signing identity. */
    identity?: string | undefined;
    /** Require this sigstore OIDC issuer. */
    issuer?: string | undefined;
    /** Accept a good signature from a chain that is not anchored locally. */
    allowUntrusted?: boolean | undefined;
    /** Install under this name instead of the one the server suggests. */
    name?: string | undefined;
    /**
     * Register `.nzip` and extend PATHEXT on Windows (default: true, or false
     * when `BUNDLE_NO_WINDOWS_SETUP` is set). Turn it off when something else
     * owns the association — an installer, or a test suite, which has no
     * business rewriting the machine it runs on.
     */
    associate?: boolean | undefined;
    log?: ((line: string) => void) | undefined;
}

export interface UpdateResult {
    record: InstallRecord;
    /** What happened: the server had nothing new, or a new archive is in place. */
    state: 'unchanged' | 'updated';
    /** The sha256 that was replaced, when something was. */
    previous?: string | undefined;
}

/**
 * Where installed archives go: a directory this tool owns, which the user is
 * expected to have on their PATH. `BUNDLE_INSTALL_DIR` overrides it.
 *
 * Deliberately not "the first writable directory on PATH": guessing at
 * `/usr/local/bin` or at whatever a shell happens to list first is how install
 * scripts end up writing somewhere nobody expected.
 */
export function installDir(): string {
    const configured = process.env['BUNDLE_INSTALL_DIR'];
    if (configured) return PATH.resolve(configured);
    const home = OS.homedir();
    if (process.platform === 'win32') {
        const base = process.env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local');
        return PATH.join(base, 'bundle', 'bin');
    }
    return PATH.join(home, '.local', 'bin');
}

/** Where the record of what is installed lives. */
export function recordPath(): string {
    const home = OS.homedir();
    const base = process.platform === 'win32'
        ? PATH.join(process.env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local'), 'bundle', 'Data')
        : process.platform === 'darwin' ? PATH.join(home, 'Library', 'Application Support', 'bundle')
        : PATH.join(process.env['XDG_STATE_HOME'] || PATH.join(home, '.local', 'state'), 'bundle');
    return PATH.join(base, 'installed.json');
}

/** Everything installed, by name. */
export function records(): Record<string, InstallRecord> {
    try {
        const parsed = JSON.parse(FS.readFileSync(recordPath(), 'utf-8')) as { installs?: Record<string, InstallRecord> };
        return parsed.installs ?? {};
    } catch {
        return {};
    }
}

/**
 * Fetch `url`, verify what comes back, and put it on the PATH under the name
 * the server suggests — `Content-Disposition`, or the last segment of the URL.
 *
 * Nothing is written outside a temporary file until the signature checks out,
 * and the temporary file is removed if it does not.
 */
export async function install(url: string, options: InstallOptions = {}): Promise<InstallRecord> {
    const log = options.log ?? (() => {});
    const dir = options.dir ? PATH.resolve(options.dir) : installDir();

    log(`* fetching ${url}`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);

    const name = options.name ?? fileName(response, url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const record = await place(bytes, { name, dir, url, response, options, log });

    log(`* installed ${PATH.join(dir, name)}`);
    if (!onPath(dir)) {
        log(`! ${dir} is not on your PATH — add it, or set BUNDLE_INSTALL_DIR to somewhere that is`);
    }
    return record;
}

/**
 * Re-check what an installed archive came from, and replace it if the publisher
 * has published something new. With no name, every install.
 *
 * The identity recorded at install time is required again: an archive that now
 * verifies as somebody else is refused, and the installed copy is left alone.
 */
export async function update(name: string | undefined, options: InstallOptions = {}): Promise<UpdateResult[]> {
    const log = options.log ?? (() => {});
    const all = records();
    const names = name ? [name] : Object.keys(all).sort();
    if (name && !all[name]) throw new Error(`nothing installed as '${name}' — 'bundle install <url>' first`);
    if (!names.length) log('* nothing installed');

    const results: UpdateResult[] = [];
    for (const each of names) {
        const previous = all[each]!;
        log(`* ${each}: checking ${previous.url}`);

        const headers: Record<string, string> = {};
        if (previous.etag) headers['if-none-match'] = previous.etag;
        else if (previous.lastModified) headers['if-modified-since'] = previous.lastModified;

        const response = await fetch(previous.url, { headers, redirect: 'follow' });
        if (response.status === 304) {
            log(`  unchanged`);
            results.push({ record: previous, state: 'unchanged' });
            continue;
        }
        if (!response.ok) throw new Error(`${previous.url}: ${response.status} ${response.statusText}`);

        const bytes = Buffer.from(await response.arrayBuffer());
        // A server with no caching headers answers 200 to everything; compare
        // the bytes rather than reinstalling an identical archive.
        if (digest(bytes) === previous.sha256) {
            log(`  unchanged`);
            results.push({ record: remember({ ...previous, ...validators(response), at: previous.at }), state: 'unchanged' });
            continue;
        }

        const record = await place(bytes, {
            name: each,
            dir: previous.dir,
            url: previous.url,
            response,
            log,
            options: {
                ...options,
                // What signed it last time must sign it this time.
                identity: options.identity ?? previous.identity,
                issuer: options.issuer ?? previous.issuer,
            },
        });
        log(`  updated`);
        results.push({ record, state: 'updated', previous: previous.sha256 });
    }
    return results;
}

/** Forget an install, and remove the file it put on the PATH. */
export function uninstall(name: string): InstallRecord {
    const all = records();
    const record = all[name];
    if (!record) throw new Error(`nothing installed as '${name}'`);
    FS.rmSync(PATH.join(record.dir, name), { force: true });
    delete all[name];
    write(all);
    return record;
}

// ------------------------------------------------------------------ the act ---

// Verify, then move into place. The order is the whole point: an archive that
// does not verify never exists at its destination, not even briefly.
async function place(bytes: Buffer, { name, dir, url, response, options, log }: {
    name: string;
    dir: string;
    url: string;
    response: Response;
    options: InstallOptions;
    log: (line: string) => void;
}): Promise<InstallRecord> {
    const result = verifyBundleSync(bytes, {
        roots: options.roots ?? [],
        identity: options.identity,
        issuer: options.issuer,
    });
    const acceptable = result.state === 'valid'
        || (Boolean(options.allowUntrusted) && result.state === 'valid-untrusted');
    if (!acceptable) {
        throw Object.assign(new Error(`refusing to install ${url}: ${STATES[result.state].label} — ${result.reason}`),
            { code: 'ERR_BUNDLE_UNTRUSTED', state: result.state });
    }
    log(`  ${describe(result)}`);

    FS.mkdirSync(dir, { recursive: true });
    const target = PATH.join(dir, name);
    const temporary = `${target}.incoming-${process.pid}`;
    try {
        FS.writeFileSync(temporary, bytes, { mode: 0o755 });
        // Windows has no executable bit; what makes the file runnable there is
        // the .nzip association, which `ensureWindowsAssociation()` sets up.
        if (process.platform !== 'win32') FS.chmodSync(temporary, 0o755);
        FS.renameSync(temporary, target);
    } catch (err) {
        FS.rmSync(temporary, { force: true });
        throw err;
    }

    const associating = options.associate ?? !process.env['BUNDLE_NO_WINDOWS_SETUP'];
    if (process.platform === 'win32' && associating) {
        for (const line of ensureWindowsAssociation(name)) log(`  ${line}`);
    }

    return remember({
        name,
        url,
        ...validators(response),
        identity: result.identity,
        issuer: result.issuer,
        subject: result.subject,
        sha256: digest(bytes),
        at: new Date().toISOString(),
        dir,
    });
}

function validators(response: Response): { etag?: string | undefined; lastModified?: string | undefined } {
    return {
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
    };
}

function digest(bytes: Buffer): string {
    return CRYPTO.createHash('sha256').update(bytes).digest('hex');
}

function describe(result: VerificationResult): string {
    const who = result.identity
        ? `${result.identity}${result.issuer ? ` via ${result.issuer}` : ''}`
        : result.subject?.replace(/\n/g, ', ') ?? '(no identity)';
    return `${STATES[result.state].label} — signed by ${who}`;
}

function remember(record: InstallRecord): InstallRecord {
    const all = records();
    all[record.name] = record;
    write(all);
    return record;
}

function write(installs: Record<string, InstallRecord>): void {
    const path = recordPath();
    FS.mkdirSync(PATH.dirname(path), { recursive: true });
    const temporary = `${path}.incoming-${process.pid}`;
    FS.writeFileSync(temporary, `${JSON.stringify({ version: 1, installs }, null, 2)}\n`);
    FS.renameSync(temporary, path);
}

// ------------------------------------------------------------- the details ---

/**
 * What to call the file: the name the server asked for, or the last segment of
 * the URL. Either way it is reduced to a bare file name — a `Content-Disposition`
 * is a suggestion from someone else's server, and a suggestion that can contain
 * `../` is an arbitrary write.
 */
export function fileName(response: Response, url: string): string {
    const suggested = disposition(response.headers.get('content-disposition'));
    const fallback = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const chosen = safe(suggested) || safe(fallback);
    if (!chosen) throw new Error(`cannot tell what to call the file from ${url} — pass --name`);
    // On Windows the extension is what makes it runnable, through the .nzip
    // association; elsewhere the extension means nothing and is left alone.
    return process.platform === 'win32' && !/\.nzip$/i.test(chosen) ? `${chosen}.nzip` : chosen;
}

function disposition(header: string | null): string {
    if (!header) return '';
    const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(header);
    if (encoded?.[1]) {
        try {
            return decodeURIComponent(encoded[1].trim());
        } catch {
            // A malformed filename* is not a reason to fail; fall through to
            // the plain parameter, which is what a well-behaved server also sends.
        }
    }
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    return (plain?.[2] ?? plain?.[1] ?? '').trim();
}

function safe(name: string): string {
    const base = PATH.basename(name.replace(/\\/g, '/'));
    if (!base || base === '.' || base === '..') return '';
    // No separators, no NULs, nothing that reads as a drive or a switch.
    if (/[\0/\\:]/.test(base) || base.startsWith('-')) return '';
    return base;
}

function onPath(dir: string): boolean {
    const entries = (process.env['PATH'] ?? '').split(PATH.delimiter).filter(Boolean);
    const target = PATH.resolve(dir);
    return entries.some((entry) => {
        try {
            return PATH.resolve(entry) === target;
        } catch {
            return false;
        }
    });
}

/** The ProgID this tool registers `.nzip` against. */
const PROG_ID = 'NodeBundle';

/**
 * Make `.nzip` runnable for the current user on Windows: associate it with a
 * file type that runs node with the archive mounted, and put the extension on
 * PATHEXT so the name alone is enough.
 *
 * Everything here is per-user — HKCU and `HKCU\Environment`, never `/M` — so it
 * needs no administrator. A machine-wide association is an installer's job, and
 * the node installer is the right place for it. Both halves are idempotent:
 * what is already right is left alone, and what is missing is written.
 */
export function ensureWindowsAssociation(name = 'a bundle'): string[] {
    if (process.platform !== 'win32') return [];
    const notes = [...associate(), ...extendPathExt()];
    if (notes.length) notes.push(`${name} runs by name once a new terminal picks that up`);
    notes.push(...shadowed());
    return notes;
}

/**
 * The command a `.nzip` opens with.
 *
 * The obvious form — node with `--vfs-load="%1"` — is wrong in the case that
 * matters most. When cmd resolves a name through PATHEXT (you type `pnpm`, it
 * finds `pnpm.nzip`) the shell substitutes the name *as typed*, without the
 * extension, and node is handed a path that does not exist. When Explorer or
 * `start` opens the file instead, `%1` is the full name *with* it. Neither can
 * be assumed, so the command asks: if the path exists, mount it; if not, mount
 * it with `.nzip` on the end.
 *
 * It goes through `cmd /d /s /c` for that `if`: `/d` skips AutoRun commands
 * someone may have configured, and `/s` makes the quoting predictable — the
 * outer quotes are stripped and the rest is taken literally.
 */
function openCommand(): string {
    const node = `"${process.execPath}" --experimental-vfs`;
    return `cmd /d /s /c "if exist "%1" (${node} --vfs-load="%1" -- %~2) else (${node} --vfs-load="%1.nzip" -- %~2)"`;
}

// The association is two keys, and both have to be right: the extension has to
// name the ProgID, and the ProgID has to carry the command. Checking only the
// second would skip the write for a `.nzip` that some other tool has since
// claimed — a silent no-op where the user asked for an association.
function associate(): string[] {
    const command = openCommand();
    const notes: string[] = [];

    if (query('HKCU\\Software\\Classes\\.nzip', '') !== PROG_ID) {
        reg(['add', 'HKCU\\Software\\Classes\\.nzip', '/ve', '/d', PROG_ID, '/f']);
        notes.push(`associated .nzip with ${PROG_ID}, for this user`);
    }
    if (query(`HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '') !== command) {
        reg(['add', `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);
        notes.push(`${PROG_ID} now opens with this node (${process.execPath})`);
    }
    return notes;
}

/**
 * Add `.NZIP` to the user's PATHEXT.
 *
 * Deliberately *not* `setx PATHEXT "%PATHEXT%;.NZIP"` with the value from
 * `process.env`: that value is the machine's and the user's merged together, so
 * writing it back would freeze a copy of the machine's PATHEXT into this user's
 * environment and mask every later system-wide change to it. What goes in is
 * the user's own value with `.NZIP` appended — or, when the user has none, the
 * literal `%PATHEXT%;.NZIP` as `REG_EXPAND_SZ`, which resolves against whatever
 * the machine value is at the time a session starts.
 */
function extendPathExt(): string[] {
    if ((process.env['PATHEXT'] ?? '').split(';').some((ext) => ext.trim().toUpperCase() === '.NZIP')) return [];

    // Already written, just not visible in this process's environment yet —
    // that is a terminal that predates the install, not something to do again.
    const mine = query('HKCU\\Environment', 'PATHEXT');
    if (mine !== null && mine.split(';').some((ext) => ext.trim().toUpperCase() === '.NZIP')) return [];

    const value = mine === null ? '%PATHEXT%;.NZIP' : `${mine.replace(/;+$/, '')};.NZIP`;
    // REG_EXPAND_SZ so a `%PATHEXT%` in the value means what it says. `setx`
    // would write REG_SZ and truncate past 1024 characters; `reg add` does
    // neither, at the cost of no WM_SETTINGCHANGE broadcast — which `setx` only
    // does for already-running programs that listen for it anyway.
    try {
        reg(['add', 'HKCU\\Environment', '/v', 'PATHEXT', '/t', 'REG_EXPAND_SZ', '/d', value, '/f']);
    } catch (err) {
        return [`could not add .NZIP to PATHEXT: ${message(err)}`];
    }
    return ['added .NZIP to your PATHEXT', ...announce()];
}

/**
 * Tell the desktop the environment changed, which is what makes a new terminal
 * — or anything Explorer launches from now on — see the new PATHEXT without a
 * sign-out. `setx` does this; writing the registry directly does not, so this
 * does it by hand.
 *
 * It is a `WM_SETTINGCHANGE` broadcast with `lParam` pointing at the string
 * "Environment", through `SendMessageTimeoutW` — and `node:ffi` is how a
 * JavaScript program gets to call that at all. The timeout matters: a broadcast
 * is delivered to every top-level window, and one hung program would otherwise
 * hang the install, so it aborts on those and gives up after two seconds.
 *
 * A broadcast that fails is not an install that failed: it only means somebody
 * opens a new terminal instead.
 */
function announce(): string[] {
    const HWND_BROADCAST = 0xffffn;
    const WM_SETTINGCHANGE = 0x001a;
    const SMTO_ABORTIFHUNG = 0x0002;

    try {
        const { DynamicLibrary } = require('node:ffi') as typeof import('node:ffi');
        const user32 = new DynamicLibrary('user32.dll');
        try {
            const send = user32.getFunction('SendMessageTimeoutW', {
                arguments: ['pointer', 'uint32', 'pointer', 'pointer', 'uint32', 'uint32', 'pointer'],
                return: 'pointer',
            });
            // Wide, NUL-terminated: this is the W entry point.
            const subject = Buffer.from('Environment\0', 'utf16le');
            const answer = Buffer.alloc(8);
            send(HWND_BROADCAST, WM_SETTINGCHANGE, 0n, subject, SMTO_ABORTIFHUNG, 2000, answer);
            return ['told the desktop the environment changed — new terminals have it'];
        } finally {
            user32.close();
        }
    } catch (err) {
        return [`open a new terminal for it to take effect (could not broadcast: ${message(err)})`];
    }
}

// An association set through Explorer's "Open with" lives in UserChoice and
// takes precedence over everything written above. Nothing here can change that
// — Windows protects the key with a hash — so say so rather than reporting
// success for a write that will not take effect.
function shadowed(): string[] {
    const choice = query('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.nzip\\UserChoice', 'ProgId');
    if (choice === null || choice === PROG_ID) return [];
    return [
        `! .nzip is set to open with '${choice}' in your app defaults, which wins over this association`,
        `  change it in Settings > Apps > Default apps, or run archives as 'bundle run <file>'`,
    ];
}

function reg(args: string[]): void {
    const res = spawnSync('reg', args, { encoding: 'utf-8' });
    if (res.status !== 0) throw new Error(`reg ${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
}

/**
 * One registry value, or null when the key or the value is not there. `name` is
 * the value's name; the empty string asks for the key's default value.
 */
function query(key: string, name: string): string | null {
    const res = spawnSync('reg', ['query', key, ...(name ? ['/v', name] : ['/ve'])], { encoding: 'utf-8' });
    if (res.status !== 0) return null;
    return parseRegQuery(res.stdout ?? '', name);
}

/**
 * The one value `reg query` was asked for, out of what it printed.
 *
 * Its output is `    <name>    <TYPE>    <value>`, with the default value named
 * `(Default)`. A value can itself contain runs of spaces — a command line with
 * quoted paths usually does — so only the name and the type are matched, and
 * everything after the type is the value.
 *
 * Exported because this is the part of the Windows path that can be tested
 * anywhere; the `reg` call around it cannot.
 */
export function parseRegQuery(stdout: string, name: string): string | null {
    const wanted = name || '(Default)';
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s{4,}(\S(?:.*?\S)?)\s{4,}REG_(?:EXPAND_)?SZ\s{4,}(.*)$/.exec(line);
        if (match && match[1] === wanted) return (match[2] ?? '').trimEnd();
    }
    return null;
}

export { message };
