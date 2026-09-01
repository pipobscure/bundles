import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { Writable } from 'node:stream';
import { bundle, rebundle, keySigner, members, type EmitResult, type Signer } from './archive.ts';
import {
    verify, verifySync, signatureOf, parseManifest, AUTHORITY,
    type VerificationResult, type VerifyOptions, type ArchiveSource, type ManifestFields,
} from './manifest.ts';

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
    /** A launcher or binary to prepend, making the result self-running. */
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
    /** Path to the archive whose members are re-emitted and signed. */
    source: string;
    prefix?: string | undefined;
    /** Make the output executable; implied by `prefix`. */
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
    /** Run an archive whose signature is good but whose chain is unanchored. */
    allowUntrusted?: boolean | undefined;
    /** Arguments handed to the application inside the archive. */
    args?: string[] | undefined;
    /** Extra environment for the child, merged over `process.env`. */
    env?: NodeJS.ProcessEnv | undefined;
    /** How the child's stdio is wired (default: 'inherit'). */
    stdio?: 'inherit' | 'pipe' | undefined;
}

export interface RunResult {
    /** The child's exit status, or null when it was killed by a signal. */
    status: number | null;
    signal: NodeJS.Signals | null;
    /** Captured only when `stdio` was 'pipe'. */
    stdout?: string | undefined;
    stderr?: string | undefined;
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
 * Sign an existing archive into a new file. The input is never modified: its
 * members are read out, laid down again behind whatever prefix was asked for,
 * and the finished bytes are hashed and signed as a whole. One unsigned archive
 * therefore yields every shape — a `#!` launcher, a self-contained binary, or a
 * plain mountable archive — each correctly offset and each signed over itself.
 */
export async function signBundle(options: SignOptions): Promise<BuildResult> {
    const { source, output, prefix, executable, hashAlg, signAlg, key, chain, signer } = options;
    if (!source) throw new Error('sign: an archive path is required');
    if (!signer && Boolean(key) !== Boolean(chain)) throw new Error('sign: key and chain must be given together');
    if (output && PATH.resolve(output) === PATH.resolve(source)) {
        throw new Error('sign: the output must differ from the input archive');
    }

    return await produce(options, Boolean(prefix || executable), (out) => rebundle({
        source, prefix, hashAlg, signAlg, key, chain, signer, out,
    }));
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
 * Mount a signed archive and run the application inside it, in a child process
 * with the verifying provider preloaded — so the archive is checked and mounted
 * by the child's own bootstrap, and what runs is what was verified.
 *
 * Verification happens here too, before the child is spawned. That buys nothing
 * the child does not already enforce; it buys a legible refusal instead of an
 * uncaught error thrown from inside node's startup.
 */
export function runBundle(archive: string, options: RunOptions = {}): RunResult {
    const roots = options.roots ?? [];
    const res = verifyBundleSync(archive, {
        roots, deep: false, identity: options.identity, issuer: options.issuer,
    });
    const acceptable = res.state === 'valid' || (Boolean(options.allowUntrusted) && res.state === 'valid-untrusted');
    if (!acceptable) {
        throw Object.assign(new Error(`refusing to run '${archive}': ${res.state} — ${res.reason}`),
            { code: 'ERR_BUNDLE_UNTRUSTED', state: res.state });
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    if (roots.length) env['BUNDLE_ROOTS'] = roots.join(PATH.delimiter);
    if (options.identity) env['BUNDLE_IDENTITY'] = options.identity;
    if (options.issuer) env['BUNDLE_ISSUER'] = options.issuer;
    if (options.allowUntrusted) env['BUNDLE_ALLOW_UNTRUSTED'] = '1';

    const child: SpawnSyncReturns<string> = spawnSync(
        process.execPath,
        [...mountArgv(archive), ...(options.args ?? [])],
        { stdio: options.stdio ?? 'inherit', env, encoding: 'utf-8' },
    );
    if (child.error) throw child.error;
    return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
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
        '--vfs-load', '--vfs-mount', archive,
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
async function produce(
    { output, stream }: Destination,
    executable: boolean,
    build: (out: Writable) => Promise<EmitResult>,
): Promise<BuildResult> {
    const out = stream ?? (output ? FS.createWriteStream(output) : process.stdout);
    const res = await build(out);
    if (!stream) await close(out);

    if (output && executable) FS.chmodSync(output, 0o755);
    return {
        ...res,
        output: output ?? null,
        members: output ? members(output) : [],
        size: output ? FS.statSync(output).size : undefined,
    };
}

function close(out: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
        if (out === process.stdout) return void out.end(() => resolve());
        out.on('error', reject).on('finish', () => resolve()).end();
    });
}
