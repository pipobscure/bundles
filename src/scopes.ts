import * as OS from 'node:os';
import * as PATH from 'node:path';

// Where plugins live: one directory per scope, a scope being the package name
// of the app the plugins are for. Kept on its own, with nothing but node:os
// and node:path, because the plugin loader needs it, and the loader ends up
// inside every host app's bundle.

/** A plugin scope: the package name of the app the plugins are for — `bled`, `@acme/editor`. */
export const SCOPE_PATTERN = '^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$';

/** Whether `name` can be a plugin scope. */
export function isScope(name: string): boolean {
    return name.length <= 214 && new RegExp(SCOPE_PATTERN).test(name);
}

/**
 * Where plugins are installed, one directory per scope: `BUNDLE_PLUGINS`, else
 * `bundle/plugins` in the data directory.
 */
export function pluginsDir(): string {
    const configured = process.env['BUNDLE_PLUGINS'];
    if (configured) return PATH.resolve(configured);
    const home = OS.homedir();
    if (process.platform === 'win32') return PATH.join(process.env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local'), 'bundle', 'plugins');
    if (process.platform === 'darwin') return PATH.join(home, 'Library', 'Application Support', 'bundle', 'plugins');
    return PATH.join(process.env['XDG_DATA_HOME'] || PATH.join(home, '.local', 'share'), 'bundle', 'plugins');
}

/** The directory one scope's plugins are installed in. An absolute path is itself. */
export function scopeDir(scope: string): string {
    if (PATH.isAbsolute(scope)) return scope;
    if (!isScope(scope)) throw new Error(`'${scope}' is neither a package name nor an absolute path`);
    return PATH.join(pluginsDir(), ...scope.split('/'));
}

/** Where in its scope a plugin with this package name is stored: `@alice/bled-gpio.nzip`. */
export function pluginFile(name: string): string {
    return PATH.join(...`${name}.nzip`.split('/'));
}
