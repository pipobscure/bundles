import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { fileURLToPath } from 'node:url';

// Working out what belongs in an archive, for the cases where observing a run
// is not the right tool.
//
// `record` — run the application and write down what it read — is the primary
// answer and the honest one: it produces exactly the set that was used. It has
// one blind spot, and it is the one that matters for a *verifier*: code loaded
// lazily on a path the observation run never took. `sigstore.ts` requires
// `@sigstore/verify` only when it meets an archive with a `SIGSTORE=` field, so
// a build that signs with a local key never touches it — and the resulting
// bundle would then be unable to check a sigstore signature it later met.
//
// So the two are used together. A dependency closure computed from
// `node_modules` gives completeness, and the observation run is kept as the
// check: anything read that the computed list did not contain is a real gap,
// and the build says so.

export interface WalkOptions {
    /** Directory names skipped wherever they appear (default: ['node_modules']). */
    exclude?: string[] | undefined;
}

/**
 * Every file under `dir`, as `/`-separated paths relative to it, sorted.
 *
 * A nested `node_modules` is skipped by default: its contents belong to the
 * packages inside it, which `dependencyFiles` reaches through the dependency
 * graph instead — so a hoisted tree and a nested one produce the same set.
 */
export function walk(dir: string, { exclude = ['node_modules'] }: WalkOptions = {}, prefix = ''): string[] {
    const out: string[] = [];
    for (const entry of FS.readdirSync(dir, { withFileTypes: true })) {
        if (exclude.includes(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(PATH.join(dir, entry.name), { exclude }, relative));
        else if (entry.isFile()) out.push(relative);
    }
    return out.sort();
}

/**
 * Every file of `names` and of everything they depend on, as paths relative to
 * `base`, sorted. Packages are located the way node locates them, so the answer
 * describes the tree that is actually installed rather than what a lock file
 * says should be.
 *
 * A dependency that is not installed under `base` — missing, or hoisted above
 * it, where no member path can name it — is an error rather than a silent
 * omission, because a bundle whose closure is incomplete is a bundle that
 * fails at runtime on a machine other than the one that built it. Only an
 * optional dependency may be absent.
 */
export function dependencyFiles(names: string[], base: string): string[] {
    const root = PATH.resolve(base);
    const files: string[] = [];
    const seen = new Set<string>();
    // Each dependency is looked up from the package that depends on it, not from
    // the root: a tree can hold several versions of one package, and which one
    // a `require` gets depends on where it is asked from.
    const queue = names.map((name) => ({ name, from: root, optional: false }));

    while (queue.length) {
        const { name, from, optional } = queue.shift()!;
        const dir = locate(name, from, root);
        if (!dir) {
            if (optional) continue; // optional, and not installed
            throw new Error(`'${name}', needed by ${PATH.relative(root, from) || 'the root'}, is not installed ` +
                `under ${root} — a bundle without it fails wherever the code that needs it runs`);
        }
        if (seen.has(dir)) continue;
        seen.add(dir);

        const relative = PATH.relative(root, dir);
        for (const file of walk(dir)) files.push(posix(relative, file));

        const manifest = JSON.parse(FS.readFileSync(PATH.join(dir, 'package.json'), 'utf-8')) as {
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
        };
        const optionals = manifest.optionalDependencies ?? {};
        for (const dep of Object.keys(manifest.dependencies ?? {})) {
            queue.push({ name: dep, from: dir, optional: dep in optionals });
        }
        for (const dep of Object.keys(optionals)) queue.push({ name: dep, from: dir, optional: true });
    }
    return files.sort();
}

// Where `name` is installed as seen from `from`: the nearest `node_modules/name`
// on the way up, the search node's resolver makes. It looks for the directory
// rather than resolving `name/package.json`, because a package whose `exports`
// does not list its manifest would refuse that — and be mistaken for missing.
// The search stops at `root`: a package above it cannot become a member of an
// archive rooted there, so finding one is the same as not finding one.
function locate(name: string, from: string, root: string): string | null {
    for (let dir = from; ; dir = PATH.dirname(dir)) {
        if (PATH.basename(dir) !== 'node_modules') {
            const candidate = PATH.join(dir, 'node_modules', name);
            if (FS.existsSync(PATH.join(candidate, 'package.json'))) return candidate;
        }
        if (dir === root || PATH.dirname(dir) === dir) return null;
    }
}

export interface ModuleFilesOptions {
    /** Directory the result is relative to. */
    base: string;
    /** Individual files to include, relative to `base`. */
    files?: string[] | undefined;
    /** Directories to include whole, relative to `base`. */
    dirs?: string[] | undefined;
    /** Package names whose dependency closure to include. */
    dependencies?: string[] | undefined;
    /** Keep only files matching one of these; a bare extension counts. */
    filter?: ((name: string) => boolean) | undefined;
}

/** The three sources above, combined and de-duplicated. */
export function moduleFiles({ base, files = [], dirs = [], dependencies = [], filter }: ModuleFilesOptions): string[] {
    const all = [
        ...files,
        ...dirs.flatMap((dir) => walk(PATH.join(base, dir)).map((name) => posix(dir, name))),
        ...dependencyFiles(dependencies, base),
    ];
    const kept = filter ? all.filter(filter) : all;
    return [...new Set(kept)].sort();
}

/**
 * The shell launcher this package ships: the prefix that turns an archive into
 * a file you can run by name. `bundle sign --launcher` uses it, so nobody has
 * to know it lives inside `node_modules`.
 */
export function launcherPath(): string {
    return PATH.join(packageRoot(), 'shell-base');
}

/** This package's own root — the directory its `package.json` sits in. */
export function packageRoot(): string {
    return PATH.resolve(PATH.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The directory this package's runnable modules are in: `dist` once compiled,
 * `src` when the source is being run directly under node's type stripping.
 */
export function moduleDir(): string {
    return PATH.basename(PATH.dirname(fileURLToPath(import.meta.url)));
}

function posix(dir: string, name: string): string {
    return `${dir.split(PATH.sep).join('/')}/${name}`;
}
