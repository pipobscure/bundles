import { createRequire } from 'node:module';

// Shared plumbing for the two `-r` preloads.
//
// A preload has to load synchronously — `node -r` uses the CommonJS loader, and
// a module with a top-level `await` in it is rejected outright — so the sibling
// it pulls in is `require()`d rather than imported. That also puts the load
// inside a `try`, which is the point: both preloads want a missing `node:vfs`
// to be said in words rather than raised as a builtin-module error from deep
// inside node's startup.

const require = createRequire(import.meta.url);

/**
 * Load a sibling module of `from` by base name, with whichever extension the
 * caller is currently running as — `.ts` straight from source (node strips the
 * types), `.js` once compiled.
 */
export function sibling<T>(from: string, name: string): T {
    return require(`./${name}${from.endsWith('.ts') ? '.ts' : '.js'}`) as T;
}

/**
 * Run a preload's registration, translating the one failure worth explaining:
 * `node:vfs` only exists under `--experimental-vfs`, and without it every one
 * of these modules is unloadable for a reason the raw error does not make
 * obvious.
 */
export function preload(register: () => void): void {
    try {
        register();
    } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        const text = err instanceof Error ? err.message : String(err);
        if ((code === 'ERR_UNKNOWN_BUILTIN_MODULE' || code === 'MODULE_NOT_FOUND') && /node:vfs/.test(text)) {
            throw new Error('bundle: node:vfs is unavailable — run node with --experimental-vfs', { cause: err });
        }
        throw err;
    }
}
