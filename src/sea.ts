import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { mount, start, verify, type Baked, type Mounted } from './launch.ts';
import { signBundle, createBundle, type BuildResult } from './api.ts';
import type { VerificationResult } from './manifest.ts';
import { moduleFiles, packageRoot, moduleDir } from './files.ts';
import type { Signer } from './archive.ts';

// Building the executables: a node runtime with this package inside it, which
// verifies an archive before running anything out of it.
//
// One base binary, two things to do with it:
//
//   [ node runtime | SEA blob: stub + verifier.bundle ]
//     a *verifying node* — `node-verifying ./my-app.zip` checks that archive
//     and runs it. Any archive, checked every time, none of them baked in.
//
//   [ node runtime | SEA blob: stub + verifier.bundle ] [ app.bundle ]
//     \______________ the prefix, and part of the app archive's ______/
//      \____________ signed region ____________________/
//     a *self-validating executable* — the same base with an application
//     appended and the whole file signed as one.
//
// The second is the first with an archive behind it, which is not a
// coincidence: appending is `sign --prefix`, the same operation that puts a
// shebang in front of an archive. What makes it self-validating is that the
// whole-file hash covers the prefix too, so the runtime and the verifier are
// signed by the same signature that covers the application. There is nothing to
// check the checker against because the checker is inside what is checked.
//
// Which shape a binary is, it decides at startup by looking at its own tail —
// see `appended()` in `./launch.ts`. That is why one base serves both, and why
// a verifying node built today can become a self-validating executable
// tomorrow with nothing but `bundle sign --prefix`.
//
// ## The package rides in the blob as an archive
//
// The stub runs before anything is mounted, so it cannot import this package
// the ordinary way. It does not have to: `"useVfs": true` with
// `"vfsArchive": <bundle>` (nodejs/node#65675 and the `vfsArchive` that
// followed it) embeds a ZIP in the executable and mounts it as the file system
// the main script runs from. So the stub is three lines — require this
// package's launcher by a relative path and hand over — and the machinery that
// used to do it by hand, mounting a raw asset through a `ZipBuffer`, is gone.
//
// ## What runs before the check
//
// The stub and the verifier execute before any signature has been verified.
// That is not a hole so much as the place where the trust has to start: in a
// self-validating executable both live inside the prefix, which is inside the
// hashed region, so tampering with either invalidates the signature over the
// application — and an attacker who can rewrite the executable's own runtime
// could equally rewrite a verifier that ran first. The application never runs
// until the check passes.

// ------------------------------------------------------------------ runtime ---

// The runtime half moved to `./launch.ts`, where the verifying node's command
// line lives beside it. These are the names this module has always exported;
// they are kept because a container built by an older version of this package
// still calls them, and because "verify myself and run what is in me" reads
// better than "run the container that happens to be process.execPath".

export interface BootstrapOptions extends Baked {
    /** The container to verify and mount (default: `process.execPath`). */
    container?: string | undefined;
}
export type { Mounted };

/**
 * Verify the running container and mount the archive appended to it. Returns
 * where it landed; nothing has been executed out of it yet.
 */
export function mountSelf(options: BootstrapOptions = {}): Mounted {
    return mount(options.container ?? process.execPath, options);
}

/** Verify the running container, mount it, and run the application inside. */
export async function bootstrap(options: BootstrapOptions = {}): Promise<void> {
    await start(mountSelf(options));
}

/**
 * Verify the running container without mounting it — for an application that
 * wants to report on its own provenance ("signed by X at Y").
 */
export function verifySelf(options: BootstrapOptions = {}): VerificationResult {
    return verify(options.container ?? process.execPath, options);
}

// -------------------------------------------------------------------- build ---

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
    const output = executablePath(options.output);
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
        FS.writeFileSync(stub, stubSource(anchorPolicy(options.bootstrap ?? {})));

        const config = PATH.join(scratch, 'sea-config.json');
        FS.writeFileSync(config, `${JSON.stringify({
            main: stub,
            output,
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false,
            // The verifier bundle is the executable's file system rather than
            // an asset it has to unpack: node embeds the ZIP as it is and
            // mounts it, and the stub — injected at the root of that mount —
            // requires this package out of it by relative path.
            useVfs: true,
            vfsArchive: verifier,
            // The stub is injected at the root of that bundle, where this
            // package's own `"type": "module"` decides what a `.js` is — so it
            // is an ES module, and saying so is what makes it one. Note that
            // `"mainFormat": "commonjs"` would not do the opposite: the mount's
            // package.json still wins, and the only way to a CommonJS stub is a
            // `.cjs` extension.
            mainFormat: 'module',
            execArgv: options.execArgv ?? SEA_EXEC_ARGV,
            execArgvExtension: 'none',
            ...(options.node ? { executable: PATH.resolve(options.node) } : {}),
        }, null, 2)}\n`);

        const built = spawnSync(process.execPath, ['--no-warnings', '--build-sea', config],
            { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
        if (built.error) throw built.error;
        if (built.status !== 0) {
            throw new Error(`--build-sea failed (exit ${built.status}): ${(built.stderr || built.stdout || '').trim()}`);
        }
        FS.chmodSync(output, 0o755);

        // `--build-sea` ignores configuration keys it does not know, so a node
        // without `vfsArchive` would produce a binary that builds cleanly and
        // fails at startup with nothing mounted. Run the result once: it costs
        // milliseconds and it is the difference between finding that out here
        // and finding it out in front of a user. A cross-build cannot be run,
        // so it is not checked — the platform it is for is not this one.
        if (!options.node) selftest(output);

        return { output, size: FS.statSync(output).size, verifier: contents };
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
            log('* building the SEA base (node runtime + verifier)');
            const built = await createSeaBase({ ...options, output: PATH.join(scratch, 'sea-base'), scratch });
            // Where it actually landed, which on Windows has `.exe` on the end.
            base = built.output;
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
 * Resolve the paths in a baked policy, because a policy is baked *here* and read
 * *there*. `--root build/certs/root.pem` is a sentence about the directory the
 * build ran in; the binary that carries it may be run anywhere, by anyone, and a
 * trust root it cannot find is a container that refuses everything. PEM text
 * passes through untouched — it is not a path and has no directory to be
 * relative to.
 */
function anchorPolicy(options: BootstrapOptions): BootstrapOptions {
    const anchored = { ...options };
    if (options.roots) {
        anchored.roots = options.roots.map((root) => (root.includes('-----BEGIN') ? root : PATH.resolve(root)));
    }
    if (options.trustedRoot) anchored.trustedRoot = PATH.resolve(options.trustedRoot);
    return anchored;
}

/**
 * Run the built binary once, to prove that the file system inside it mounts and
 * this package can be required out of it. `--version` is the cheapest thing
 * that touches all of that, and it works whichever shape the binary is.
 */
/**
 * Where the built executable will be. Windows runs a file because of its
 * extension, so a SEA without `.exe` is a file nothing will start — including
 * the self-test below, which would report a build failure for what is really a
 * naming one. Everywhere else the name is left exactly as asked for.
 */
export function executablePath(output: string): string {
    const resolved = PATH.resolve(output);
    return process.platform === 'win32' && !/\.exe$/i.test(resolved) ? `${resolved}.exe` : resolved;
}

function selftest(output: string): void {
    const res = spawnSync(PATH.resolve(output), ['--version'],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
    if (res.error) throw res.error;
    if (res.status !== 0 || !/bundle/.test(res.stdout)) {
        throw new Error(
            `the built executable does not run (exit ${res.status}): ${(res.stderr || res.stdout || '').trim()}\n` +
            'A node whose --build-sea does not understand "vfsArchive" builds exactly this: ' +
            'the configuration key is ignored, nothing is mounted, and the stub has nothing to require.');
    }
}

/**
 * The CommonJS stub injected as the SEA's main script. It runs at the root of
 * the mounted verifier bundle, so requiring this package is a relative path and
 * nothing more; everything else it needs to decide, `launch` decides by looking
 * at the binary's own tail.
 *
 * It stays the one piece no test can exercise from source, so it stays small.
 */
export function stubSource(options: BootstrapOptions): string {
    const dir = moduleDir();
    const entry = `./${dir}/launch${dir === 'src' ? '.ts' : '.js'}`;
    return `// Generated by @pipobscure/bundle. The SEA main, running at the root of the
// archive this executable carries: hand over to the launcher, which verifies
// either the archive appended to this file or the one named on the command
// line before running anything out of it.
import * as launch from ${JSON.stringify(entry)};

const OPTIONS = ${JSON.stringify(options, null, 2)};

try {
    // Only a binary with nothing behind it takes an archive from the command
    // line. One with an *unsigned* archive appended is not a launcher with a
    // stray tail — it is a container somebody forgot to sign, and saying so is
    // worth more than falling back to a usage message.
    const code = launch.appended(process.execPath) === 'none'
        ? await launch.main(process.argv.slice(2), OPTIONS)
        : await launch.runSelf(OPTIONS);
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
} catch (err) {
    process.stderr.write(\`\${err && err.stack || err}\\n\`);
    process.exitCode = 1;
}
`;
}
