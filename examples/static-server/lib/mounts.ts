import * as VFS from 'node:vfs';
import * as PATH from 'node:path';
import { ZipFile } from 'node:zlib';
import { statSync, type Stats } from 'node:fs';

// The mounted sources, and looking a request path up across them.
//
// The server mounts what it is told to serve *itself*, rather than leaning on
// node's own `--vfs-mount`, for two reasons:
//
//   * There is no API that enumerates the mounts node made. A mount lives at a
//     reserved path node assigns and nothing hands that path back, so an
//     application cannot discover a tree it did not mount.
//   * The launcher prefix this package writes ends in `--`, so everything after
//     the archive's own name is the program's argument. That is what makes
//     `./site.run docs/ manual.zip` work, and it stays true whatever node's own
//     flags do next.
//
// Nothing here calls `vfs.mount()`. Mounting puts a tree in the process's path
// namespace so `require()` and `fs` resolve inside it — which is what the entry
// point needed to run out of an archive, and exactly what a static server does
// not need. `vfs.create()` alone gives the `fs`-shaped surface, and the content
// stays out of a namespace it would otherwise share with the program.

export interface Mount {
    /** How the mount is named in listings and the `X-Served-By` header. */
    id: string;
    /** The absolute path of the directory or archive. */
    source: string;
    kind: 'directory' | 'archive';
    vfs: VFS.VirtualFileSystem;
}

export interface Entry {
    name: string;
    directory: boolean;
    size: number;
    mount: Mount;
}

/**
 * Mounts each source, in the order given: a directory through `RealFSProvider`,
 * anything else as a ZIP through `ZipProvider`. The kind comes from what the
 * source *is*, the same way `--vfs-mount` decides it, so an archive can be
 * called `site.zip`, `site.run`, or nothing in particular.
 */
export function mountAll(sources: string[]): Mount[] {
    const seen = new Set<string>();
    const mounts: Mount[] = [];
    for (const source of sources) {
        const resolved = PATH.resolve(source);
        // The same tree twice would shadow itself: every lookup would stop at
        // the first copy, and the listing would show it twice.
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        mounts.push(mountOne(resolved));
    }
    return mounts;
}

function mountOne(resolved: string): Mount {
    let stats: Stats;
    try {
        stats = statSync(resolved);
    } catch {
        throw new Error(`cannot serve ${resolved}: no such file or directory`);
    }

    const id = PATH.basename(resolved);
    if (stats.isDirectory()) {
        const vfs = VFS.create(new VFS.RealFSProvider(resolved), { emitExperimentalWarning: false });
        return { id, source: resolved, kind: 'directory', vfs };
    }

    try {
        const vfs = VFS.create(new VFS.ZipProvider(ZipFile.openSync(resolved)), { emitExperimentalWarning: false });
        return { id, source: resolved, kind: 'archive', vfs };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`cannot serve ${resolved}: not a directory, and not a ZIP archive (${reason})`);
    }
}

/**
 * The first mount that holds `path`, and what is there. Mount order is
 * precedence order, so an earlier source shadows a later one — the rule a
 * search path has, and the reason the listing shows the order.
 */
export function find(mounts: Mount[], path: string): { mount: Mount; stats: Stats } | null {
    const target = statable(path);
    for (const mount of mounts) {
        try {
            const stats = mount.vfs.statSync(target);
            if (stats.isFile() || stats.isDirectory()) return { mount, stats };
        } catch {
            // Not in this one. A missing entry is the ordinary case rather than
            // a failure worth reporting: that is what the next mount is for.
        }
    }
    return null;
}

/**
 * Every name directly under `path`, across all mounts, with the mount each came
 * from. Names are unique and the first mount that has one wins, matching
 * `find()` — so a listing shows what a request would actually get, not what
 * exists somewhere behind something else.
 */
export function list(mounts: Mount[], path: string): Entry[] {
    const byName = new Map<string, Entry>();
    const target = statable(path);
    for (const mount of mounts) {
        let names: string[];
        try {
            names = mount.vfs.readdirSync(target);
        } catch {
            continue;
        }
        for (const name of names) {
            if (byName.has(name)) continue;
            const child = target === '/' ? `/${name}` : `${target}/${name}`;
            try {
                const stats = mount.vfs.statSync(child);
                byName.set(name, { name, directory: stats.isDirectory(), size: stats.size, mount });
            } catch {
                // A name readdir reported but stat cannot see is not something
                // to serve, so leave it out rather than list a dead link.
            }
        }
    }
    return [...byName.values()].sort((a, b) => {
        if (a.directory !== b.directory) return a.directory ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

/**
 * The form a provider will stat: a directory is `/docs`, never `/docs/`. The
 * trailing slash matters to the *request* — it decides whether relative links on
 * the page resolve correctly — so it is carried through the URL handling and
 * dropped here, at the one place that talks to a file system.
 */
function statable(path: string): string {
    if (path === '/') return '/';
    return path.endsWith('/') ? path.slice(0, -1) : path;
}
