import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherPath } from './files.ts';

// Which node runs a bundle.
//
// A `#!` launcher (`shell-base`, what `bundle create --launcher` puts in front
// of an archive) runs the node on PATH when that is new enough for the app,
// and otherwise the newest one a version manager has installed — nvm, fnm,
// volta, asdf, mise, n — or says that there is none. The node on PATH is
// preferred whenever it will do: it is the one the person chose. The launcher
// is a POSIX shell script and does that itself; what is decided here is the
// minimum it is written with: the app's `engines.node`, and never below what
// `--vfs-load` needs.
//
// Windows runs no launcher: a `.nzip` opens through the file association that
// `bundle install` registers, which names one node for every archive. That
// node is chosen the same way — the one on PATH, then the one running the
// install, then a version manager's (nvm-windows, fnm, volta, mise) or one
// bundle downloaded (`bundle node install`) — by `windowsNode()`.

/** The oldest node that runs a bundle: --experimental-vfs with --vfs-load. */
export const FLOOR = '26.11.1';

/** A version as numbers: major, minor, patch, and 0 for a pre-release, else 1. */
type Parts = [number, number, number, number];

function parts(version: string): Parts | null {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[^+]*)?(?:\+.*)?$/.exec(version.trim());
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ? 0 : 1] : null;
}

/**
 * Whether `version` is at least `minimum`, as the launcher decides it: a
 * missing part is 0, and a pre-release comes before its release. A version
 * that is not one is never enough.
 */
export function atLeast(version: string, minimum: string): boolean {
    const a = parts(version);
    const b = parts(minimum);
    if (!a || !b) return false;
    for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
    return true;
}

/**
 * The lowest node version an `engines.node` range accepts, for a launcher to
 * check — never below `FLOOR`. Only the lower bound is checked: `upper` says
 * whether the range also has an upper one, which the launcher does not hold
 * to. Throws for a range it cannot read, rather than guess at a minimum.
 *
 *   ">=27.1.0" → 27.1.0     "^27" → 27.0.0 (upper)     "27.x || 28" → 27.0.0
 *   ">27.1.0"  → 27.1.1     ">27" → 28.0.0             "27.1 - 28" → 27.1.0 (upper)
 */
export function minimumNode(range: string | undefined): { minimum: string; upper: boolean } {
    let upper = false;
    // Each bound with its pre-release tag, if it has one, to say it as it was given.
    const lows: [Parts, string][] = [];
    const text = (range ?? '').trim();
    for (const alternative of (text || '*').split('||')) {
        // `>= 27` is `>=27`; `a - b` is from a, up to b.
        const spaced = alternative.trim().replace(/([<>=~^]+)\s+/g, '$1');
        const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(spaced);
        const comparators = hyphen ? [`>=${hyphen[1]}`] : spaced.split(/\s+/).filter(Boolean);
        if (hyphen) upper = true;
        let low: Parts = [0, 0, 0, 1];
        let tag = '';
        for (const comparator of comparators.length ? comparators : ['*']) {
            const m = /^(<=|>=|<|>|=|\^|~)?v?(\*|x|X|\d+)(?:\.(\*|x|X|\d+))?(?:\.(\*|x|X|\d+))?(-[0-9A-Za-z.-]+)?$/.exec(comparator);
            if (!m) throw new Error(`engines.node '${text}': cannot read '${comparator}'`);
            const [, op = '', ...given] = m;
            const numbers = given.slice(0, 3).map((part) => (part === undefined || /^[*xX]$/.test(part) ? undefined : Number(part)));
            const known = numbers.findIndex((part) => part === undefined);
            const count = known < 0 ? 3 : known;
            if (op === '<' || op === '<=') { upper = true; continue; }
            // ^ and ~ stop at the next major or minor, and a bare or = version at itself.
            if (op === '^' || op === '~' || ((op === '' || op === '=') && count > 0)) upper = true;
            let bound: Parts = [numbers[0] ?? 0, count > 1 ? numbers[1]! : 0, count > 2 ? numbers[2]! : 0, given[3] ? 0 : 1];
            if (op === '>') {
                // Past it: the next patch, or for a partial version the next of its last part.
                bound = count === 3 ? [bound[0], bound[1], bound[2] + 1, 1]
                    : count === 2 ? [bound[0], bound[1] + 1, 0, 1]
                    : count === 1 ? [bound[0] + 1, 0, 0, 1]
                    : bound;
            }
            if (compare(bound, low) > 0) {
                low = bound;
                tag = bound[3] ? '' : given[3]!;
            }
        }
        lows.push([low, tag]);
    }
    const [lowest, tag] = lows.reduce((a, b) => (compare(a[0], b[0]) <= 0 ? a : b));
    if (compare(lowest, parts(FLOOR)!) < 0) return { minimum: FLOOR, upper };
    return { minimum: `${lowest[0]}.${lowest[1]}.${lowest[2]}${tag}`, upper };
}

function compare(a: Parts, b: Parts): number {
    for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
}

/** The minimum an app's launcher checks: its package.json's `engines.node`, if it says. */
export function appMinimum(base: string): { minimum: string; upper: boolean; range?: string | undefined } {
    let range: string | undefined;
    try {
        const pkg = JSON.parse(FS.readFileSync(PATH.join(base, 'package.json'), 'utf-8')) as { engines?: { node?: unknown } };
        if (typeof pkg.engines?.node === 'string') range = pkg.engines.node;
    } catch {
        // No package.json, or none that says: the floor.
    }
    return { ...minimumNode(range), range };
}

/** The launcher, as it is shipped, with `minimum` as what it checks for. */
export function launcherText(minimum: string = FLOOR): string {
    if (!parts(minimum)) throw new Error(`'${minimum}' is not a node version`);
    // LF, whatever the checkout did: `#!/bin/sh\r` runs nowhere.
    const text = FS.readFileSync(launcherPath(), 'utf-8').replace(/\r\n/g, '\n');
    if (!/^need=\S+$/m.test(text)) throw new Error(`${launcherPath()} has no 'need=' line to set`);
    return text.replace(/^need=\S+$/m, `need=${minimum}`);
}

/**
 * The launcher for an app at `base`, written into a new temporary directory
 * as `shell-base`: what `bundle create --launcher` puts in front of it. The
 * caller removes `dir` once the archive is made.
 */
export function writeLauncher(base: string): { path: string; dir: string; minimum: string; upper: boolean; range?: string | undefined } {
    const wanted = appMinimum(base);
    const dir = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'bundle-launcher-'));
    const path = PATH.join(dir, 'shell-base');
    FS.writeFileSync(path, launcherText(wanted.minimum), { mode: 0o755 });
    return { path, dir, ...wanted };
}

// ------------------------------------------------------------------ Windows ---

/** A node, and its version. */
export interface FoundNode {
    path: string;
    version: string;
    /** Where it was found: `PATH`, `this process`, or a version manager. */
    from: string;
}

/**
 * The node a `.nzip` should open with on Windows, at least `minimum`: the one
 * on PATH when it is new enough, else the one running this, else the newest
 * a version manager has installed — nvm-windows, fnm, volta, mise — or bundle
 * has downloaded into its own directory (`nodesDir()` in nodes.ts). Undefined
 * when there is none. `env`, `execPath` and `run` are for tests.
 */
export function windowsNode({ minimum = FLOOR, env = process.env, execPath = process.execPath, run = versionOf }: {
    minimum?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    execPath?: string | undefined;
    run?: ((node: string) => string | undefined) | undefined;
} = {}): FoundNode | undefined {
    const enough = (node: string, from: string): FoundNode | undefined => {
        const version = run(node);
        return version && atLeast(version, minimum) ? { path: node, version, from } : undefined;
    };
    const onPath = whereOnPath('node.exe', env);
    const found = (onPath && enough(onPath, 'PATH')) || enough(execPath, 'this process');
    if (found) return found;

    const appData = env['APPDATA'] || PATH.join(env['USERPROFILE'] || OS.homedir(), 'AppData', 'Roaming');
    const localAppData = env['LOCALAPPDATA'] || PATH.join(env['USERPROFILE'] || OS.homedir(), 'AppData', 'Local');
    const managers: [string, string, string][] = [
        ['nvm-windows', env['NVM_HOME'] || PATH.join(appData, 'nvm'), 'node.exe'],
        ['fnm', PATH.join(env['FNM_DIR'] || PATH.join(appData, 'fnm'), 'node-versions'), PATH.join('installation', 'node.exe')],
        ['volta', PATH.join(env['VOLTA_HOME'] || PATH.join(localAppData, 'Volta'), 'tools', 'image', 'node'), 'node.exe'],
        ['mise', PATH.join(env['MISE_DATA_DIR'] || PATH.join(localAppData, 'mise'), 'installs', 'node'), 'node.exe'],
        // The nodes bundle downloads itself (nodes.ts), one directory per version.
        ['bundle', env['BUNDLE_NODE_DIR'] ? PATH.resolve(env['BUNDLE_NODE_DIR']) : PATH.join(localAppData, 'bundle', 'node'), 'node.exe'],
    ];
    let best: { path: string; version: string; from: string } | undefined;
    for (const [from, root, tail] of managers) {
        let entries: string[];
        try {
            entries = FS.readdirSync(root);
        } catch {
            continue;
        }
        for (const version of entries) {
            const path = PATH.join(root, version, tail);
            if (!atLeast(version, minimum) || !FS.existsSync(path)) continue;
            if (best && atLeast(best.version, version)) continue;
            best = { path, version, from };
        }
    }
    // The directory's name is the manager's word for it; the node itself confirms.
    return best && enough(best.path, best.from);
}

function whereOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
    for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(PATH.delimiter)) {
        if (!dir) continue;
        const candidate = PATH.join(dir, name);
        if (FS.existsSync(candidate)) return candidate;
    }
    return undefined;
}

function versionOf(node: string): string | undefined {
    if (node === process.execPath) return process.version;
    const res = spawnSync(node, ['--version'], { encoding: 'utf-8', timeout: 10_000, windowsHide: true });
    return res.status === 0 ? res.stdout.trim() : undefined;
}
