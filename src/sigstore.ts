import * as CRYPTO from 'node:crypto';
import * as PATH from 'node:path';
import * as OS from 'node:os';
import * as FS from 'node:fs';
import { createRequire } from 'node:module';
import { identityToken, FULCIO_AUDIENCE } from './oidc.ts';
import type { Signer } from './archive.ts';

import type * as SigstoreBundle from '@sigstore/bundle';
import type * as SigstoreSign from '@sigstore/sign';
import type * as SigstoreVerify from '@sigstore/verify';
import type * as SigstoreSpecs from '@sigstore/protobuf-specs';
import type * as SigstoreTuf from '@sigstore/tuf';

// Sigstore as one of the signers this format can carry, rather than as the
// format itself.
//
// Everything the archive needs is still the same two things: a certificate
// chain in `AUTHORITY.PEM` and a signature over the whole-file hash in the
// EOCD comment. Sigstore only changes where the certificate comes from — a
// ten-minute Fulcio certificate bound to an OIDC identity, instead of a
// long-lived key on someone's disk — and adds one field to the comment.
//
// ## The ordering problem, and how the two-phase signer solves it
//
// `AUTHORITY.PEM` is a member, so it is inside the hashed region: the chain has
// to be known *before* the hash exists. The signature has to be made *after*.
// Sigstore's own `BundleBuilder` does both in one `create()` call, which cannot
// work here.
//
// It does not have to. A Fulcio certificate binds an *identity to a public
// key*; it says nothing about any message. So the two halves separate cleanly:
//
//   1. `signer()` — sign in, mint a keypair, get the certificate. No archive
//      needed, and nothing here depends on what is being signed.
//   2. `sign(digest)` — sign the finished hash with that key, then hand the
//      signature to Rekor and the timestamp authority for witnessing.
//
// Between them, the caller builds the archive with the chain from step 1 and
// hashes it. `archive.ts` drives exactly that sequence.
//
// ## Why the witnesses matter here more than usual
//
// A Fulcio certificate expires about ten minutes after it is issued, so
// `anchored()`'s "is this chain in date *now*?" question gives the wrong answer
// for every archive older than that. The right question is whether the
// certificate was valid *when the signature was made*, which needs a
// trustworthy assertion of when that was — a Rekor log entry, an RFC 3161
// token, or both. `Verifier` checks the signature against the signing time
// those establish, which is why the sigstore path replaces the plain X.509
// anchoring rather than adding to it.
//
// The bundle carrying that material rides in the EOCD comment as the
// `SIGSTORE=` field: it is produced after the signature, so it cannot live in
// the hashed region — the same reason RFC 3161 puts timestamp tokens in CMS
// `unsignedAttrs`. See HISTORY.md, "Implementation notes" §1.

const require = createRequire(import.meta.url);

export const DEFAULT_FULCIO_URL = 'https://fulcio.sigstore.dev';
export const DEFAULT_REKOR_URL = 'https://rekor.sigstore.dev';
export const DEFAULT_TSA_URL = 'https://timestamp.sigstore.dev/api/v1/timestamp';
export const DEFAULT_TUF_MIRROR = 'https://tuf-repo-cdn.sigstore.dev';

/** The comment field the sigstore bundle travels in. */
export const FIELD = 'SIGSTORE';

/** Where a trust root came from, so a caller can say how fresh it is. */
export type TrustedRootOrigin = 'explicit' | 'environment' | 'cache' | 'seed';

export interface TrustedRootLocation {
    origin: TrustedRootOrigin;
    /** The file it was read from, or the seed's mirror key. */
    path: string;
}

export interface SigstoreIdentity {
    subject?: string | undefined;
    issuer?: string | undefined;
    /** GitHub Actions tokens name the workflow that ran. */
    workflow?: string | undefined;
}

export interface SigstoreSignerOptions {
    /** An OIDC token to use instead of signing in. */
    token?: string | undefined;
    flow?: 'auto' | 'ci' | 'browser' | 'device' | undefined;
    /** OIDC issuer (default: sigstore's Dex). */
    issuer?: string | undefined;
    /** Dex connector to jump to (default: 'github'). */
    connector?: string | undefined;
    fulcioURL?: string | undefined;
    /** Transparency log; '' to skip. */
    rekorURL?: string | undefined;
    /** RFC 3161 timestamp authority; '' to skip. */
    tsaURL?: string | undefined;
    /** Digest the signature uses (default: 'sha256'). */
    signAlg?: string | undefined;
    log?: ((line: string) => void) | undefined;
}

/** A sigstore-backed `Signer`, with the identity it authenticated as. */
export interface SigstoreSigner extends Signer {
    kind: 'sigstore';
    identity: SigstoreIdentity;
}

export interface BundleVerification {
    identity?: string | undefined;
    issuer?: string | undefined;
    signedAt?: Date | undefined;
}

// The sigstore libraries are an optional dependency of *verification*: an
// archive signed against an ordinary CA verifies with nothing but `node:crypto`,
// and the mount path must not hard-fail because a signing-side package is
// absent. Loading is therefore lazy and its failure is a reported reason rather
// than a thrown error.
function load<T>(name: string): T {
    try {
        return require(name) as T;
    } catch (err) {
        throw Object.assign(new Error(
            `sigstore support needs '${name}' — install this package's dependencies`),
            { code: 'ERR_BUNDLE_SIGSTORE_UNAVAILABLE', cause: err });
    }
}

/** Whether the sigstore libraries needed for *verification* are loadable. */
export function available(): boolean {
    try {
        require.resolve('@sigstore/verify');
        require.resolve('@sigstore/bundle');
        require.resolve('@sigstore/protobuf-specs');
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- signing ---

/**
 * Phase one: authenticate, mint an ephemeral keypair, and get a Fulcio
 * certificate for it. Returns a signer whose `chain` can go straight into
 * `AUTHORITY.PEM` and whose `sign()` finishes the job once the hash exists.
 */
export async function signer(options: SigstoreSignerOptions = {}): Promise<SigstoreSigner> {
    const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    const signAlg = options.signAlg ?? 'sha256';

    const { token, flow } = await identityToken({ ...options, audience: FULCIO_AUDIENCE, log });
    const identity = describe(token);
    log(`  identity: ${identity.subject ?? '(unknown)'} (${identity.issuer ?? 'unknown issuer'}${flow === 'ci' ? ', CI' : ''})`);

    // The keypair never leaves this process and is discarded when it exits.
    // That is the point of the short certificate lifetime: there is no
    // long-lived signing key for anyone to steal later.
    const keypair = CRYPTO.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const chain = await certify(token, keypair, options.fulcioURL ?? DEFAULT_FULCIO_URL);
    log(`  certificate: ${chain.length} in chain, expires ${new CRYPTO.X509Certificate(chain[0]!).validTo}`);

    return {
        kind: 'sigstore',
        identity,
        // Leaf first, then the intermediates Fulcio returned — the same shape
        // `--chain` takes, so `AUTHORITY.PEM` looks identical either way and
        // `unzip` + `openssl x509` still tells you who signed it.
        chain: chain.join(''),
        signAlg,

        // Phase two. `digest` is the whole-file hash, already computed over an
        // archive built with the chain above.
        async sign(digest: Buffer) {
            const signature = CRYPTO.sign(signAlg, digest, keypair.privateKey);
            const bundle = await witness({
                artifact: digest,
                signature,
                certificate: chain[0]!,
                rekorURL: options.rekorURL ?? DEFAULT_REKOR_URL,
                tsaURL: options.tsaURL ?? DEFAULT_TSA_URL,
                log,
            });
            return {
                signature,
                fields: { [FIELD]: Buffer.from(JSON.stringify(bundle), 'utf-8').toString('base64') },
            };
        },
    };
}

// Exchange an OIDC token plus a public key for a certificate chain, PEM,
// leaf first. Fulcio's proof-of-possession is a signature over the token's
// subject claim, which is what ties the key to the identity.
async function certify(token: string, keypair: KeyPair, fulcioURL: string): Promise<string[]> {
    const subject = claims(token)['sub'];
    if (!subject) throw new Error('identity token carries no subject claim');

    const publicKey = keypair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const proof = CRYPTO.sign(null, Buffer.from(String(subject)), keypair.privateKey);

    const res = await fetch(`${fulcioURL.replace(/\/+$/, '')}/api/v2/signingCert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            credentials: { oidcIdentityToken: token },
            publicKeyRequest: {
                publicKey: { algorithm: 'ECDSA', content: publicKey },
                proofOfPossession: proof.toString('base64'),
            },
        }),
    });
    if (!res.ok) {
        throw new Error(`fulcio refused to issue a certificate: ${res.status} ${await res.text().catch(() => res.statusText)}`);
    }
    const body = await res.json() as FulcioResponse;
    // Fulcio answers with an embedded or a detached SCT depending on
    // configuration; the chain is in the same place either way.
    const certs = (body.signedCertificateEmbeddedSct ?? body.signedCertificateDetachedSct)?.chain?.certificates;
    if (!certs?.length) throw new Error('fulcio returned no certificate chain');
    return certs.map((pem) => (pem.endsWith('\n') ? pem : `${pem}\n`));
}

/** What `generateKeyPairSync('ec', …)` hands back. */
interface KeyPair {
    publicKey: CRYPTO.KeyObject;
    privateKey: CRYPTO.KeyObject;
}

interface FulcioResponse {
    signedCertificateEmbeddedSct?: { chain?: { certificates?: string[] } };
    signedCertificateDetachedSct?: { chain?: { certificates?: string[] } };
}

// Assemble the sigstore bundle and have it witnessed: logged in Rekor, and
// timestamped by the TSA. Either can be turned off, and a witness that fails is
// reported but does not sink the signature — the archive is still signed, it
// just verifies with less evidence about when.
async function witness({ artifact, signature, certificate, rekorURL, tsaURL, log }: {
    artifact: Buffer;
    signature: Buffer;
    certificate: string;
    rekorURL: string;
    tsaURL: string;
    log: (line: string) => void;
}): Promise<unknown> {
    const { toMessageSignatureBundle, bundleToJSON } = load<typeof SigstoreBundle>('@sigstore/bundle');
    const { RekorWitness, TSAWitness } = load<typeof SigstoreSign>('@sigstore/sign');

    // A message-signature bundle records the *digest* of what was signed, not
    // the bytes. What was signed here is already a hash — the archive's — so
    // this is a hash of a hash, and the verifier recomputes it the same way
    // from the same 32 bytes.
    const bundle = toMessageSignatureBundle({
        digest: CRYPTO.createHash('sha256').update(artifact).digest(),
        signature,
        certificate: derFromPEM(certificate),
    });

    const witnesses: [string, SigstoreSign.Witness][] = [];
    if (rekorURL) witnesses.push(['transparency log', new RekorWitness({ rekorBaseURL: rekorURL })]);
    if (tsaURL) witnesses.push(['timestamp authority', new TSAWitness({ tsaBaseURL: tsaURL })]);

    const tlogEntries: SigstoreBundle.TransparencyLogEntry[] = [];
    const rfc3161Timestamps: NonNullable<SigstoreSign.VerificationMaterial['rfc3161Timestamps']> = [];
    for (const [name, w] of witnesses) {
        try {
            const material = await w.testify(bundle.content, certificate);
            tlogEntries.push(...(material.tlogEntries ?? []));
            rfc3161Timestamps.push(...(material.rfc3161Timestamps ?? []));
            log(`  ${name}: recorded`);
        } catch (err) {
            log(`  ${name}: unavailable (${err instanceof Error ? err.message : String(err)})`);
        }
    }
    if (!tlogEntries.length && !rfc3161Timestamps.length) {
        throw new Error('no signing-time evidence could be obtained — a sigstore certificate ' +
            'expires in minutes, so an archive with neither a log entry nor a timestamp ' +
            'could never be verified again');
    }

    bundle.verificationMaterial.tlogEntries = tlogEntries;
    bundle.verificationMaterial.timestampVerificationData = { rfc3161Timestamps };
    return bundleToJSON(bundle);
}

/** The DER bytes of a PEM certificate — what the bundle format carries. */
function derFromPEM(pem: string): Buffer {
    const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    return Buffer.from(body, 'base64');
}

// ------------------------------------------------------------ verification ---

/**
 * Verify a sigstore bundle over `artifact` (the whole-file hash bytes) and
 * return the identity it establishes. Synchronous, because the mount path is:
 * `provider.ts` decides whether to serve an archive before any of the program
 * in it runs, and cannot await.
 *
 * Throws on a bundle that does not verify. `trustedRoot` must be supplied —
 * this deliberately does not reach for the network.
 */
export function verifyBundle(
    encoded: string,
    artifact: Buffer,
    { trustedRoot, identity, issuer }: {
        trustedRoot: SigstoreSpecs.TrustedRoot;
        identity?: string | undefined;
        issuer?: string | undefined;
    },
): BundleVerification {
    const { bundleFromJSON } = load<typeof SigstoreBundle>('@sigstore/bundle');
    const { Verifier, toTrustMaterial, toSignedEntity } = load<typeof SigstoreVerify>('@sigstore/verify');

    const bundle = bundleFromJSON(JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')));
    const entity = toSignedEntity(bundle, artifact);
    const verifier = new Verifier(toTrustMaterial(trustedRoot));

    // A policy of `undefined` still verifies the chain, the log entry and the
    // signing time; it only skips the "and it must be *this* identity" check,
    // which is the caller's to impose.
    const policy = identity || issuer
        ? { ...(identity ? { subjectAlternativeName: identity } : {}), ...(issuer ? { extensions: { issuer } } : {}) }
        : undefined;
    const signer = verifier.verify(entity, policy);

    return {
        identity: signer.identity?.subjectAlternativeName,
        issuer: signer.identity?.extensions?.issuer,
        signedAt: signingTime(bundle),
    };
}

/**
 * The leaf certificate a sigstore bundle carries, as an X509Certificate — so a
 * verifier can confirm the inspectable `AUTHORITY.PEM` names the same
 * certificate the bundle was actually verified against.
 */
export function bundleCertificate(encoded: string): CRYPTO.X509Certificate | null {
    const { bundleFromJSON } = load<typeof SigstoreBundle>('@sigstore/bundle');
    const bundle = bundleFromJSON(JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')));
    const content = bundle.verificationMaterial?.content;
    const der = content?.$case === 'certificate' ? content.certificate.rawBytes
        : content?.$case === 'x509CertificateChain' ? content.x509CertificateChain.certificates[0]?.rawBytes
        : undefined;
    return der ? new CRYPTO.X509Certificate(Buffer.from(der)) : null;
}

// When the signature was witnessed, as a Date — the log entry's integrated time
// if there is one. Reported for the record; `Verifier` has already used the
// same material to decide the certificate was in date.
function signingTime(bundle: SigstoreBundle.Bundle): Date | undefined {
    const seconds = bundle.verificationMaterial?.tlogEntries?.[0]?.integratedTime;
    return seconds ? new Date(Number(seconds) * 1000) : undefined;
}

// ------------------------------------------------------------- trust root ---

/**
 * Where the sigstore trust root would be read from, in the order tried:
 * an explicit path, `BUNDLE_SIGSTORE_ROOT`, the cache `bundle trust` maintains,
 * and finally the seed `@sigstore/tuf` ships. Returns null when none exists.
 *
 * The seed is the fallback rather than the first choice because it is frozen at
 * the version of the library that was installed; `bundle trust` fetches the
 * live one over TUF and that copy wins whenever it is present.
 */
export function trustedRootLocation(source?: string | undefined): TrustedRootLocation | null {
    if (source) return { origin: 'explicit', path: source };
    const fromEnv = process.env['BUNDLE_SIGSTORE_ROOT'];
    if (fromEnv) return { origin: 'environment', path: fromEnv };
    const cached = cachedRootPath();
    if (cached && FS.existsSync(cached)) return { origin: 'cache', path: cached };
    if (seedRootPath()) return { origin: 'seed', path: DEFAULT_TUF_MIRROR };
    return null;
}

/**
 * Load the sigstore trust root synchronously. Returns null when there is none —
 * verification then reports that as a reason rather than failing, because
 * "I could not check" and "this is forged" are different answers.
 */
export function trustedRootSync(source?: string | undefined): SigstoreSpecs.TrustedRoot | null {
    const where = trustedRootLocation(source);
    if (!where) return null;
    try {
        const { TrustedRoot } = load<typeof SigstoreSpecs>('@sigstore/protobuf-specs');
        const json = where.origin === 'seed'
            ? seedTrustedRootJSON(where.path)
            : JSON.parse(FS.readFileSync(where.path, 'utf-8')) as unknown;
        return json ? TrustedRoot.fromJSON(json) : null;
    } catch {
        return null;
    }
}

/**
 * Refresh the trust root over the network, through TUF — signed metadata with
 * its own root of trust, not a plain download. Returns the cache path.
 */
export async function refreshTrustedRoot({ mirror = DEFAULT_TUF_MIRROR, force = true }: {
    mirror?: string | undefined;
    force?: boolean | undefined;
} = {}): Promise<string> {
    const { getTrustedRoot } = load<typeof SigstoreTuf>('@sigstore/tuf');
    await getTrustedRoot({ mirrorURL: mirror, force });
    return cachedRootPath(mirror);
}

/**
 * Where `@sigstore/tuf` keeps the target it downloaded. Mirrors its own
 * `appDataPath()` so the two agree without depending on a private export.
 */
export function cachedRootPath(mirror: string = DEFAULT_TUF_MIRROR): string {
    const home = OS.homedir();
    const base = process.platform === 'darwin' ? PATH.join(home, 'Library', 'Application Support', 'sigstore-js')
        : process.platform === 'win32' ? PATH.join(process.env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local'), 'sigstore-js', 'Data')
        : PATH.join(process.env['XDG_DATA_HOME'] || PATH.join(home, '.local', 'share'), 'sigstore-js');
    return PATH.join(base, new URL(mirror).host, 'targets', 'trusted_root.json');
}

// The trust root `@sigstore/tuf` ships alongside its own TUF root, so a machine
// that has never run `bundle trust` can still check a sigstore signature
// offline. It is only ever the fallback; a refreshed cache takes precedence.
function seedRootPath(): string | null {
    try {
        return require.resolve('@sigstore/tuf/seeds.json');
    } catch {
        try {
            return PATH.join(PATH.dirname(require.resolve('@sigstore/tuf')), '..', 'seeds.json');
        } catch {
            return null;
        }
    }
}

function seedTrustedRootJSON(mirror: string): unknown {
    const path = seedRootPath();
    if (!path || !FS.existsSync(path)) return null;
    const seeds = JSON.parse(FS.readFileSync(path, 'utf-8')) as Record<string, { targets?: Record<string, string> }>;
    const encoded = seeds[mirror]?.targets?.['trusted_root.json'];
    return encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')) : null;
}

// ------------------------------------------------------------------ tokens ---

// A JWT's payload. Unverified — Fulcio is what validates the token; this is
// only ever used to show the user which identity is about to be certified.
function claims(token: string): Record<string, unknown> {
    try {
        return JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf-8')) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function describe(token: string): SigstoreIdentity {
    const c = claims(token);
    const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
    return {
        subject: str(c['email']) ?? str(c['sub']),
        issuer: str(c['iss']),
        // GitHub Actions tokens name the workflow that ran; that is the part
        // worth showing, since it is the identity a release artifact carries.
        workflow: str(c['workflow_ref']) ?? str(c['job_workflow_ref']),
    };
}
