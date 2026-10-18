import * as CRYPTO from 'node:crypto';
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { FLOOR, atLeast, windowsNode, type FoundNode } from './runtime.ts';
import { patientFetch } from './ratelimit.ts';

// Making sure there is a node to run bundles with, on a machine that may have
// none: what `bundle node install` does, and what Setup does before anything
// else.
//
// The order is the launcher's (`shell-base`), with one step added at the end:
//
//   1. a node new enough is already there — on PATH, or kept by a version
//      manager — and nothing happens;
//   2. a version manager is, and can be asked for one without changing which
//      node the person's shell runs: mise, fnm, nvm and asdf on unix,
//      nvm-windows, fnm and mise on Windows. Volta and n are left out on
//      purpose: installing through either makes the new node the default;
//   3. otherwise the official build from nodejs.org, checked against the
//      release's SHASUMS256.txt, of which only the `node` binary is kept, in
//      `nodesDir()` — a runtime for bundles, not a development toolchain: no
//      npm, nothing on the PATH, so it shadows no node anyone chose.
//
// Which release: the newest LTS at or above the minimum, else the newest
// release at or above it — the version chosen from nodejs.org's index either
// way, so a manager is asked for exactly the version a download would get.
//
// The checksum file comes from the same origin as the archive, so it proves
// the download whole, not who made it; SHASUMS256.txt.sig is OpenPGP, which
// node has no implementation of, and this package does not hand-roll one. TLS
// to nodejs.org is the trust here, as it is for every way of installing node.

/** Where nodejs.org keeps its releases: `BUNDLE_NODE_MIRROR` points it elsewhere. */
export function nodeMirror(env: NodeJS.ProcessEnv = process.env): string {
    return (env['BUNDLE_NODE_MIRROR'] || 'https://nodejs.org/dist').replace(/\/+$/, '');
}

/**
 * Where bundle keeps the nodes it downloads, one directory per version:
 * `BUNDLE_NODE_DIR`, else `bundle/node` in the data directory. The launcher
 * looks here too, by the same rule, so a node put here runs every bundle.
 */
export function nodesDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = OS.homedir()): string {
    const configured = env['BUNDLE_NODE_DIR'];
    if (configured) return PATH.resolve(configured);
    if (platform === 'win32') return PATH.win32.join(env['LOCALAPPDATA'] || PATH.win32.join(home, 'AppData', 'Local'), 'bundle', 'node');
    if (platform === 'darwin') return PATH.posix.join(home, 'Library', 'Application Support', 'bundle', 'node');
    return PATH.posix.join(env['XDG_DATA_HOME'] || PATH.posix.join(home, '.local', 'share'), 'bundle', 'node');
}

/** Where, inside a version's directory, its node is. */
export function nodeIn(dir: string, platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? PATH.win32.join(dir, 'node.exe') : PATH.posix.join(dir, 'bin', 'node');
}

/** One release, as nodejs.org's `index.json` lists it. */
export interface Release {
    version: string;
    lts: string | false;
    files: string[];
}

/** What to fetch of a release for one platform: its name in `files`, the archive, and the binary's member in it. */
export interface Build {
    key: string;
    archive: string;
    member: string;
}

/** The build of `version` for this platform and CPU, or undefined where nodejs.org has none. */
export function buildFor(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): Build | undefined {
    if (arch !== 'x64' && arch !== 'arm64') return undefined;
    if (platform === 'win32') {
        const base = `node-${version}-win-${arch}`;
        return { key: `win-${arch}-zip`, archive: `${base}.zip`, member: `${base}/node.exe` };
    }
    if (platform === 'darwin') {
        const base = `node-${version}-darwin-${arch}`;
        return { key: `osx-${arch}-tar`, archive: `${base}.tar.gz`, member: `${base}/bin/node` };
    }
    if (platform === 'linux') {
        const base = `node-${version}-linux-${arch}`;
        return { key: `linux-${arch}`, archive: `${base}.tar.gz`, member: `${base}/bin/node` };
    }
    return undefined;
}

/**
 * The release to install: the newest LTS at or above `minimum` that has a
 * build for this platform, else the newest release that does. Undefined when
 * none is new enough.
 */
export function chooseRelease(index: Release[], minimum: string = FLOOR, platform: NodeJS.Platform = process.platform, arch: string = process.arch): Release | undefined {
    const usable = index.filter((release) => {
        const build = buildFor(release.version, platform, arch);
        return build !== undefined && release.files.includes(build.key) && atLeast(release.version, minimum);
    });
    const newest = (releases: Release[]) => releases.reduce<Release | undefined>((best, each) => (best && atLeast(best.version, each.version) ? best : each), undefined);
    return newest(usable.filter((release) => release.lts)) ?? newest(usable);
}

/** A version run to say its version, or undefined when it does not. */
export type VersionOf = (node: string) => string | undefined;

function versionOf(node: string): string | undefined {
    if (node === process.execPath) return process.version;
    const res = spawnSync(node, ['--version'], { encoding: 'utf-8', timeout: 10_000, windowsHide: true });
    return res.status === 0 ? res.stdout.trim() : undefined;
}

/**
 * Every place the launcher looks for a node on macOS and Linux, after PATH:
 * each manager's directory of versions, and where in a version's directory
 * its node is. Kept in the launcher's order, and checked against it by the
 * tests, so the two cannot disagree about which node an app would run with.
 */
export function unixRoots(env: NodeJS.ProcessEnv = process.env, home = OS.homedir()): [string, string, string][] {
    const data = env['XDG_DATA_HOME'] || PATH.posix.join(home, '.local', 'share');
    return [
        ['nvm', PATH.posix.join(env['NVM_DIR'] || PATH.posix.join(home, '.nvm'), 'versions', 'node'), 'bin/node'],
        ['fnm', PATH.posix.join(env['FNM_DIR'] || PATH.posix.join(data, 'fnm'), 'node-versions'), 'installation/bin/node'],
        ['fnm', PATH.posix.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), 'installation/bin/node'],
        ['fnm', PATH.posix.join(home, '.fnm', 'node-versions'), 'installation/bin/node'],
        ['volta', PATH.posix.join(env['VOLTA_HOME'] || PATH.posix.join(home, '.volta'), 'tools', 'image', 'node'), 'bin/node'],
        ['asdf', PATH.posix.join(env['ASDF_DATA_DIR'] || PATH.posix.join(home, '.asdf'), 'installs', 'nodejs'), 'bin/node'],
        ['mise', PATH.posix.join(env['MISE_DATA_DIR'] || PATH.posix.join(data, 'mise'), 'installs', 'node'), 'bin/node'],
        ['n', PATH.posix.join(env['N_PREFIX'] || '/usr/local', 'n', 'versions', 'node'), 'bin/node'],
        ['bundle', env['BUNDLE_NODE_DIR'] ? PATH.resolve(env['BUNDLE_NODE_DIR']) : PATH.posix.join(data, 'bundle', 'node'), 'bin/node'],
        ['bundle', PATH.posix.join(home, 'Library', 'Application Support', 'bundle', 'node'), 'bin/node'],
    ];
}

/**
 * The node a bundle runs with here, at least `minimum`: on macOS and Linux
 * the one the launcher would pick, on Windows the one the association would
 * name, with the nodes bundle downloaded counted on both. Undefined when there
 * is none. `env`, `home`, `platform` and `run` are for tests.
 */
export function findNode({ minimum = FLOOR, env = process.env, home = OS.homedir(), platform = process.platform, run = versionOf }: {
    minimum?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    home?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    run?: VersionOf | undefined;
} = {}): FoundNode | undefined {
    const enough = (node: string, from: string): FoundNode | undefined => {
        const version = run(node);
        return version && atLeast(version, minimum) ? { path: node, version, from } : undefined;
    };
    if (platform === 'win32') {
        return windowsNode({ minimum, env, run });
    }
    const onPath = whereOnPath('node', env, platform);
    return (onPath && enough(onPath, 'PATH')) || newestIn(unixRoots(env, home), minimum, enough);
}

// The newest version, among the directories under each root, whose node is
// new enough — trusted for its directory's name only until it confirms it.
function newestIn(roots: [string, string, string][], minimum: string, enough: (node: string, from: string) => FoundNode | undefined): FoundNode | undefined {
    let best: { path: string; version: string; from: string } | undefined;
    for (const [from, root, tail] of roots) {
        let entries: string[];
        try {
            entries = FS.readdirSync(root);
        } catch {
            continue;
        }
        for (const version of entries) {
            const path = PATH.join(root, version, ...tail.split('/'));
            if (!atLeast(version, minimum) || !FS.existsSync(path)) continue;
            if (best && atLeast(best.version, version)) continue;
            best = { path, version, from };
        }
    }
    return best && enough(best.path, best.from);
}

function whereOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
    const delimiter = platform === 'win32' ? ';' : ':';
    for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(delimiter)) {
        if (!dir) continue;
        const candidate = PATH.join(dir, name);
        try {
            if (FS.statSync(candidate).isFile()) return candidate;
        } catch {
            // not here
        }
    }
    return undefined;
}

// ------------------------------------------------------- version managers ---

/** A version manager that can be asked for a node without making it the default. */
export interface Manager {
    name: string;
    /** The command that installs `version` (`v27.1.0`). */
    command(version: string): string[];
}

/**
 * The version managers here that bundle would ask, in the order it would ask
 * them. A manager is here when its command is on PATH — or, for nvm, which is
 * a shell function rather than a command, when its `nvm.sh` is where NVM_DIR
 * says. asdf only counts with its nodejs plugin added: adding plugins is the
 * person's business.
 */
export function managers({ env = process.env, home = OS.homedir(), platform = process.platform, has = (command: string) => whereOnPath(command, env, platform) !== undefined, asdfHasNode = defaultAsdfHasNode }: {
    env?: NodeJS.ProcessEnv | undefined;
    home?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    has?: ((command: string) => boolean) | undefined;
    asdfHasNode?: (() => boolean) | undefined;
} = {}): Manager[] {
    const found: Manager[] = [];
    const bare = (version: string) => version.replace(/^v/, '');
    if (platform === 'win32') {
        if (has('mise.exe')) found.push({ name: 'mise', command: (v) => ['mise.exe', 'install', `node@${bare(v)}`] });
        if (has('fnm.exe')) found.push({ name: 'fnm', command: (v) => ['fnm.exe', 'install', v] });
        if (has('nvm.exe')) found.push({ name: 'nvm-windows', command: (v) => ['nvm.exe', 'install', bare(v)] });
        return found;
    }
    if (has('mise')) found.push({ name: 'mise', command: (v) => ['mise', 'install', `node@${bare(v)}`] });
    if (has('fnm')) found.push({ name: 'fnm', command: (v) => ['fnm', 'install', v] });
    const nvm = PATH.posix.join(env['NVM_DIR'] || PATH.posix.join(home, '.nvm'), 'nvm.sh');
    // nvm.sh is sourced, then asked; the path and version go in as arguments, never into the script.
    if (FS.existsSync(nvm)) found.push({ name: 'nvm', command: (v) => ['sh', '-c', '. "$1" && nvm install "$2"', 'nvm', nvm, v] });
    if (has('asdf') && asdfHasNode()) found.push({ name: 'asdf', command: (v) => ['asdf', 'install', 'nodejs', bare(v)] });
    return found;
}

function defaultAsdfHasNode(): boolean {
    const res = spawnSync('asdf', ['plugin', 'list'], { encoding: 'utf-8', timeout: 30_000 });
    return res.status === 0 && /^nodejs$/m.test(res.stdout);
}

// ---------------------------------------------------------------- download ---

export interface EnsureOptions {
    /** The oldest node that will do (default: what --vfs-load needs). */
    minimum?: string | undefined;
    /**
     * How to get one when there is none: `auto` (a version manager, else a
     * download), `download` (never a manager), or one manager by name.
     */
    via?: string | undefined;
    log?: ((line: string) => void) | undefined;
    /** For tests: everything below. */
    fetch?: typeof globalThis.fetch | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    home?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    arch?: string | undefined;
    run?: VersionOf | undefined;
    managers?: readonly Manager[] | undefined;
    spawn?: ((command: string[]) => { status: number | null; error?: Error | undefined }) | undefined;
}

export interface Ensured {
    node: FoundNode;
    /** `found` (it was there), a manager's name, or `download`. */
    how: string;
}

/**
 * A node at least `minimum` to run bundles with: the one that is here, else
 * one installed by a version manager, else one downloaded into `nodesDir()`
 * (see the top of this file). Throws when none of that gets one.
 */
export async function ensureNode(options: EnsureOptions = {}): Promise<Ensured> {
    const { minimum = FLOOR, via = 'auto', log = () => {}, env = process.env, home = OS.homedir(), platform = process.platform, run } = options;
    const find = () => findNode({ minimum, env, home, platform, run });
    const here = find();
    if (here) return { node: here, how: 'found' };

    const release = await latestRelease(minimum, options);
    log(`* no node ${minimum} or newer here; the release to install is ${release.version}${release.lts ? ` (LTS ${release.lts})` : ''}`);

    const all = options.managers ?? managers({ env, home, platform });
    if (via !== 'download') {
        const candidates = via === 'auto' ? all : all.filter((manager) => manager.name === via);
        if (via !== 'auto' && !candidates.length) {
            throw new Error(`no version manager '${via}' here${all.length ? ` — there is ${all.map((manager) => manager.name).join(', ')}` : ''}; or leave it to bundle, with no --via`);
        }
        const spawn = options.spawn ?? ((command: string[]) => spawnSync(command[0]!, command.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], timeout: 15 * 60_000, windowsHide: true }));
        for (const manager of candidates) {
            log(`* asking ${manager.name} for node ${release.version}`);
            const res = spawn(manager.command(release.version));
            const installed = res.status === 0 ? find() : undefined;
            if (installed) return { node: installed, how: manager.name };
            log(`! ${manager.name} did not install it${res.error ? `: ${res.error.message}` : res.status !== 0 ? ` (exit ${res.status})` : ''}`);
        }
    }
    const node = await downloadNode(release, options);
    return { node, how: 'download' };
}

/** The release `ensureNode()` would install, from the mirror's `index.json`. */
export async function latestRelease(minimum: string = FLOOR, options: Pick<EnsureOptions, 'fetch' | 'env' | 'platform' | 'arch'> = {}): Promise<Release> {
    const { env = process.env, platform = process.platform, arch = process.arch } = options;
    const index = `${nodeMirror(env)}/index.json`;
    const response = await patientFetch(options.fetch)(index, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${index}: ${response.status} ${response.statusText}`);
    const releases = await response.json() as unknown;
    if (!Array.isArray(releases)) throw new Error(`${index}: not a list of releases`);
    const release = chooseRelease(releases.filter(isRelease), minimum, platform, arch);
    if (!release) throw new Error(`nodejs.org has no node ${minimum} or newer for ${platform}-${arch}`);
    return release;
}

function isRelease(value: unknown): value is Release {
    const release = value as Partial<Release> | null;
    return typeof release?.version === 'string' && /^v\d+\.\d+\.\d+$/.test(release.version) && Array.isArray(release.files)
        && (release.lts === false || typeof release.lts === 'string');
}

/**
 * Download `release`'s official build, check it against the release's
 * SHASUMS256.txt, and keep only its node binary, in `nodesDir()/<version>`.
 * It is assembled beside where it goes and renamed into place, so a version's
 * directory is either complete or absent; and the node it holds has to say it
 * is that version before it counts.
 */
export async function downloadNode(release: Release, options: EnsureOptions = {}): Promise<FoundNode> {
    const { log = () => {}, env = process.env, home = OS.homedir(), platform = process.platform, arch = process.arch, run = versionOf } = options;
    const build = buildFor(release.version, platform, arch);
    if (!build) throw new Error(`nodejs.org has no build of node for ${platform}-${arch}`);
    const fetch = patientFetch(options.fetch);
    const base = `${nodeMirror(env)}/${release.version}`;

    const sums = await fetch(`${base}/SHASUMS256.txt`, { redirect: 'follow' });
    if (!sums.ok) throw new Error(`${base}/SHASUMS256.txt: ${sums.status} ${sums.statusText}`);
    const expected = checksumOf(await sums.text(), build.archive);
    if (!expected) throw new Error(`${base}/SHASUMS256.txt does not list ${build.archive}`);

    log(`* downloading ${base}/${build.archive}`);
    const response = await fetch(`${base}/${build.archive}`, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${base}/${build.archive}: ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = CRYPTO.createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`${build.archive}: sha256 ${actual}, but SHASUMS256.txt says ${expected} — not installed`);

    const dir = PATH.join(nodesDir(env, platform, home), release.version);
    const staging = `${dir}.partial-${process.pid}`;
    FS.rmSync(staging, { recursive: true, force: true });
    FS.mkdirSync(staging, { recursive: true });
    try {
        const node = nodeIn(staging, platform);
        FS.mkdirSync(PATH.dirname(node), { recursive: true });
        FS.writeFileSync(node, extractMember(bytes, build, staging, platform), { mode: 0o755 });
        const said = run(node);
        if (said !== release.version) throw new Error(`the node in ${build.archive} says it is ${said ?? 'nothing'}, not ${release.version} — not installed`);
        FS.rmSync(dir, { recursive: true, force: true });
        FS.renameSync(staging, dir);
    } catch (err) {
        FS.rmSync(staging, { recursive: true, force: true });
        throw err;
    }
    const node = nodeIn(dir, platform);
    log(`* node ${release.version} is in ${dir}`);
    return { path: node, version: release.version, from: 'bundle' };
}

/** The sha256 SHASUMS256.txt gives `file`, or undefined when it gives none. */
export function checksumOf(sums: string, file: string): string | undefined {
    for (const line of sums.split('\n')) {
        const m = /^([0-9a-f]{64}) [ *]?(\S+)\s*$/.exec(line);
        if (m && m[2] === file) return m[1];
    }
    return undefined;
}

// The node binary, and only it, out of a release archive: on Windows from the
// zip, through node:zlib's reader; elsewhere from the tarball, through the
// system's tar, told the one member to extract. Either way the member is
// named exactly — nothing in the archive decides where anything is written.
function extractMember(bytes: Buffer, build: Build, scratch: string, platform: NodeJS.Platform): Buffer {
    if (platform === 'win32') {
        const zip = new ZLIB.ZipBuffer(bytes);
        if (!zip.has(build.member)) throw new Error(`${build.archive} has no ${build.member}`);
        const entry = zip.get(build.member);
        if (!entry.isFile) throw new Error(`${build.archive}: ${build.member} is not a file`);
        return entry.contentSync();
    }
    const archive = PATH.join(scratch, build.archive);
    const out = PATH.join(scratch, 'extract');
    FS.writeFileSync(archive, bytes);
    FS.mkdirSync(out);
    try {
        const res = spawnSync('tar', ['-xzf', archive, '-C', out, build.member], { encoding: 'utf-8', timeout: 5 * 60_000 });
        if (res.error) throw new Error(`tar: ${res.error.message}`);
        if (res.status !== 0) throw new Error(`${build.archive}: tar could not extract ${build.member}: ${res.stderr.trim()}`);
        const extracted = PATH.join(out, ...build.member.split('/'));
        if (!FS.lstatSync(extracted).isFile()) throw new Error(`${build.archive}: ${build.member} is not a file`);
        return FS.readFileSync(extracted);
    } finally {
        FS.rmSync(archive, { force: true });
        FS.rmSync(out, { recursive: true, force: true });
    }
}

/** The nodes bundle has downloaded, newest first. */
export function ownNodes(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = OS.homedir()): { version: string; path: string }[] {
    const dir = nodesDir(env, platform, home);
    let entries: string[];
    try {
        entries = FS.readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((version) => /^v\d+\.\d+\.\d+$/.test(version) && FS.existsSync(nodeIn(PATH.join(dir, version), platform)))
        .sort((a, b) => (atLeast(a, b) ? (a === b ? 0 : -1) : 1))
        .map((version) => ({ version, path: nodeIn(PATH.join(dir, version), platform) }));
}
