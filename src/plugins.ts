import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { scopeDir, labelFile } from './scopes.ts';
import { sibling } from './preload.ts';
import type * as VerifierModule from './plugin-verifier.ts';

export { scopeDir };

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
// This module ends up inside every host app's bundle, so it imports nothing
// heavy, and nothing that needs --experimental-vfs to load. The checking is
// `plugin-verifier.ts`: a verifying runtime's own, found on the global object,
// so the code and policy that checked the app check its plugins too; or, when
// there is none and the host asked, this package's, loaded only then — so
// `bundle create`'s observation records it only for a host that verifies.
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
}

export interface UseOptions {
    /**
     * Verify every plugin in the scope before `use()` returns: `true` under
     * what the runtime and the policy require, or rules of the host's own on
     * top of those. A verifying runtime verifies whether this is set or not.
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

// The contract with plugin-verifier.ts, which a verifying runtime leaves on
// the global object for this module to find — perhaps a different release of
// this package than the copy inside the app's bundle, hence the version.
const VERIFIER = Symbol.for('@pipobscure/bundle.plugins.verifier');

interface Verifier {
    readonly version: 1;
    readonly enforcing: boolean;
    mountPlugin(file: string, request: { scope: string; rules?: PluginRules | undefined }): { root: string };
}

interface PackageJson {
    name?: unknown;
    main?: unknown;
    exports?: unknown;
    [field: string]: unknown;
}

/**
 * What `list()` says about a plugin: its `package.json`, reduced to what
 * describes it. `name` is what to import. What only matters for running it —
 * scripts, entry points, dependencies — is left out.
 */
export interface PluginPackage {
    name: string;
    version?: string | undefined;
    description?: string | undefined;
    keywords?: string[] | undefined;
    license?: string | undefined;
    author?: unknown;
    contributors?: unknown;
    maintainers?: unknown;
    homepage?: string | undefined;
    repository?: unknown;
    bugs?: unknown;
    funding?: unknown;
    engines?: Record<string, string> | undefined;
}

/** The `package.json` fields `list()` passes on: an allowlist, so nothing new leaks out when packages grow fields. */
export const PACKAGE_FIELDS = [
    'name', 'version', 'description', 'keywords', 'license', 'author', 'contributors', 'maintainers',
    'homepage', 'repository', 'bugs', 'funding', 'engines',
] as const;

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
}

// Per thread, as module hooks and mounts are: each worker calls `use()` itself.
const scopes: Scope[] = [];
let hooked = false;

/**
 * Make one scope's plugins resolvable in this thread. `scope` is the app's
 * package name (`bled`, `@acme/editor`), whose plugins `bundle install --for`
 * put in a directory of its own; or an absolute path to a directory of plugins.
 *
 * Calling it again for a scope already in use does nothing — unless the
 * options differ, which is an error rather than a quiet choice between them.
 * With verification, every plugin is checked before this returns, and if any
 * is refused none of them is loaded and this throws, saying why for each.
 */
export function use(scope: string, options: UseOptions = {}): void {
    const key = JSON.stringify(options.verify ?? false);
    const existing = scopes.find((each) => each.scope === scope);
    if (existing) {
        if (existing.options !== key) throw new Error(`use('${scope}') was already called in this thread, with other options`);
        return;
    }

    const dir = scopeDir(scope);
    const plugins = index(dir);
    const runtime = verifierOnGlobal();
    const verify = options.verify || (runtime?.enforcing ? true : false);
    if (verify) {
        const verifier = runtime ?? peer();
        const rules = typeof verify === 'object' ? verify : undefined;
        const refused: Refused[] = [];
        for (const plugin of plugins.values()) {
            if (plugin.link !== undefined) {
                refused.push({
                    name: plugin.installed, package: plugin.name, file: plugin.file,
                    reasons: [`linked for development, from ${plugin.link}: a folder has no signature to check — run the app with plain node to load it`],
                });
                continue;
            }
            try {
                plugin.root = verifier.mountPlugin(plugin.file, { scope, rules }).root;
            } catch (err) {
                const reasons = (err as { reasons?: unknown }).reasons;
                refused.push({
                    name: plugin.installed, package: plugin.name, file: plugin.file,
                    reasons: Array.isArray(reasons) ? reasons.map(String) : [message(err)],
                });
            }
        }
        if (refused.length) {
            const lines = refused.flatMap(({ name, package: pkg, file, reasons }) => [
                `  ${name}${pkg === name ? '' : `, ${pkg},`} (${file}):`, ...reasons.map((reason) => `    ${reason}`),
            ]);
            throw Object.assign(new Error(
                `${refused.length} of ${plugins.size} plugin${plugins.size === 1 ? '' : 's'} for '${scope}' ${refused.length === 1 ? 'was' : 'were'} refused, so none are loaded:\n${lines.join('\n')}`),
            { code: 'ERR_BUNDLE_UNTRUSTED', refused });
        }
    }

    scopes.push({ scope, dir, plugins, options: key });
    hook();
}

/**
 * The plugins installed in a scope, by the name each was installed as, with
 * what its `package.json` says about it — so a host can tell its user what is
 * installed, and import each by `package.name`:
 *
 *   for (const [name, pkg] of list('bled')) console.log(`${name}: ${pkg.description}`);
 *   for (const [, pkg] of list('bled')) await import(pkg.name);
 *
 * The name is what `bundle install --for` was given, as typed — a URL, a
 * domain or a listing — and only identifies it: two plugins may share one,
 * never a package name. Sorted by name, then package. Nothing is verified or
 * run to answer it.
 */
export function list(scope: string): [name: string, pkg: PluginPackage][] {
    const used = scopes.find((each) => each.scope === scope);
    return [...(used?.plugins ?? index(scopeDir(scope))).values()]
        .map((plugin): [string, PluginPackage] => [plugin.installed, describe(plugin.manifest)])
        .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

function describe(manifest: PackageJson): PluginPackage {
    const described: Record<string, unknown> = {};
    for (const field of PACKAGE_FIELDS) {
        if (manifest[field] !== undefined) described[field] = structuredClone(manifest[field]);
    }
    return described as unknown as PluginPackage;
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
    create(provider: unknown, options: { emitExperimentalWarning: boolean }): { mount(): string };
    ZipProvider: new (archive: unknown) => unknown;
}

// A plugin nobody asked to verify, mounted as it is: what `bundle install`
// checked is what is there, and `bundle installed` checks that it still is.
function mountPlain(plugin: Plugin): string {
    const VFS = process.getBuiltinModule('node:vfs') as unknown as VfsModule | undefined;
    if (!VFS) throw new Error(`plugins are mounted with node:vfs, which needs node to run with --experimental-vfs (loading ${plugin.name})`);
    const archive = (ZLIB as unknown as ZipModule).ZipFile.openSync(plugin.file);
    return VFS.create(new VFS.ZipProvider(archive), { emitExperimentalWarning: false }).mount();
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
