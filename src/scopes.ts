import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';

// Where plugins live: one directory per scope, a scope being the package name
// of the app the plugins are for. Kept on its own, with nothing but node's
// own modules, because the plugin loader needs it, and the loader ends up
// inside every host app's bundle.

/** A plugin scope: the package name of the app the plugins are for — `bled`, `@acme/editor`. */
export const SCOPE_PATTERN = '^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$';

/** Whether `name` can be a plugin scope. */
export function isScope(name: string): boolean {
    return name.length <= 214 && new RegExp(SCOPE_PATTERN).test(name);
}

/**
 * The one directory everything this process installs goes under, when there
 * is one: `BUNDLE_ROOT`. A server's layout — `bundle --system`, which sets it
 * to `systemRoot()` — or any other place an image build or a test wants it.
 * Under it, as under nothing else:
 *
 *   bin/       the commands (`BUNDLE_INSTALL_DIR` still overrides)
 *   apps/      the archives they run
 *   plugins/   one directory per scope
 *   state/     what is installed, the attestation cache, the listings index
 *   cache/     the sigstore trust root
 *
 * Without it, each of these is the user's, where the platform keeps such
 * things. Which policy files are read does not change: the machine's and the
 * user's, as always.
 */
export function bundleRoot(): string | undefined {
    const configured = process.env['BUNDLE_ROOT'];
    return configured ? PATH.resolve(configured) : undefined;
}

/**
 * The machine's root, which `--system` installs under: `BUNDLE_SYSTEM_ROOT`,
 * else `/var/lib/bundle`, `/Library/Application Support/bundle` on macOS, and
 * `%ProgramData%\bundle` on Windows — beside the machine's policy file there.
 */
export function systemRoot(): string {
    const configured = process.env['BUNDLE_SYSTEM_ROOT'];
    if (configured) return PATH.resolve(configured);
    if (process.platform === 'win32') return PATH.join(process.env['ProgramData'] || 'C:\\ProgramData', 'bundle');
    if (process.platform === 'darwin') return '/Library/Application Support/bundle';
    return '/var/lib/bundle';
}

/**
 * Where plugins are installed, one directory per scope: `BUNDLE_PLUGINS`, else
 * `plugins` under `BUNDLE_ROOT`, else `bundle/plugins` in the data directory.
 */
export function pluginsDir(): string {
    const configured = process.env['BUNDLE_PLUGINS'];
    if (configured) return PATH.resolve(configured);
    const root = bundleRoot();
    if (root) return PATH.join(root, 'plugins');
    return userPluginsDir();
}

function userPluginsDir(): string {
    const home = OS.homedir();
    if (process.platform === 'win32') return PATH.join(process.env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local'), 'bundle', 'plugins');
    if (process.platform === 'darwin') return PATH.join(home, 'Library', 'Application Support', 'bundle', 'plugins');
    return PATH.join(process.env['XDG_DATA_HOME'] || PATH.join(home, '.local', 'share'), 'bundle', 'plugins');
}

/**
 * The directory one scope's plugins are in. An absolute path is itself.
 *
 * A scope is found in one place, never merged from two: where `pluginsDir()`
 * says when that has the scope — or when `BUNDLE_PLUGINS` or `BUNDLE_ROOT`
 * says where to look — and otherwise the machine's (`systemRoot()`), when
 * the scope is there. So a service running as a user of its own loads what
 * `bundle --system` installed for it, with nothing to configure, and a user
 * who installs plugins for the same app has their own scope instead of the
 * machine's, never a mix of the two. `fallback: false` is where an install
 * puts it: this process's own place, always.
 */
export function scopeDir(scope: string, { fallback = true }: { fallback?: boolean | undefined } = {}): string {
    if (PATH.isAbsolute(scope)) return scope;
    if (!isScope(scope)) throw new Error(`'${scope}' is neither a package name nor an absolute path`);
    const parts = scope.split('/');
    const own = PATH.join(pluginsDir(), ...parts);
    if (!fallback || process.env['BUNDLE_PLUGINS'] || bundleRoot() || exists(own)) return own;
    const machine = PATH.join(systemRoot(), 'plugins', ...parts);
    return exists(machine) ? machine : own;
}

function exists(dir: string): boolean {
    try {
        return FS.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/** Where in its scope a plugin with this package name is stored: `@alice/bled-gpio.nzip`. */
export function pluginFile(name: string): string {
    return PATH.join(...`${name}.nzip`.split('/'));
}

/**
 * Where in its scope a plugin linked for development is noted: a text file
 * naming the folder it is loaded from, `@alice/bled-gpio.link`.
 */
export function linkFile(name: string): string {
    return PATH.join(...`${name}.link`.split('/'));
}

/**
 * Where the name a plugin was installed as is kept: beside its archive, as
 * text (`@alice/bled-gpio.nzip.name`), so the loader can say it without
 * reading the installer's records.
 */
export function labelFile(archive: string): string {
    return `${archive}.name`;
}
