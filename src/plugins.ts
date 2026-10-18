import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import * as UTIL from 'node:util';
import * as THREADS from 'node:worker_threads';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scopeDir, pluginsDir, pluginFile, labelFile } from './scopes.ts';
import { readParts, pinsOf } from './parts.ts';
import { mountAt, mountNumber } from './mounts.ts';
import { sibling } from './preload.ts';
import type * as VerifierModule from './plugin-verifier.ts';
import type * as PinnedModule from './plugin-pinned.ts';

export { scopeDir, pluginsDir, pluginFile, labelFile };

// Plugins for bundled apps: signed bundles an app finds by package name.
//
//   import { use } from '@pipobscure/bundle/plugins';
//   use('bled');                                   // once per thread
//   const gpio = await import('@alice/bled-gpio'); // ordinary resolution
//
// A plugin is a bundle like any other, installed for one app with
// `bundle install --for bled …` into that app's scope: a directory of its own,
// never the PATH. `use()` makes a scope's plugins resolvable in the calling
// thread, through a module resolve hook that answers only what nothing else
// can — builtins and the app's own dependencies always come first, so a plugin
// can never stand in for them.
//
// Nothing here verifies anything unless asked. Plugins are checked when they
// are installed, as apps are, and checked again at load only when the host
// asks (`use(scope, { verify })`) or the process runs under a verifying
// runtime — `bundle run`, the `register` preload, a SEA — which asked for
// everything it mounts to be checked.
//
// The exception is a plugin the host pins by hash: one of the parts its
// package.json declares (see parts.ts), or one it names in `verify.pins`. A
// pin comes from the host's own archive, not from anyone's configuration, so
// it is always held to — the file must be those bytes, and is mounted through
// the provider that re-checks every member as it is read.
//
// This module ends up inside every host app's bundle, so it imports nothing
// heavy, and nothing that needs --experimental-vfs to load. The checking is
// `plugin-verifier.ts`: a verifying runtime's own, found on the global object,
// so the code and policy that checked the app check its plugins too; or, when
// there is none and the host asked, this package's, loaded only then — so
// `bundle create`'s observation records it only for a host that verifies.
// Pinned plugins need less, `plugin-pinned.ts`, loaded the first time one is
// mounted.
//
// See proposals/plugins.md.

/** What a host can ask of its plugins: each rule holds on top of the rest. */
export interface PluginRules {
    /** The sigstore identity plugins must be signed with. */
    identity?: string | undefined;
    /** The sigstore OIDC issuer plugins must be signed through. */
    issuer?: string | undefined;
    /** Attesters that must have vouched for each plugin, as `[kind@]did`. */
    attesters?: string[] | undefined;
    /** How many of them (default: all). */
    quorum?: number | undefined;
    /** DIDs whose bad verdict refuses a plugin. */
    block?: string[] | undefined;
    /** A certificate (PEM text, or a path to one) every plugin's chain must lead to. */
    ca?: string | undefined;
    /**
     * Plugins this host pins, by package name, to their whole-file hash
     * (`sha256:<hex>`): each must be installed and be exactly those bytes,
     * and needs no signature or attestation besides. On top of the parts the
     * host's package.json declares, which are pinned whether this says so or
     * not. The other rules here are for the plugins it does not name.
     */
    pins?: Record<string, string> | undefined;
}

export interface UseOptions {
    /**
     * Verify every plugin in the scope before `use()` returns: `true` under
     * what the runtime and the policy require, or rules of the host's own on
     * top of those. A verifying runtime verifies whether this is set or not,
     * and pinned plugins are checked against their pins either way.
     */
    verify?: boolean | PluginRules | undefined;
}

/** One plugin `use()` refused, and every reason why. */
export interface Refused {
    /** The name it was installed as. */
    name: string;
    /** The package name inside it. */
    package: string;
    file: string;
    reasons: string[];
}

/** A plugin in a scope, as `list()` tells a host about it. */
export interface PluginInfo {
    /**
     * What it was installed as — what `bundle install --for` was given, as
     * typed — or, for a part of the host or a plugin copied in by hand, its
     * package name. Only identifies: two plugins can share one.
     */
    name: string;
    /** The package name inside it: what to import. */
    package: string;
    /** Its archive; for a folder linked for development, the note naming the folder. */
    file: string;
    /** The folder it is loaded from, when it is linked for development. */
    link?: string | undefined;
    /** Its whole package.json, custom fields and entry points included. */
    manifest: PackageJson;
}

// The contract with plugin-verifier.ts, which a verifying runtime leaves on
// the global object for this module to find — perhaps a different release of
// this package than the copy inside the app's bundle, hence the version. `at`
// and `pin` came later: a verifier that does not know them mounts where it
// likes, which is caught, and judges a pinned plugin by its ordinary rules,
// which is stricter.
const VERIFIER = Symbol.for('@pipobscure/bundle.plugins.verifier');

interface Verifier {
    readonly version: 1;
    readonly enforcing: boolean;
    mountPlugin(file: string, request: {
        scope: string;
        rules?: PluginRules | undefined;
        at?: string | undefined;
        pin?: { hash: string; by: string } | undefined;
    }): { root: string };
}

export interface PackageJson {
    name?: unknown;
    main?: unknown;
    exports?: unknown;
    bin?: unknown;
    type?: unknown;
    [field: string]: unknown;
}

interface Plugin {
    /** The package name inside it: what apps import. */
    name: string;
    /** The name it was installed as — what `bundle install --for` was given — or its package name. */
    installed: string;
    file: string;
    manifest: PackageJson;
    /** Linked for development: the folder it is loaded from, as it is, never verified. */
    link?: string | undefined;
    /** Where it is mounted, once it is. */
    root?: string | undefined;
    /** The host module that first imported it: where its unresolved imports are resolved. */
    host?: string | undefined;
}

interface Scope {
    scope: string;
    dir: string;
    plugins: Map<string, Plugin>;
    /** The options it was used with, to tell a second `use()` apart. */
    options: string;
    /** What it was used with, for a worker to use it with too. */
    verify: boolean | PluginRules | undefined;
    /** The pins in force, the host's parts included, and who set each. */
    pins: Record<string, { hash: string; by: string }>;
}

// Per thread, as module hooks and mounts are; a worker started through
// `Worker` is set up with the same (see `enterWorker()`).
const scopes: Scope[] = [];
let hooked = false;

/**
 * Make one scope's plugins resolvable in this thread. `scope` is the app's
 * package name (`bled`, `@acme/editor`), whose plugins `bundle install --for`
 * put in a directory of its own; or an absolute path to a directory of plugins.
 *
 * Calling it again for a scope already in use does nothing — unless the
 * options differ, which is an error rather than a quiet choice between them.
 * With verification, or pins, every plugin that needs checking is checked
 * before this returns, and if any is refused none of them is loaded and this
 * throws, saying why for each.
 *
 * When the package that calls this is itself called `scope` and declares parts
 * in its package.json (`bundle.parts`), they are pinned: see parts.ts.
 */
export function use(scope: string, options: UseOptions = {}): void {
    const key = JSON.stringify(options.verify ?? false);
    const existing = scopes.find((each) => each.scope === scope);
    if (existing) {
        if (existing.options !== key) throw new Error(`use('${scope}') was already called in this thread, with other options`);
        return;
    }
    const prepared = prepare(scope, scopeDir(scope), options.verify, declaredPins(scope));
    settle([prepared], prepared.mounts);
}

// What `use()` decides before anything is mounted: the scope, indexed; how
// each plugin that is checked now is to be mounted; and what is refused
// already, without mounting anything.
interface Prepared {
    entry: Scope;
    mounts: { plugin: Plugin; mount: (at?: string) => string }[];
    refused: Refused[];
}

function prepare(scope: string, dir: string, verify: boolean | PluginRules | undefined, declared: Scope['pins']): Prepared {
    const plugins = index(dir);
    const runtime = verifierOnGlobal();
    const asked = verify || (runtime?.enforcing ? true : false);
    const rules = typeof verify === 'object' ? withoutPins(verify) : undefined;
    const pins: Scope['pins'] = { ...declared };
    const refused: Refused[] = [];
    const refuse = (plugin: Plugin | undefined, name: string, reason: string) => refused.push({
        name: plugin?.installed ?? name, package: name, file: plugin?.file ?? PATH.join(dir, pluginFile(name)), reasons: [reason],
    });
    for (const [name, hash] of Object.entries(typeof verify === 'object' ? verify.pins ?? {} : {})) {
        const other = pins[name];
        if (other && other.hash.toLowerCase() !== hash.toLowerCase()) {
            refuse(plugins.get(name), name, `pinned to ${hash} by this app's code, and to ${other.hash} by ${other.by}: both cannot hold`);
        }
        pins[name] = { hash, by: 'this app' };
    }
    for (const [name, { by }] of Object.entries(pins)) {
        if (!plugins.has(name)) refuse(undefined, name, `pinned by ${by}, and not installed in ${dir} — 'bundle update' the app that declares it`);
    }

    const mounts: Prepared['mounts'] = [];
    for (const plugin of plugins.values()) {
        const pin = pins[plugin.name];
        if (plugin.link !== undefined) {
            if (asked || pin) {
                refuse(plugin, plugin.name, pin
                    ? `linked for development, from ${plugin.link}, and pinned by ${pin.by}: a folder is not the bytes a pin names`
                    : `linked for development, from ${plugin.link}: a folder has no signature to check — run the app with plain node to load it`);
            }
            continue;
        }
        if (refused.some((each) => each.package === plugin.name)) continue;
        if (pin) {
            mounts.push({
                plugin,
                mount: (at) => (runtime?.enforcing
                    ? runtime.mountPlugin(plugin.file, { scope, rules, at, pin })
                    : pinned().mountPinned(plugin.file, pin.hash, { by: pin.by, at })).root,
            });
        } else if (asked) {
            mounts.push({ plugin, mount: (at) => (runtime ?? peer()).mountPlugin(plugin.file, { scope, rules, at }).root });
        }
    }
    return { entry: { scope, dir, plugins, options: JSON.stringify(verify ?? false), verify, pins }, mounts, refused };
}

/** One mount to make: a plugin, how, and where another thread has it. */
interface Step {
    plugin: Plugin;
    mount: (at?: string) => string;
    at?: string | undefined;
}

// Make the mounts, in the order given; then throw everything refused — for
// the first scope that has any — or put the scopes in use.
function settle(prepared: Prepared[], steps: Step[]): void {
    const failed = new Map(prepared.map((each) => [each.entry, [...each.refused]]));
    for (const { plugin, mount, at } of steps) {
        try {
            plugin.root = mount(at);
        } catch (err) {
            const reasons = (err as { reasons?: unknown }).reasons;
            const entry = prepared.find((each) => each.entry.plugins.get(plugin.name) === plugin)!.entry;
            failed.get(entry)!.push({ name: plugin.installed, package: plugin.name, file: plugin.file, reasons: Array.isArray(reasons) ? reasons.map(String) : [message(err)] });
        }
    }
    for (const [entry, refused] of failed) {
        if (!refused.length) continue;
        const total = entry.plugins.size + refused.filter((each) => !entry.plugins.has(each.package)).length;
        const lines = refused.flatMap(({ name, package: pkg, file, reasons }) => [
            `  ${name}${pkg === name ? '' : `, ${pkg},`} (${file}):`, ...reasons.map((reason) => `    ${reason}`),
        ]);
        throw Object.assign(new Error(
            `${refused.length} of ${total} plugin${total === 1 ? '' : 's'} for '${entry.scope}' ${refused.length === 1 ? 'was' : 'were'} refused, so none are loaded:\n${lines.join('\n')}`),
        { code: 'ERR_BUNDLE_UNTRUSTED', refused });
    }
    for (const { entry } of prepared) scopes.push(entry);
    hook();
}

function withoutPins(rules: PluginRules): PluginRules {
    const { pins: _, ...rest } = rules;
    return rest;
}

/**
 * The plugins installed in a scope, sorted by the name each was installed as,
 * then by package — so a host can tell its user what is installed, read what
 * its plugins say about themselves, and import each by `package`:
 *
 *   for (const plugin of list('bled')) console.log(`${plugin.name}: ${plugin.manifest.description}`);
 *   for (const plugin of list('bled')) await import(plugin.package);
 *
 * Nothing is verified, mounted or run to answer it.
 */
export function list(scope: string): PluginInfo[] {
    const used = scopes.find((each) => each.scope === scope);
    return [...(used?.plugins ?? index(scopeDir(scope))).values()]
        .map((plugin): PluginInfo => ({
            name: plugin.installed, package: plugin.name, file: plugin.file,
            ...(plugin.link !== undefined ? { link: plugin.link } : {}),
            manifest: structuredClone(plugin.manifest),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
}

/**
 * Run a plugin as the main program: what `ordner-suite run auth` does with
 * `runPlugin('@ordner.fyi/suite', '@ordner.fyi/auth', argv)`.
 *
 * The scope is used first, if it is not yet — so a host's parts are checked
 * against its pins, as `use()` always does. Then the plugin is mounted,
 * `process.argv` is made what `--vfs-load` would make it — the plugin's
 * archive at `argv[1]`, then `argv` — and its entry point is loaded: `main`,
 * else the `.` of its `exports`, else `index.js`; or, with `bin`, that entry
 * of its package.json's `bin`. A CommonJS entry is required, an ES module
 * imported, as node decides between them. What it does from there is its own
 * business, as it would be run by itself; this returns once it has loaded.
 *
 * Inside it, `import.meta.url` (and `__filename`) is the entry's place in the
 * plugin's mount, `file:///dev/null/vfs/<n>/…` — not the archive's path, which
 * is `process.argv[1]` — so `new URL('./x', import.meta.url)` finds the
 * plugin's own files, and a worker started from there finds them too.
 */
export async function runPlugin(scope: string, pkg: string, argv: string[] = [], { bin }: { bin?: string | undefined } = {}): Promise<void> {
    if (!scopes.some((each) => each.scope === scope)) {
        const prepared = prepare(scope, scopeDir(scope), undefined, declaredPins(scope));
        settle([prepared], prepared.mounts);
    }
    const plugin = scopes.find((each) => each.scope === scope)!.plugins.get(pkg);
    if (!plugin) throw Object.assign(new Error(`no plugin '${pkg}' is installed for ${scope} (${scopeDir(scope)})`), { code: 'ERR_MODULE_NOT_FOUND' });
    plugin.root ??= plugin.link !== undefined ? FS.realpathSync(plugin.link) : mountPlain(plugin);
    plugin.host ??= caller()?.url;
    const entry = entryOf(plugin, bin);
    process.argv = [process.argv[0]!, plugin.file, ...argv];
    if (entry.endsWith('.mjs') || (!entry.endsWith('.cjs') && plugin.manifest.type === 'module')) await import(pathToFileURL(entry).href);
    else createRequire(PATH.join(plugin.root, 'package.json'))(entry);
}

function entryOf(plugin: Plugin, bin: string | undefined): string {
    const { manifest } = plugin;
    if (bin !== undefined) {
        const unscoped = plugin.name.slice(plugin.name.lastIndexOf('/') + 1);
        const path = typeof manifest.bin === 'string' ? (bin === unscoped ? manifest.bin : undefined)
            : manifest.bin && typeof manifest.bin === 'object' ? (manifest.bin as Record<string, unknown>)[bin] : undefined;
        if (typeof path !== 'string') throw new Error(`the plugin ${plugin.name} has no bin '${bin}' (${plugin.file})`);
        return probe(plugin.root!, path, plugin.name);
    }
    if (typeof manifest.main === 'string') return probe(plugin.root!, manifest.main, plugin.name);
    if (manifest.exports !== undefined && manifest.exports !== null) return exported(plugin, '.', ['node', 'import']);
    return probe(plugin.root!, 'index.js', plugin.name);
}

// ------------------------------------------------------------------ the host ---

// The pins the host declares: the parts in the package.json of the package
// that called `use()` (or `runPlugin()`), when that package is the scope —
// the host using its own scope. Read from where the host is running from,
// its own archive, so the pins are what vouched for the host vouches for.
function declaredPins(scope: string): Scope['pins'] {
    const found = caller();
    if (!found?.manifest || found.manifest.name !== scope) return {};
    const parts = readParts(found.manifest, found.file);
    if (!parts) return {};
    const by = `${scope}'s parts (${found.file})`;
    return Object.fromEntries(Object.entries(pinsOf(parts)).map(([name, hash]) => [name, { hash, by }]));
}

// The first module on the stack outside this one, and the package.json
// nearest to it.
function caller(): { url: string; file: string; manifest?: PackageJson | undefined } | undefined {
    const own = new Set([import.meta.url, import.meta.filename]);
    for (const site of UTIL.getCallSites(16)) {
        const name = site.scriptName;
        if (!name || own.has(name) || name.startsWith('node:') || name.startsWith('data:')) continue;
        const path = name.startsWith('file:') ? fileURLToPath(name) : name;
        if (!PATH.isAbsolute(path)) continue;
        const url = pathToFileURL(path).href;
        for (let dir = PATH.dirname(path); ; dir = PATH.dirname(dir)) {
            const file = PATH.join(dir, 'package.json');
            try {
                return { url, file, manifest: JSON.parse(FS.readFileSync(file, 'utf-8')) as PackageJson };
            } catch (err) {
                if ((err as { code?: string }).code !== 'ENOENT' && (err as { code?: string }).code !== 'ENOTDIR') return { url, file };
            }
            if (PATH.dirname(dir) === dir) return { url, file };
        }
    }
    return undefined;
}

// ------------------------------------------------------------------ workers ---

/**
 * `Worker` from `node:worker_threads`, starting a thread that has this
 * thread's plugins: every scope `use()`d here is used there with the same
 * options, and every plugin mounted here is mounted there at the same place —
 * so a URL into a plugin means the same file in both threads, and a pinned or
 * verified plugin is checked there again before anything loads. Then the
 * worker's script runs, as it would have.
 *
 * Plugins get this one when they import `worker_threads`, so their own
 * `new Worker(new URL('./worker.js', import.meta.url))` works with nothing
 * to change. A host that wants its workers to have its plugins imports it
 * from here. A thread that has used no scope starts an ordinary worker, and
 * so does `{ eval: true }`, which node runs without the module loader.
 */
export class Worker extends THREADS.Worker {
    constructor(filename: string | URL, options?: THREADS.WorkerOptions) {
        super(...carried(filename, options));
    }
}

/** What a worker started through `Worker` is set up with: this thread's scopes and mounts. */
interface ThreadRecord {
    /** The worker's own script. */
    target: string;
    scopes: {
        scope: string;
        dir: string;
        verify: boolean | PluginRules | undefined;
        pins: Scope['pins'];
        mounts: { name: string; root: string; host?: string | undefined }[];
    }[];
}

function carried(filename: string | URL, options: THREADS.WorkerOptions | undefined): [string | URL, THREADS.WorkerOptions | undefined] {
    if (!scopes.length || options?.eval) return [filename, options];
    const target = filename instanceof URL ? filename : pathToFileURL(PATH.resolve(filename));
    if (target.protocol !== 'file:') return [filename, options];
    const record: ThreadRecord = {
        target: target.href,
        scopes: scopes.map(({ scope, dir, verify, pins, plugins }) => ({
            scope, dir, verify, pins,
            mounts: [...plugins.values()].flatMap((plugin) => (plugin.root !== undefined && plugin.link === undefined
                ? [{ name: plugin.name, root: plugin.root, host: plugin.host }] : [])),
        })),
    };
    const code = `import { enterWorker } from ${JSON.stringify(import.meta.url)};\nawait enterWorker(${JSON.stringify(record)});\n`;
    return [new URL(`data:text/javascript,${encodeURIComponent(code)}`), options];
}

/**
 * What a worker started through `Worker` runs first: its parent's scopes, its
 * parent's mounts at the same places — in the order they were made, the only
 * order node can give them — and then the worker's own script. Not for hosts
 * to call.
 */
export async function enterWorker(record: ThreadRecord): Promise<void> {
    const prepared = record.scopes.map((each) => prepare(each.scope, each.dir, each.verify, each.pins));
    const steps: Step[] = [];
    for (const [i, done] of prepared.entries()) {
        const checked = new Map(done.mounts.map((step) => [step.plugin, step]));
        for (const { name, root, host } of record.scopes[i]!.mounts) {
            const plugin = done.entry.plugins.get(name);
            if (!plugin) continue;
            plugin.host = host;
            steps.push({ plugin, mount: checked.get(plugin)?.mount ?? ((at) => mountPlain(plugin, at)), at: root });
            checked.delete(plugin);
        }
        // To be checked, and not mounted in the parent: checked here too, last.
        steps.push(...checked.values());
    }
    const order = (step: Step) => (step.at === undefined ? Infinity : mountNumber(step.at) ?? Infinity);
    settle(prepared, steps.sort((a, b) => order(a) - order(b)));
    await import(record.target);
}

// ------------------------------------------------------------------ indexing ---

// Every plugin in a scope, by its package name: archives (`*.nzip`) and
// folders linked for development (`*.link`, naming the folder), at the top and
// in `@scope/` directories, as node_modules lays scoped names out. Each is
// called what `bundle install` noted beside it, or — copied in by hand — its
// package name. Nothing is verified or run here; the package.json is read,
// and that is all.
function index(dir: string): Map<string, Plugin> {
    const plugins = new Map<string, Plugin>();
    const files: string[] = [];
    let entries: FS.Dirent[];
    try {
        entries = FS.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return plugins;
        throw err;
    }
    for (const entry of entries) {
        if (entry.isFile() && PLUGIN.test(entry.name)) files.push(PATH.join(dir, entry.name));
        if (entry.isDirectory() && entry.name.startsWith('@')) {
            for (const inner of FS.readdirSync(PATH.join(dir, entry.name), { withFileTypes: true })) {
                if (inner.isFile() && PLUGIN.test(inner.name)) files.push(PATH.join(dir, entry.name, inner.name));
            }
        }
    }
    for (const file of files.sort()) {
        const link = file.endsWith('.link') ? linked(file) : undefined;
        const manifest = link !== undefined ? readFolderManifest(file, link) : readManifest(file);
        if (typeof manifest.name !== 'string' || !manifest.name) throw new Error(`${file} is not a plugin: its package.json names no package`);
        const other = plugins.get(manifest.name);
        if (other) throw new Error(`two plugins in ${dir} are both '${manifest.name}': ${other.file} and ${file} — remove one`);
        const installed = labelOf(file) ?? manifest.name;
        plugins.set(manifest.name, { name: manifest.name, installed, file, manifest, link });
    }
    return plugins;
}

const PLUGIN = /\.(?:nzip|link)$/;

function linked(file: string): string {
    const folder = FS.readFileSync(file, 'utf-8').trim();
    if (!PATH.isAbsolute(folder)) throw new Error(`${file} does not name a folder to load a plugin from`);
    return folder;
}

function readFolderManifest(file: string, folder: string): PackageJson {
    try {
        return JSON.parse(FS.readFileSync(PATH.join(folder, 'package.json'), 'utf-8')) as PackageJson;
    } catch (err) {
        throw new Error(`${file} links ${folder}, which is not a plugin (${message(err)}) — link it again, or 'bundle uninstall' it`);
    }
}

function labelOf(file: string): string | undefined {
    try {
        return FS.readFileSync(labelFile(file), 'utf-8').trim() || undefined;
    } catch {
        return undefined;
    }
}

interface ZipFileLike {
    has(name: string): boolean;
    getSync(name: string): { contentSync(): Buffer };
    closeSync(): void;
}
interface ZipModule {
    ZipFile: { openSync(path: string): ZipFileLike };
}

function readManifest(file: string): PackageJson {
    let zip: ZipFileLike;
    try {
        zip = (ZLIB as unknown as ZipModule).ZipFile.openSync(file);
    } catch (err) {
        throw new Error(`${file} is not an archive (${message(err)})`);
    }
    try {
        if (!zip.has('package.json')) throw new Error(`${file} is not a plugin: it has no package.json`);
        return JSON.parse(zip.getSync('package.json').contentSync().toString('utf-8')) as PackageJson;
    } finally {
        zip.closeSync();
    }
}

// ----------------------------------------------------------------- mounting ---

interface VfsModule {
    create(...args: unknown[]): { mount(): string; unmount(): void };
    ZipProvider: new (archive: unknown) => unknown;
}

// A plugin nobody asked to verify, mounted as it is: what `bundle install`
// checked is what is there, and `bundle installed` checks that it still is.
function mountPlain(plugin: Plugin, at?: string): string {
    const VFS = process.getBuiltinModule('node:vfs') as unknown as VfsModule | undefined;
    if (!VFS) throw new Error(`plugins are mounted with node:vfs, which needs node to run with --experimental-vfs (loading ${plugin.name})`);
    const archive = (ZLIB as unknown as ZipModule).ZipFile.openSync(plugin.file);
    return mountAt(VFS, () => VFS.create(new VFS.ZipProvider(archive), { emitExperimentalWarning: false }), at);
}

// A pinned plugin, outside a verifying runtime: checked against its pin
// alone, which needs much less than the verifier — loaded now and not before.
function pinned(): typeof PinnedModule {
    try {
        return sibling<typeof PinnedModule>(import.meta.filename, 'plugin-pinned');
    } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' && /node:vfs/.test(message(err))) {
            throw new Error('loading pinned plugins needs node:vfs, which needs node to run with --experimental-vfs', { cause: err });
        }
        if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error("loading pinned plugins needs @pipobscure/bundle's plugin-pinned module, which this app's bundle does not carry: " +
                'record the bundle from a run that loads its parts, so that it does', { cause: err });
        }
        throw err;
    }
}

function verifierOnGlobal(): Verifier | undefined {
    const found = (globalThis as unknown as Record<symbol, Verifier | undefined>)[VERIFIER];
    return found?.version === 1 ? found : undefined;
}

// Not under a verifying runtime, and asked to verify: this package's own
// verifier, loaded now and not before.
function peer(): Verifier {
    try {
        return sibling<typeof VerifierModule>(import.meta.filename, 'plugin-verifier').pluginVerifier;
    } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' && /node:vfs/.test(message(err))) {
            throw new Error('verifying plugins needs node:vfs, which needs node to run with --experimental-vfs', { cause: err });
        }
        if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error("verifying plugins needs @pipobscure/bundle's verifier, which this app's bundle does not carry: " +
                'record the bundle from a run that verifies its plugins, so that it does', { cause: err });
        }
        throw err;
    }
}

// --------------------------------------------------------------- resolution ---

interface ResolveContext {
    parentURL?: string | undefined;
    conditions?: readonly string[] | undefined;
}
type NextResolve = (specifier: string, context?: ResolveContext) => { url: string };

const THREADS_MODULE = new URL(`./plugin-threads${import.meta.filename.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url).href;
let threadsThere: boolean | undefined;

function threadsModule(): boolean {
    return threadsThere ??= FS.existsSync(fileURLToPath(THREADS_MODULE));
}

function hook(): void {
    if (hooked) return;
    hooked = true;
    registerHooks({ resolve: resolve as never });
}

// Plugins come last: whatever resolves without them resolves as it always
// did. Only a bare name nothing else can find is looked for among them — first
// as the host that imported this plugin would see it (so a plugin reaches the
// host's API, as the same instance the host has), then in the scopes, in the
// order they were used.
function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): { url: string; shortCircuit?: boolean } {
    // A plugin's workers start with its plugins: see `Worker`. Only when the
    // stand-in is there: a host bundle recorded from a run in which no plugin
    // imported worker_threads does not carry it, and its plugins get node's.
    if ((specifier === 'node:worker_threads' || specifier === 'worker_threads') && owning(context.parentURL) && threadsModule()) {
        return { url: THREADS_MODULE, shortCircuit: true };
    }
    if (!bare(specifier)) return nextResolve(specifier, context);
    try {
        return nextResolve(specifier, context);
    } catch (err) {
        if (!notFound(err)) throw err;
        const owner = owning(context.parentURL);
        if (owner?.host) {
            try {
                return asHost(specifier, owner.host, context, nextResolve);
            } catch (again) {
                if (!notFound(again)) throw again;
            }
        }
        const name = packageOf(specifier);
        const plugin = find(name);
        if (!plugin) throw err;
        plugin.host ??= owner ? owner.host : context.parentURL;
        plugin.root ??= plugin.link !== undefined ? FS.realpathSync(plugin.link) : mountPlain(plugin);
        const target = exported(plugin, `.${specifier.slice(name.length)}`, context.conditions);
        return { url: pathToFileURL(target).href, shortCircuit: true };
    }
}

// Resolve as the host module at `host` would. `import` resolution follows the
// parent it is given; `require` resolution goes by the parent module's own
// search paths whatever URL it is handed, so it is asked through a require of
// the host's instead.
function asHost(specifier: string, host: string, context: ResolveContext, nextResolve: NextResolve): { url: string; shortCircuit?: boolean } {
    if (!context.conditions?.includes('require')) return nextResolve(specifier, { ...context, parentURL: host });
    return { url: pathToFileURL(createRequire(host).resolve(specifier)).href, shortCircuit: true };
}

function bare(specifier: string): boolean {
    return !/^(?:[./#]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(specifier);
}

function notFound(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

function packageOf(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function find(name: string): Plugin | undefined {
    for (const scope of scopes) {
        const plugin = scope.plugins.get(name);
        if (plugin) return plugin;
    }
    return undefined;
}

// The plugin whose mount `url` is inside, if any.
function owning(url: string | undefined): Plugin | undefined {
    if (!url) return undefined;
    for (const scope of scopes) {
        for (const plugin of scope.plugins.values()) {
            if (plugin.root && url.startsWith(`${pathToFileURL(plugin.root).href}/`)) return plugin;
        }
    }
    return undefined;
}

// A subpath of a plugin, as its package.json says: `exports` with the
// importer's conditions, or — for a package without `exports` — `main` and
// plain files, the way require has always found them.
function exported(plugin: Plugin, subpath: string, conditions: readonly string[] | undefined): string {
    const root = plugin.root!;
    const { exports } = plugin.manifest;
    if (exports === undefined || exports === null) {
        return probe(root, subpath === '.' ? (typeof plugin.manifest.main === 'string' ? plugin.manifest.main : 'index.js') : subpath, plugin.name);
    }
    const map = typeof exports === 'string' || Array.isArray(exports) || !Object.keys(exports as object).some((key) => key.startsWith('.'))
        ? { '.': exports }
        : exports as Record<string, unknown>;
    const wanted = new Set([...(conditions ?? ['node', 'import']), 'default']);
    const target = matchSubpath(map, subpath, wanted);
    if (target === null) {
        throw Object.assign(new Error(`'${subpath}' is not exported by the plugin ${plugin.name} (${plugin.file})`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    }
    return PATH.join(root, target);
}

function matchSubpath(map: Record<string, unknown>, subpath: string, conditions: Set<string>): string | null {
    if (Object.hasOwn(map, subpath) && !subpath.includes('*')) return targetOf(map[subpath], undefined, conditions);
    let best: string | undefined;
    for (const key of Object.keys(map)) {
        const star = key.indexOf('*');
        if (star < 0 || key.indexOf('*', star + 1) >= 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.length >= key.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)
            && (best === undefined || prefix.length > best.indexOf('*'))) best = key;
    }
    if (best === undefined) return null;
    const star = best.indexOf('*');
    return targetOf(map[best], subpath.slice(star, subpath.length - (best.length - star - 1)), conditions);
}

function targetOf(target: unknown, star: string | undefined, conditions: Set<string>): string | null {
    if (typeof target === 'string') {
        if (!target.startsWith('./')) return null;
        return star === undefined ? target : target.replaceAll('*', star);
    }
    if (Array.isArray(target)) {
        for (const each of target) {
            const found = targetOf(each, star, conditions);
            if (found !== null) return found;
        }
        return null;
    }
    if (target && typeof target === 'object') {
        for (const [condition, inner] of Object.entries(target)) {
            if (!conditions.has(condition)) continue;
            const found = targetOf(inner, star, conditions);
            if (found !== null) return found;
        }
    }
    return null;
}

function probe(root: string, path: string, name: string): string {
    const base = PATH.join(root, path);
    for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}.cjs`, `${base}.mjs`, PATH.join(base, 'index.js')]) {
        try {
            if (FS.statSync(candidate).isFile()) return candidate;
        } catch {
            // not this one
        }
    }
    throw Object.assign(new Error(`the plugin ${name} has no '${path}'`), { code: 'MODULE_NOT_FOUND' });
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
