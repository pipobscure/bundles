import * as VFS from 'node:vfs';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { open as openBundle, type ProviderOptions } from './provider.ts';
import { message, signatureOf, verifySync, type VerificationResult } from './manifest.ts';

// Verifying a container, mounting it, and running what is inside — the one path
// every shape of this tool ends up taking, factored out of the SEA it used to
// live in.
//
// Three callers reach it, and the differences between them are smaller than
// they look:
//
//   * **A self-validating executable.** The archive is appended to the running
//     binary, so the container is `process.execPath` and the signature covers
//     the runtime and the verifier along with the application.
//   * **A verifying node.** The same binary with no archive appended: it takes
//     one on its command line, checks it, and runs it —
//     `node-verifying ./my-app.zip --some --app --args`. One runtime, any
//     number of applications, none of them trusted until they verify.
//   * **A library.** `run()` does the same thing in a process you already have.
//
// In every case the mount is the *verifying* provider rather than a plain
// `ZipProvider`, so this is not a signature check at startup and nothing more:
// every member is re-hashed against its signed digest as it is first read, for
// the whole life of the process.

/** What a caller can decide about a container before it is allowed to run. */
export interface LaunchOptions {
    /** Extra trusted roots, as PEM text or paths to PEM files. */
    roots?: string[] | undefined;
    /** Require this sigstore signing identity. */
    identity?: string | undefined;
    /** Require this sigstore OIDC issuer. */
    issuer?: string | undefined;
    /** Path to the sigstore trust root to check against. */
    trustedRoot?: string | undefined;
    /**
     * Run a container whose signature is good but whose chain is not anchored
     * in the trust store (default: false).
     */
    allowUntrusted?: boolean | undefined;
    /**
     * Recompute every member digest at mount rather than on first read
     * (default: false — reads check them anyway, and this is startup latency).
     */
    deep?: boolean | undefined;
    /** Entry point inside the archive, overriding its package.json `main`. */
    entry?: string | undefined;
    /**
     * What to do when the container does not verify. The default prints the
     * reason and exits 1; nothing from the archive has run at that point.
     */
    onRefuse?: ((reason: string) => void) | undefined;
}

/** Where a mounted container ended up, and what it is. */
export interface Mounted {
    /** The generated mount point the archive is visible at. */
    root: string;
    /** The mount, so a caller can unmount it. */
    vfs: VFS.VirtualFileSystem;
    /** The resolved entry point, as an absolute path under `root`. */
    entry: string;
}

/**
 * Verify `container` and mount it. Returns where it landed; nothing has been
 * executed out of it yet.
 */
export function mount(container: string, options: LaunchOptions = {}): Mounted {
    const settings: ProviderOptions = {
        roots: options.roots,
        identity: options.identity,
        issuer: options.issuer,
        trustedRoot: options.trustedRoot,
        allowUntrusted: options.allowUntrusted,
        deep: options.deep,
        name: 'bundle-launch',
    };

    let provider;
    try {
        provider = openBundle(container, settings);
    } catch (err) {
        refuse(options, message(err));
    }

    const vfs = VFS.create(provider, { emitExperimentalWarning: false });
    const root = vfs.mount();
    return { root, vfs, entry: entryPoint(root, options.entry) };
}

/**
 * Run what is at a mount's entry point. A CommonJS entry is `require()`d and an
 * ES module is `import()`ed, chosen the way node itself chooses — the archive's
 * `package.json` `type` and the entry's own extension.
 */
export async function start({ root, entry }: Mounted): Promise<void> {
    if (isModule(root, entry)) await import(pathToFileURL(entry).href);
    else createRequire(PATH.join(root, 'package.json'))(entry);
}

/** Verify a container, mount it, and run the application inside. */
export async function run(container: string, options: LaunchOptions = {}): Promise<void> {
    await start(mount(container, options));
}

/**
 * Verify the running executable and run the archive appended to it — the
 * self-validating shape, where the signature covers the runtime, the verifier
 * and the application as one file.
 */
export async function runSelf(options: LaunchOptions = {}): Promise<void> {
    await run(process.execPath, options);
}

/** Verify a container without mounting or running it. */
export function verify(container: string, options: LaunchOptions = {}): VerificationResult {
    const roots = (options.roots ?? []).map((root) => (root.includes('-----BEGIN') ? root : FS.readFileSync(root, 'utf-8')));
    return verifySync(container, {
        extraRoots: roots, deep: options.deep ?? false,
        identity: options.identity, issuer: options.issuer, trustedRoot: options.trustedRoot,
    });
}

/**
 * What, if anything, is appended to a container.
 *
 * This is how one binary can be both shapes: an executable with a signed
 * archive behind it runs *that*, and the same executable with nothing appended
 * takes an archive from its command line instead. The discriminator is the
 * signature marker rather than the presence of a ZIP, because a SEA carries an
 * archive of its own inside its blob — one that is not at the tail, and never
 * carries a marker.
 */
export function appended(container: string): 'signed' | 'unsigned' | 'none' {
    if (signatureOf(container) !== null) return 'signed';
    try {
        // An archive at the tail with no marker is the one case worth naming:
        // somebody appended an application and never signed it.
        ZLIB.ZipFile.openSync(container).closeSync();
        return 'unsigned';
    } catch {
        return 'none';
    }
}

// --------------------------------------------------------- the command line ---

/**
 * The command line of a verifying node.
 *
 * Options are read up to the first non-option argument, which is the archive;
 * everything after it belongs to the application, untouched. That is the shape
 * of every command that wraps another one — `env`, `nice`, `time` — and it is
 * what lets an application have flags of its own that collide with these.
 */
export const USAGE = `usage: <runtime> [options] <archive> [args...]

Verifies an archive and runs the application inside it. Nothing from the archive
runs until its signature, its certificate chain and its member digests check out,
and every member is re-hashed as it is read for the life of the process.

options:
  -r, --root <file>     extra trusted root certificate (PEM); repeatable
      --identity <san>  require this sigstore signing identity
      --issuer <url>    require this sigstore OIDC issuer
      --untrusted       run an archive whose signature is good but unanchored
      --deep            check every member digest at mount, not on first read
      --entry <path>    entry point inside the archive, overriding its main
      --verify          report the archive's trust state and stop
  -h, --help            this
      --version         the verifier's version, and the runtime's

The same policy can come from the environment — BUNDLE_ROOTS, BUNDLE_IDENTITY,
BUNDLE_ISSUER, BUNDLE_SIGSTORE_ROOT, BUNDLE_ALLOW_UNTRUSTED — which is what a
container built with no policy of its own falls back to.
`;

/** Options baked into a runtime at build time, and whether they are the last word. */
export interface Baked extends LaunchOptions {
    /**
     * A runtime built with a policy of its own accepts no policy from its
     * command line: a binary that demands a signing identity is not one whose
     * user can ask it to stop. Adding a root, requiring a different identity
     * and `--untrusted` are all refused. What remains — `--entry`, `--verify`,
     * `--help` — cannot loosen anything.
     */
    sealed?: boolean | undefined;
}

/**
 * Run a verifying node's command line. Returns the exit code; the application's
 * own exit code is its business, set the ordinary way from inside it.
 */
export async function main(argv: string[], baked: Baked = {}): Promise<number> {
    const flags: LaunchOptions & { roots: string[] } = { roots: [...(baked.roots ?? [])] };
    let verifyOnly = false;
    let i = 0;

    const sealedRefusal = (flag: string): number => {
        process.stderr.write(`${flag} is not accepted: this runtime was built with a policy of its own\n`);
        return 64;
    };

    for (; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--') { i++; break; }
        if (!arg.startsWith('-') || arg === '-') break;

        // `--flag=value` and `--flag value` both, because both are written.
        const eq = arg.indexOf('=');
        const name = eq === -1 ? arg : arg.slice(0, eq);
        const inline = eq === -1 ? undefined : arg.slice(eq + 1);
        const value = (): string => {
            const next = inline ?? argv[++i];
            if (next === undefined) throw new Error(`${name} needs a value`);
            return next;
        };

        switch (name) {
            case '-h': case '--help':
                process.stdout.write(USAGE);
                return 0;
            case '--version':
                process.stdout.write(`${version()} (node ${process.versions.node})\n`);
                return 0;
            case '--verify':
                verifyOnly = true;
                break;
            case '--deep':
                flags.deep = true;
                break;
            case '--entry':
                flags.entry = value();
                break;
            case '-r': case '--root':
                if (baked.sealed) return sealedRefusal(name);
                flags.roots.push(value());
                break;
            case '--identity':
                if (baked.sealed) return sealedRefusal(name);
                flags.identity = value();
                break;
            case '--issuer':
                if (baked.sealed) return sealedRefusal(name);
                flags.issuer = value();
                break;
            case '--untrusted':
                if (baked.sealed) return sealedRefusal(name);
                flags.allowUntrusted = true;
                break;
            default:
                process.stderr.write(`unknown option ${name}\n\n${USAGE}`);
                return 64;
        }
    }

    const archive = argv[i];
    if (archive === undefined) {
        process.stderr.write(`no archive to run\n\n${USAGE}`);
        return 64;
    }

    const options: LaunchOptions = {
        ...baked,
        ...flags,
        roots: flags.roots.length > 0 ? flags.roots : undefined,
    };
    const container = PATH.resolve(archive);

    if (verifyOnly) {
        const result = verify(container, options);
        process.stdout.write(`${result.state.toUpperCase()} — ${result.reason}\n`);
        if (result.identity) process.stdout.write(`  identity: ${result.identity}\n`);
        return result.state === 'valid' ? 0 : 1;
    }

    // The application sees the argv it would have had from `--vfs-load`: the
    // archive's own path where a script path goes, and its arguments from
    // index 2 on. The runtime's own options are gone by then — they were the
    // runtime's, not the program's.
    process.argv = [process.argv[0]!, container, ...argv.slice(i + 1)];

    await run(container, options);
    return 0;
}

/** This package's version, read out of the mount the verifier is running from. */
function version(): string {
    try {
        const manifest = JSON.parse(
            FS.readFileSync(PATH.join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
        ) as { name?: string; version?: string };
        return `${manifest.name ?? 'bundle'} ${manifest.version ?? '0.0.0'}`;
    } catch {
        return 'bundle';
    }
}

// ------------------------------------------------------------------ details ---

// The archive's entry point: an explicit override, else its package.json
// `main`, else `index.js` — node's own order for a directory.
function entryPoint(root: string, override: string | undefined): string {
    if (override) return PATH.resolve(root, override);
    const manifest = readPackage(root);
    return PATH.resolve(root, typeof manifest['main'] === 'string' ? manifest['main'] : 'index.js');
}

function isModule(root: string, entry: string): boolean {
    if (entry.endsWith('.mjs')) return true;
    if (entry.endsWith('.cjs')) return false;
    return readPackage(root)['type'] === 'module';
}

function readPackage(root: string): Record<string, unknown> {
    try {
        return JSON.parse(FS.readFileSync(PATH.join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function refuse(options: LaunchOptions, reason: string): never {
    if (options.onRefuse) {
        options.onRefuse(reason);
        throw new Error(reason);
    }
    process.stderr.write(`refusing to run: ${reason}\n`);
    process.exit(1);
}
