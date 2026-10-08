import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import type { Writable } from 'node:stream';
import { bundle, rebundle, reprefix, keySigner, members, prefixLength, type EmitResult, type Signer } from './archive.ts';
import {
    verify, verifySync, signatureOf, parseManifest, AUTHORITY,
    type VerificationResult, type VerifyOptions, type ArchiveSource, type ManifestFields,
} from './manifest.ts';
import { attestersFrom } from './attestation.ts';

// The programmatic face of the tool: bundling, signing, verifying and running,
// with the file plumbing that the CLI would otherwise be the only user of.
//
// Everything here is a thin arrangement of `archive.ts` and `manifest.ts`. What
// it adds is that a caller says where the output goes rather than building a
// `Writable` and remembering to wait for it to flush, and that the functions
// the CLI calls are exactly the ones an embedder gets — `cli.ts` holds no logic
// of its own beyond argument parsing, for that reason.

/** What a build wrote, and what it signed. */
export interface BuildResult extends EmitResult {
    /** Where the archive was written, or null when it went to a stream. */
    output: string | null;
    /** Member names in the finished archive, excluding `AUTHORITY.PEM`. */
    members: string[];
    /** Size of the written file in bytes, when it went to a path. */
    size?: number | undefined;
}

/** Where a build's bytes go: a path, a caller's stream, or stdout. */
interface Destination {
    /** Where to write the archive. */
    output?: string | undefined;
    /** An open stream to write to instead. The caller closes it. */
    stream?: Writable | undefined;
}

export interface CreateOptions extends Destination {
    /** Base directory the file list is relative to (default: '.'). */
    base?: string | undefined;
    /** Member names, relative to `base`. */
    files: string[];
    /**
     * A launcher or binary to put in front of the archive, making the result
     * self-running. This decides the archive's shape for good: signing keeps
     * it, and an audit reviews it with everything else.
     */
    prefix?: string | undefined;
    hashAlg?: string | undefined;
    signAlg?: string | undefined;
    /** Sign as it is built. Both must be given together. */
    key?: Buffer | string | undefined;
    chain?: string | undefined;
    /** A two-phase signer, instead of `key`/`chain`. */
    signer?: Signer | undefined;
}

export interface SignOptions extends Destination {
    /** Path to the archive to sign. Its prefix, if it has one, is kept as it is. */
    source: string;
    /** Make the output executable; implied when the archive has a prefix. */
    executable?: boolean | undefined;
    hashAlg?: string | undefined;
    signAlg?: string | undefined;
    key?: Buffer | string | undefined;
    chain?: string | undefined;
    signer?: Signer | undefined;
}

export interface VerifyBundleOptions extends VerifyOptions {
    /**
     * Extra trusted roots, as PEM text or as paths to PEM files — the
     * convenience form of `extraRoots`, which takes PEM text only.
     */
    roots?: string[] | undefined;
}

export interface RunOptions {
    /** Extra trusted roots, as PEM text or paths to PEM files. */
    roots?: string[] | undefined;
    identity?: string | undefined;
    issuer?: string | undefined;
    /** Require attestations from these attesters, as `[kind@]did`. */
    attesters?: string[] | undefined;
    /** How many of `attesters` must have attested (default: all of them). */
    quorum?: number | undefined;
    /** Milliseconds a cached attestation proof stays good for. */
    maxAge?: number | undefined;
    /** Refuse an archive any of these DIDs has marked bad. */
    block?: string[] | undefined;
    /** Run an archive whose signature is good but whose chain is unanchored. */
    allowUntrusted?: boolean | undefined;
    /** Arguments handed to the application inside the archive. */
    args?: string[] | undefined;
}

/** What an archive says about itself, with no trust decision attached. */
export interface Inspection {
    /** Member names, excluding `AUTHORITY.PEM`. */
    members: string[];
    /** Whether the archive carries a signature marker at all. */
    signed: boolean;
    /** The whole-file hash the marker records, hex. */
    hash?: string | undefined;
    /** Names of the unsigned attributes carried beside the signature. */
    fields: string[];
    /** The manifest's declared algorithms and certificate chain. */
    manifest?: ManifestFields | undefined;
}

/**
 * Build an archive from a base directory and a list of files, optionally
 * signing it and optionally prepending a launcher or binary.
 */
export async function createBundle(options: CreateOptions): Promise<BuildResult> {
    const { base = '.', files, prefix, hashAlg, signAlg, key, chain, signer } = options;
    if (!files.length) throw new Error('create: the file list is empty');
    if (!signer && Boolean(key) !== Boolean(chain)) throw new Error('create: key and chain must be given together');

    return await produce(options, Boolean(prefix), (out) => bundle({
        base, files, prefix, hashAlg, signAlg, key, chain, signer, out,
    }));
}

/**
 * Sign an existing archive: its members are read out, laid down again behind
 * the archive's own prefix, and the finished bytes are hashed and signed as a
 * whole. `output` may be the archive itself — signing in place — since the
 * result replaces it only once it is complete. The prefix — the shape
 * of the result — is decided when the archive is created, so the archive an
 * audit reviewed is the one that is signed.
 */
export async function signBundle(options: SignOptions): Promise<BuildResult> {
    const { source, executable, hashAlg, signAlg, key, chain, signer } = options;
    if ((options as { prefix?: unknown }).prefix !== undefined) {
        throw new Error('sign: the prefix is chosen when the archive is created — pass it to createBundle(), and sign what it made');
    }
    if (!source) throw new Error('sign: an archive path is required');
    if (!signer && Boolean(key) !== Boolean(chain)) throw new Error('sign: key and chain must be given together');

    return await produce(options, Boolean(executable) || prefixLength(source) > 0, (out) => rebundle({
        source, hashAlg, signAlg, key, chain, signer, out,
    }));
}

/**
 * Where signing `source` writes by default: the same name without its
 * `.unsigned` — `app.unsigned.nzip` becomes `app.nzip`, an executable
 * `app.unsigned` becomes `app`, `app.unsigned.exe` becomes `app.exe` — and,
 * for a name that does not say it is unsigned, the archive itself, signed in
 * place. Every bundle is an `.nzip`, signed or not; the `.unsigned` is only a
 * convention for keeping the two apart while both are around.
 */
export function signedName(source: string): string {
    return source.replace(/\.unsigned(?=\.[^./\\]+$|$)/i, '');
}

/**
 * Put an existing archive behind a different prefix, unsigned — a node binary
 * with the verifier in it, for an executable. Its result is a new archive to
 * review and then sign; any signature the source had does not carry over.
 */
export async function prefixBundle(options: Destination & { source: string; prefix: string; hashAlg?: string | undefined }): Promise<BuildResult> {
    const { source, prefix, hashAlg } = options;
    return await produce(options, true, (out) => reprefix({ source, prefix, hashAlg, out }));
}

/** A signer backed by a private key and certificate chain read from disk. */
export function fileSigner({ key, chain, signAlg = 'sha256' }: {
    key: string;
    chain: string;
    signAlg?: string | undefined;
}): Signer {
    return keySigner({ key: FS.readFileSync(key), chain: FS.readFileSync(chain, 'utf-8'), signAlg });
}

/**
 * Verify an archive: recompute the whole-file hash, check the signature over it
 * against the leaf certificate, check every member's own digest, and decide
 * whether the certificate chain means anything to us.
 */
export async function verifyBundle(source: ArchiveSource, options?: VerifyBundleOptions): Promise<VerificationResult> {
    return verify(source, withRoots(options));
}

/** The synchronous form, for callers on a path that cannot await — a mount. */
export function verifyBundleSync(source: ArchiveSource, options?: VerifyBundleOptions): VerificationResult {
    return verifySync(source, withRoots(options));
}

/**
 * What an archive claims about itself — its members, whether it is signed at
 * all, and what its manifest declares. This is the cheap "what am I looking at"
 * call; `verifyBundle` is the expensive one that answers whether any of it is
 * true, and nothing here should be believed until it has run.
 */
export function inspectBundle(source: string): Inspection {
    const marker = signatureOf(source);
    const names = members(source);
    let manifest: ManifestFields | undefined;
    const zip = ZLIB.ZipFile.openSync(PATH.resolve(source));
    try {
        if (zip.has(AUTHORITY)) manifest = parseManifest(zip.getSync(AUTHORITY).contentSync());
    } finally {
        zip.closeSync();
    }
    return {
        members: names,
        signed: marker !== null,
        hash: marker?.hash,
        fields: marker ? [...marker.fields.keys()] : [],
        manifest,
    };
}

/**
 * Check a signed archive, mount it through the verifying provider, and run what
 * is inside — in this process. The mount is the enforcement: the provider
 * verifies before it hands back a filesystem, and every member is re-hashed
 * against its signed digest as it is read, for as long as the process lives.
 *
 * This used to re-exec node with `-r <preload> --vfs-load <archive>`, which
 * gave the application a process of its own and cost more than it was worth:
 * a preload has to be a real file, and it is not when this package is itself
 * running out of an archive — which is how the published CLI runs. Mounting
 * here needs no preload, because the provider is registered in the process
 * doing the mounting.
 *
 * What is given up is isolation: the application shares this process, and this
 * package's modules are loaded in it. Anyone who wants a child can have one —
 * `mountArgv()` names the node arguments for it.
 */
export async function runBundle(archive: string, options: RunOptions = {}): Promise<number> {
    const { run } = await import('./launch.ts');
    // The application reads `process.argv.slice(2)`, and `argv[1]` names the
    // archive it came out of — the shape `--vfs-load` gives it.
    ensureRunnable(archive, options);

    const argv = process.argv;
    process.argv = [argv[0]!, PATH.resolve(archive), ...(options.args ?? [])];
    try {
        await run(archive, {
            roots: options.roots, identity: options.identity, issuer: options.issuer,
            attesters: options.attesters, quorum: options.quorum, maxAge: options.maxAge, block: options.block,
            allowUntrusted: options.allowUntrusted,
            // A refusal is the caller's to report; the default here would
            // print a line and exit the process.
            onRefuse: (reason) => { throw Object.assign(new Error(reason), { code: 'ERR_BUNDLE_UNTRUSTED' }); },
        });
    } finally {
        process.argv = argv;
    }
    return Number(process.exitCode ?? 0);
}

/**
 * The node arguments that mount `archive` as the filesystem and run the program
 * inside it, with this package's verifying provider preloaded. Anything after
 * these is the application's own argv — the trailing `--` is what makes that
 * true, since without it node claims any argument that looks like one of its
 * own flags and the application never sees it.
 */
export function mountArgv(archive: string): string[] {
    return [
        '--no-warnings', '--experimental-vfs',
        '-r', registerPath(),
        '--vfs-load', archive,
        '--',
    ];
}

/**
 * The absolute path of the preload that registers the verifying provider, as a
 * real path `node -r` can resolve.
 */
export function registerPath(): string {
    const ext = import.meta.filename.endsWith('.ts') ? '.ts' : '.js';
    return PATH.join(PATH.dirname(import.meta.filename), `register${ext}`);
}

// Verify before anything is mounted, so an archive that will not run says so
// once, legibly, with the state that decides the exit code — rather than as an
// error thrown out of a mount.
function ensureRunnable(archive: string, options: RunOptions): void {
    const res = verifyBundleSync(archive, {
        roots: options.roots ?? [], deep: false, identity: options.identity, issuer: options.issuer,
        attesters: options.attesters ? attestersFrom(options.attesters) : undefined,
        quorum: options.quorum, maxAge: options.maxAge,
        block: options.block ? attestersFrom(options.block) : undefined,
    });
    const acceptable = res.state === 'valid' || (Boolean(options.allowUntrusted) && res.state === 'valid-untrusted' && !res.unmet);
    if (!acceptable) {
        throw Object.assign(new Error(`refusing to run '${archive}': ${res.state} — ${res.reason}`),
            { code: 'ERR_BUNDLE_UNTRUSTED', state: res.state });
    }
}

// `roots` may name PEM files or carry PEM text; `verifySync` wants text.
function withRoots(options: VerifyBundleOptions | undefined): VerifyOptions {
    if (!options) return {};
    const { roots, ...rest } = options;
    if (!roots?.length) return rest;
    const loaded = roots.map((root) => (root.includes('-----BEGIN') ? root : FS.readFileSync(root, 'utf-8')));
    return { ...rest, extraRoots: [...(rest.extraRoots ?? []), ...loaded] };
}

// Open the destination, run the build into it, wait for the bytes to land, and
// report what was written. A stream the caller supplied is left open — its
// lifetime is theirs — while one opened here is closed and waited on. stdout is
// ended (so a redirect sees EOF) but not awaited for 'finish', which never
// fires for a TTY or a pipe.
//
// A file is written beside its destination and renamed over it only once it is
// complete. So the destination can be the very archive being read — signing in
// place, which is the usual way to sign — and a build that fails part way, or
// is killed, leaves whatever was there before exactly as it was.
async function produce(
    { output, stream }: Destination,
    executable: boolean,
    build: (out: Writable) => Promise<EmitResult>,
): Promise<BuildResult> {
    const temporary = !stream && output ? `${output}.incoming-${process.pid}` : undefined;
    const out = stream ?? (temporary ? FS.createWriteStream(temporary, { mode: executable ? 0o755 : 0o644 }) : process.stdout);
    let res: EmitResult;
    try {
        res = await build(out);
        if (!stream) await close(out);
        if (temporary) {
            if (executable) FS.chmodSync(temporary, 0o755);
            FS.renameSync(temporary, output!);
        }
    } catch (err) {
        if (temporary) {
            out.destroy();
            FS.rmSync(temporary, { force: true });
        }
        throw err;
    }
    return {
        ...res,
        output: output ?? null,
        members: output ? members(output) : [],
        size: output ? FS.statSync(output).size : undefined,
    };
}

// A file is done when its descriptor is closed, not when its data is flushed:
// 'finish' comes first, and an executable started in between is one still
// open for writing, which the kernel refuses to run (ETXTBSY).
function close(out: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
        if (out === process.stdout) return void out.end(() => resolve());
        const done = out instanceof FS.WriteStream ? 'close' : 'finish';
        out.on('error', reject).on(done, () => resolve()).end();
    });
}
