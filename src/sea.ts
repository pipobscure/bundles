import * as VFS from 'node:vfs';
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { open as openBundle, type ProviderOptions } from './provider.ts';
import { signBundle, createBundle, type BuildResult } from './api.ts';
import { verifySync, message, type VerificationResult } from './manifest.ts';
import { moduleFiles, packageRoot, moduleDir } from './files.ts';
import type { Signer } from './archive.ts';

// A single-executable application that verifies itself before it runs.
//
// The shape is one file with three parts, in the order the loader meets them:
//
//   [ node runtime | SEA blob: stub + verifier.bundle ] [ app.bundle ]
//     \______________ the prefix, and part of the app archive's ______/
//      \____________ signed region ____________________/
//
// The application is an ordinary signed `.bundle` appended to a node binary —
// the same `sign --prefix` this tool already does for a shebang launcher. What
// makes the result self-validating is that the whole-file hash covers the
// prefix too, so the runtime and the verifier inside it are signed by the same
// signature that covers the application. There is nothing to check the checker
// against because the checker is inside what is checked.
//
// ## Driving SEA through a VFS mount
//
// The bootstrap runs before anything is mounted, so it cannot import this
// package the ordinary way. Rather than inlining a second copy of the verifier
// into the stub — which is what this file replaced, and which drifts — the
// package's own files ride in the SEA blob as a single `.bundle` asset, and the
// stub mounts *that* with `node:vfs` and requires the real library out of it.
// So there are two mounts: the verifier's, from the blob, and then the
// application's, from the archive at the end of the file.
//
// This mirrors nodejs/node#65675 (`"useVfs": true`), which puts a SEA's own
// assets behind a VFS mount and runs the main script from its root, so that
// `__dirname`, relative `require()` and `node_modules` resolution all work
// inside the executable. That work is not merged and is not in any released
// node, so the same thing is done here in userland — with the difference that
// matters for this package: the mount that runs the *application* is the signed
// archive appended to the file, not the blob. When `useVfs` lands, the stub is
// the only piece that changes.
//
// ## What runs before the check
//
// The stub and the verifier execute before the signature has been verified.
// That is not a hole so much as the place where the trust has to start: both
// live inside the prefix, which is inside the hashed region, so tampering with
// either invalidates the signature over the application — and an attacker who
// can rewrite the executable's own runtime could equally rewrite a verifier
// that ran first. The application never runs until the check passes.

// ------------------------------------------------------------------ runtime ---

export interface BootstrapOptions {
    /** The container to verify and mount (default: `process.execPath`). */
    container?: string | undefined;
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
 * Verify the running container and mount the archive appended to it. Returns
 * where it landed; nothing has been executed out of it yet.
 *
 * The mount is the verifying provider, so this is not merely a signature check
 * at startup: every member is re-hashed against its signed digest as it is
 * first read, for the whole life of the process.
 */
export function mountSelf(options: BootstrapOptions = {}): Mounted {
    const container = options.container ?? process.execPath;

    const settings: ProviderOptions = {
        roots: options.roots,
        identity: options.identity,
        issuer: options.issuer,
        trustedRoot: options.trustedRoot,
        allowUntrusted: options.allowUntrusted,
        deep: options.deep,
        name: 'bundle-sea',
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
 * The whole startup: verify the container, mount it, and run the application
 * inside. A CommonJS entry is `require()`d and an ES module is `import()`ed,
 * chosen the way node itself chooses — the archive's `package.json` `type` and
 * the entry's own extension.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
    const { root, entry } = mountSelf(options);
    if (isModule(root, entry)) await import(pathToFileURL(entry).href);
    else createRequire(PATH.join(root, 'package.json'))(entry);
}

/**
 * Verify the running container without mounting it — for an application that
 * wants to report on its own provenance ("signed by X at Y").
 */
export function verifySelf(options: BootstrapOptions = {}): VerificationResult {
    const container = options.container ?? process.execPath;
    const roots = (options.roots ?? []).map((root) => (root.includes('-----BEGIN') ? root : FS.readFileSync(root, 'utf-8')));
    return verifySync(container, {
        extraRoots: roots, deep: options.deep ?? false,
        identity: options.identity, issuer: options.issuer, trustedRoot: options.trustedRoot,
    });
}

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

function refuse(options: BootstrapOptions, reason: string): never {
    if (options.onRefuse) {
        options.onRefuse(reason);
        throw new Error(reason);
    }
    process.stderr.write(`refusing to run: ${reason}\n`);
    process.exit(1);
}

// -------------------------------------------------------------------- build ---

/** The SEA asset the verifier bundle rides in. */
export const VERIFIER_ASSET = 'bundle-verifier.bundle';

/** The default flags the container runs itself with. */
export const SEA_EXEC_ARGV = ['--no-warnings', '--experimental-vfs'];

export interface VerifierOptions {
    /**
     * Include the sigstore libraries, so the container can check a
     * sigstore-signed archive rather than degrading it to untrusted
     * (default: true). Costs roughly a megabyte of dependency tree.
     */
    sigstore?: boolean | undefined;
}

export interface SeaBaseOptions extends VerifierOptions {
    /** Where to write the base binary. */
    output: string;
    /**
     * The node binary to embed (default: the running one). This is the runtime
     * the finished container ships, so it decides which platform it runs on.
     */
    node?: string | undefined;
    /** Options baked into the stub and handed to `bootstrap()` at startup. */
    bootstrap?: BootstrapOptions | undefined;
    /** Runtime flags the container applies to itself. */
    execArgv?: string[] | undefined;
    /** A prebuilt verifier bundle to embed, instead of building one. */
    verifier?: string | undefined;
    /** Scratch directory for the generated stub and config. */
    scratch?: string | undefined;
}

export interface SeaOptions extends SeaBaseOptions {
    /** The application archive to append. Signed or not; it is re-signed here. */
    app: string;
    /** A base built earlier, instead of building one now. */
    base?: string | undefined;
    /** Sign the finished container. Without one it is built but left unsigned. */
    signer?: Signer | undefined;
    hashAlg?: string | undefined;
    signAlg?: string | undefined;
    /** Progress, one line at a time. */
    log?: ((line: string) => void) | undefined;
}

export interface SeaBaseResult {
    output: string;
    size: number;
    /** Members of the verifier bundle embedded in the blob. */
    verifier: string[];
}

/**
 * Build the SEA base: a node runtime whose injected main mounts this package
 * out of its own blob and hands over to `bootstrap()`. The result is a binary
 * with no application in it yet — append one with `buildSea` or with
 * `sign --prefix`.
 */
export async function createSeaBase(options: SeaBaseOptions): Promise<SeaBaseResult> {
    const scratch = options.scratch ?? FS.mkdtempSync(PATH.join(OS.tmpdir(), 'bundle-sea-'));
    const owned = !options.scratch;
    try {
        let verifier = options.verifier;
        let contents: string[];
        if (verifier) {
            contents = [];
        } else {
            verifier = PATH.join(scratch, 'verifier.bundle');
            const files = verifierFiles(options);
            await createBundle({ base: packageRoot(), files, output: verifier });
            contents = files;
        }

        const stub = PATH.join(scratch, 'stub.js');
        FS.writeFileSync(stub, stubSource(options.bootstrap ?? {}));

        const config = PATH.join(scratch, 'sea-config.json');
        FS.writeFileSync(config, `${JSON.stringify({
            main: stub,
            output: PATH.resolve(options.output),
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false,
            execArgv: options.execArgv ?? SEA_EXEC_ARGV,
            execArgvExtension: 'none',
            ...(options.node ? { executable: PATH.resolve(options.node) } : {}),
            assets: { [VERIFIER_ASSET]: verifier },
        }, null, 2)}\n`);

        const built = spawnSync(process.execPath, ['--no-warnings', '--build-sea', config],
            { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
        if (built.error) throw built.error;
        if (built.status !== 0) {
            throw new Error(`--build-sea failed (exit ${built.status}): ${(built.stderr || built.stdout || '').trim()}`);
        }
        FS.chmodSync(options.output, 0o755);
        return { output: options.output, size: FS.statSync(options.output).size, verifier: contents };
    } finally {
        if (owned) FS.rmSync(scratch, { recursive: true, force: true });
    }
}

/**
 * Build a self-validating executable: a SEA base with `app` appended and the
 * whole thing signed as one file. Everything the container will check — the
 * runtime, the verifier and the application — is inside what the signature
 * covers.
 */
export async function buildSea(options: SeaOptions): Promise<BuildResult> {
    const log = options.log ?? (() => {});
    const scratch = options.scratch ?? FS.mkdtempSync(PATH.join(OS.tmpdir(), 'bundle-sea-'));
    const owned = !options.scratch;
    try {
        let base = options.base;
        if (!base) {
            base = PATH.join(scratch, 'sea-base');
            log('* building the SEA base (node runtime + verifier)');
            const built = await createSeaBase({ ...options, output: base, scratch });
            log(`  base: ${built.size} bytes, ${built.verifier.length} verifier members`);
        }

        log(`* appending ${options.app} behind ${PATH.basename(base)}`);
        const res = await signBundle({
            source: options.app,
            output: options.output,
            prefix: base,
            executable: true,
            hashAlg: options.hashAlg,
            signAlg: options.signAlg,
            signer: options.signer,
        });
        log(res.signed ? `* signed: ${res.hash}` : '* built unsigned — it will refuse to run until it is signed');
        return res;
    } finally {
        if (owned) FS.rmSync(scratch, { recursive: true, force: true });
    }
}

/**
 * The files the embedded verifier needs, as paths relative to this package's
 * root. That is this package's own compiled modules plus, unless turned off,
 * the sigstore libraries — resolved through `node_modules` rather than listed,
 * so the set cannot fall behind the dependency tree.
 */
export function verifierFiles({ sigstore = true }: VerifierOptions = {}): string[] {
    return moduleFiles({
        base: packageRoot(),
        files: ['package.json'],
        dirs: [moduleDir()],
        dependencies: sigstore ? SIGSTORE_PACKAGES : [],
        // Source maps and declarations are for reading the code, not running
        // it, and a verifier that ships inside every executable should carry
        // only what it executes.
        filter: (name) => !name.endsWith('.map') && !name.endsWith('.d.ts') && !name.endsWith('.d.cts'),
    });
}

/** The sigstore libraries verification needs; signing pulls in more at runtime. */
const SIGSTORE_PACKAGES = ['@sigstore/verify', '@sigstore/bundle', '@sigstore/protobuf-specs', '@sigstore/tuf'];

/**
 * The CommonJS stub injected into the SEA blob. It is deliberately the smallest
 * thing that can work — mount the blob's verifier bundle, require this module
 * out of it, call `bootstrap()` — because it is the one piece that cannot be
 * covered by a test that runs it from source, and the one piece that changes if
 * node's own `useVfs` lands.
 */
export function stubSource(options: BootstrapOptions): string {
    const dir = moduleDir();
    const entry = `./${dir}/sea${dir === 'src' ? '.ts' : '.js'}`;
    return `'use strict';
// Generated by @pipobscure/bundle. The SEA main: mount this package out of the
// executable's own blob, then hand over to its bootstrap, which verifies the
// archive appended to this file before running anything out of it.
const SEA = require('node:sea');
const ZLIB = require('node:zlib');
const VFS = require('node:vfs');
const MOD = require('node:module');
const PATH = require('node:path');

const OPTIONS = ${JSON.stringify(options, null, 2)};

const blob = new ZLIB.ZipBuffer(Buffer.from(SEA.getRawAsset(${JSON.stringify(VERIFIER_ASSET)})));
const vfs = VFS.create(new VFS.ZipProvider(blob), { emitExperimentalWarning: false });
const root = vfs.mount();
const bundle = MOD.createRequire(PATH.join(root, 'package.json'))(${JSON.stringify(entry)});

bundle.bootstrap(OPTIONS).catch((err) => {
    process.stderr.write(\`\${err && err.stack || err}\\n\`);
    process.exitCode = 1;
});
`;
}
