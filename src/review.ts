import { verifyBundleSync } from './api.ts';
import { wholeFileHash, type VerificationResult, type VerificationState } from './manifest.ts';
import { cached, cachedFor, formatAttester, type Attester, type Verdict } from './attestation.ts';
import type { NetworkOptions } from './atproto.ts';
import type { Policy, Signer } from './policy.ts';

// Deciding whether to accept an archive someone is about to install or update.
//
// Verification answers "are these bytes genuine, and who stands behind them?".
// Installing asks a different question — "do *I* accept whoever that is?" — and
// the answer is not the same for every version of the same program. A publisher
// moves their releases to another CI; an auditor reviews one version and not
// the next; somebody who rebuilt it from source vouches for it a week later. If
// every such change were a refusal, nothing would ever update. So:
//
//   * **Evidence** is everything found: the archive's signature, if it has one,
//     and every attestation of its hash — from attesters this machine knows
//     about, and from anyone the backlink index says has attested it.
//   * **Requirements** are what must hold, and only command-line flags and the
//     policy file make them. Not meeting one is a refusal. So is a bad verdict
//     from an attester the policy blocks on, and so — always — is an archive
//     whose bytes or signature do not verify.
//   * Evidence is **known** when it comes from someone already accepted for
//     this install, trusted by the policy, demanded by a flag, or — for a
//     certificate — anchored in the trust store. Known evidence proceeds.
//   * Otherwise a person is **asked**, shown everything that was found. Also
//     asked: anyone about to accept an archive that someone they trust has
//     marked bad.
//
// Nothing here prompts; it produces the review, and the caller asks.

/** One thing that vouches for — or warns against — an archive. */
export type Evidence =
    | { type: 'signature'; identity: string; issuer: string; signedAt?: Date | undefined }
    | { type: 'certificate'; subject: string; anchor: string; anchored: boolean }
    | { type: 'attestation'; did: string; handle?: string | undefined; kind?: string | undefined; verdict: Verdict; createdAt?: string | undefined };

/** Who has been accepted for an install, across all its versions so far. */
export interface Accepted {
    signers: Signer[];
    /** Certificate-chain root fingerprints. */
    certificates: string[];
    /** Attester DIDs. */
    attesters: string[];
}

/** What was found for an archive. */
export interface Gathered {
    hashAlg: string;
    hash: string;
    result: VerificationResult;
    evidence: Evidence[];
    /** What could not be checked, and why — shown, never decisive. */
    notes: string[];
}

export interface GatherOptions {
    /** Extra trusted roots, as PEM text or paths to PEM files. */
    roots?: string[] | undefined;
    /** DIDs to ask about this archive, whatever discovery finds. */
    candidates?: string[] | undefined;
    /** The backlink index to discover attesters through, or false. */
    discovery?: string | false | undefined;
    /** DIDs whose attestations are not looked at. */
    ignore?: string[] | undefined;
    /** How stale a cached proof may be (for the offline `gatherSync`). */
    maxAge?: number | undefined;
    /**
     * Also look at every attester the cache holds a proof from for this hash —
     * whoever was found when it was installed, or by a refresh since — so a
     * warning seen once is not forgotten offline.
     */
    everyCached?: boolean | undefined;
    network?: NetworkOptions | undefined;
}

/** One line of a review: a piece of evidence, and what is known about it. */
export interface ReviewItem {
    evidence: Evidence;
    /** Why it is accepted without asking, if it is. */
    known?: string | undefined;
    /** Why it cannot count at all, if it cannot. */
    excluded?: string | undefined;
}

/** What a caller decides on. */
export interface Review {
    hashAlg: string;
    hash: string;
    signed: boolean;
    items: ReviewItem[];
    /** Requirements that do not hold. Any of these refuses the archive. */
    unmet: string[];
    /** Bad verdicts from blocking attesters. Any of these refuses the archive. */
    blocked: string[];
    /** Bad verdicts from attesters already trusted or accepted. These force a question. */
    alarms: string[];
    notes: string[];
    decision: 'proceed' | 'ask' | 'refuse';
    reason: string;
    /** The verification state a refusal corresponds to. */
    state: VerificationState;
}

/** What the command line demanded, on top of the policy. */
export interface Demands {
    identity?: string | undefined;
    issuer?: string | undefined;
    attesters?: Attester[] | undefined;
    quorum?: number | undefined;
    block?: Attester[] | undefined;
}

// --------------------------------------------------------------- gathering ---

/**
 * Find everything that vouches for `bytes`: verify the archive, ask the index
 * who has attested its hash, and fetch every candidate's attestation into the
 * cache. Throws on an archive that does not verify.
 */
export async function gather(bytes: Buffer, options: GatherOptions = {}): Promise<Gathered> {
    const hashed = wholeFileHash(bytes);
    if (!hashed) throw refusal('invalid', 'this is not an archive with a manifest');
    const notes: string[] = [];
    const ignore = new Set(options.ignore ?? []);
    const dids = new Set((options.candidates ?? []).filter((did) => !ignore.has(did)));

    const ATPROTO = await import('./atproto.ts');
    if (options.discovery) {
        try {
            for (const did of await ATPROTO.discover(hashed.hashAlg, hashed.hash, { ...options.network, index: options.discovery })) {
                if (!ignore.has(did)) dids.add(did);
            }
        } catch (err) {
            notes.push(`could not ask ${options.discovery} who has attested it: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const attesters = [...dids].map((did) => ({ did }));
    for (const problem of await ATPROTO.refreshFor(attesters, hashed.hashAlg, hashed.hash, options.network)) {
        notes.push(`could not fetch an attestation: ${problem}`);
    }
    return gatherSync(bytes, { ...options, candidates: [...dids] }, notes);
}

/** The offline half of `gather`: the archive, and what the cache holds for the candidates. */
export function gatherSync(bytes: Buffer, options: GatherOptions = {}, notes: string[] = []): Gathered {
    const result = verifyBundleSync(bytes, { roots: options.roots ?? [], deep: true, integrity: true });
    if (result.state === 'invalid') throw refusal('invalid', result.reason);
    const hashAlg = result.hashAlg ?? 'sha256';
    const hash = result.hash!;

    const evidence: Evidence[] = [];
    if (result.sigstore) {
        if (result.identity && result.issuer) {
            evidence.push({ type: 'signature', identity: result.identity, issuer: result.issuer, signedAt: result.signedAt });
        } else {
            notes.push(`the sigstore signature could not be checked: ${result.reason}`);
        }
    } else if (result.signed && result.anchor) {
        evidence.push({ type: 'certificate', subject: result.subject ?? '(no subject)', anchor: result.anchor, anchored: result.state === 'valid' });
    }

    const ignore = new Set(options.ignore ?? []);
    const dids = new Set([...(options.candidates ?? []), ...(options.everyCached ? cachedFor(hash) : [])]);
    for (const did of dids) {
        if (ignore.has(did)) continue;
        const found = cached(did, hashAlg, hash, { maxAge: options.maxAge });
        if (!found) continue;
        evidence.push({ type: 'attestation', did, handle: found.handle, kind: found.attested, verdict: found.verdict ?? 'good', createdAt: found.createdAt });
    }
    return { hashAlg, hash, result, evidence, notes };
}

// ---------------------------------------------------------------- judging ---

/** Weigh what was gathered against the policy, the flags, and what was accepted before. */
export function judge(gathered: Gathered, { policy, demands = {}, accepted = noneAccepted(), trust = [], previousIssuer }: {
    policy: Policy;
    demands?: Demands | undefined;
    accepted?: Accepted | undefined;
    /** Signers trusted for this install on top of the policy — this package's own, for itself. */
    trust?: Signer[] | undefined;
    /** The issuer the version being replaced was signed through, for `sameIssuer`. */
    previousIssuer?: string | undefined;
}): Review {
    const blocking = new Set([...policy.block, ...(demands.block ?? [])].map(({ did }) => did));
    const requiredAttesters = [
        ...policy.attesters.map(({ attesters }) => attesters).flat(),
        ...(demands.attesters ?? []),
    ];
    const trustedSigners = [...policy.trust.signers, ...trust];
    const unmet: string[] = [];
    const blocked: string[] = [];
    const alarms: string[] = [];

    const items: ReviewItem[] = gathered.evidence.map((evidence) => {
        switch (evidence.type) {
            case 'signature': {
                const refusedBy = policy.issuers.find(({ list }) => !list.includes(evidence.issuer));
                if (refusedBy) return { evidence, excluded: `${evidence.issuer} is not an issuer ${refusedBy.source} accepts` };
                const demanded = (demands.identity || demands.issuer)
                    && (!demands.identity || demands.identity === evidence.identity)
                    && (!demands.issuer || demands.issuer === evidence.issuer);
                const known = demanded ? 'required'
                    : trustedSigners.some((signer) => sameSigner(signer, evidence)) ? 'trusted by policy'
                    : accepted.signers.some((signer) => sameSigner(signer, evidence)) ? 'accepted before'
                    : undefined;
                return { evidence, known };
            }
            case 'certificate': {
                const known = evidence.anchored ? 'anchored in the trust store'
                    : policy.trust.certificates.includes(evidence.anchor) ? 'trusted by policy'
                    : accepted.certificates.includes(evidence.anchor) ? 'accepted before'
                    : undefined;
                return { evidence, known };
            }
            case 'attestation': {
                const who = describeAttester(evidence);
                const trusted = requiredAttesters.some(({ did }) => did === evidence.did)
                    || policy.trust.attesters.some(({ did }) => did === evidence.did)
                    || accepted.attesters.includes(evidence.did);
                if (evidence.verdict === 'bad') {
                    if (blocking.has(evidence.did)) blocked.push(who);
                    else if (trusted) alarms.push(who);
                    return { evidence, excluded: 'marked it bad' };
                }
                const matches = (list: Attester[]) => list.some(({ did, kind }) => did === evidence.did && (!kind || kind === evidence.kind));
                const known = matches(requiredAttesters) ? 'required'
                    : matches(policy.trust.attesters) ? 'trusted by policy'
                    : accepted.attesters.includes(evidence.did) ? 'accepted before'
                    : undefined;
                return { evidence, known };
            }
        }
    });

    // Requirements: only flags and the policy make these.
    const counted = items.filter((item) => !item.excluded);
    const signatures = counted.filter((item) => item.evidence.type === 'signature').map((item) => item.evidence as Extract<Evidence, { type: 'signature' }>);
    if (demands.identity || demands.issuer) {
        const ok = signatures.some((each) => (!demands.identity || demands.identity === each.identity) && (!demands.issuer || demands.issuer === each.issuer));
        if (!ok) {
            const wanted = `${demands.identity ?? 'any identity'} via ${demands.issuer ?? 'any issuer'}`;
            unmet.push(`a signature by ${wanted} is required, and ${signatures.length ? `it is signed by ${signatures.map((each) => each.identity).join(', ')}` : 'it carries no sigstore signature'}`);
        }
    }
    if (policy.signature.length && !counted.some((item) => item.evidence.type !== 'attestation')) {
        unmet.push(`${policy.signature[0]} requires a signature, and it carries none that counts`);
    }
    if (policy.sameIssuer.length && previousIssuer && !signatures.some((each) => each.issuer === previousIssuer)) {
        unmet.push(`${policy.sameIssuer[0]} requires updates to be signed through ${previousIssuer} again, and this one is not`);
    }
    const clauses = [...policy.attesters];
    if (demands.attesters?.length) clauses.push({ attesters: demands.attesters, quorum: demands.quorum, source: 'the command line' });
    const good = counted.filter((item) => item.evidence.type === 'attestation').map((item) => item.evidence as Extract<Evidence, { type: 'attestation' }>);
    for (const { attesters, quorum, source } of clauses) {
        const have = attesters.filter(({ did, kind }) => good.some((each) => each.did === did && (!kind || kind === each.kind)));
        const needed = Math.min(quorum ?? attesters.length, attesters.length);
        if (have.length < needed) {
            const missing = attesters.filter((each) => !have.includes(each)).map(formatAttester);
            unmet.push(`${source} requires ${needed === attesters.length ? 'attestations from' : `${needed} of`} ${attesters.map(formatAttester).join(', ')}; missing ${missing.join(', ')}`);
        }
    }

    const base = { hashAlg: gathered.hashAlg, hash: gathered.hash, signed: Boolean(gathered.result.signed), items, unmet, blocked, alarms, notes: gathered.notes };
    if (blocked.length) {
        return { ...base, decision: 'refuse', state: 'invalid', reason: `marked bad by ${blocked.join(', ')}, which this machine blocks on` };
    }
    if (unmet.length) {
        return { ...base, decision: 'refuse', state: base.signed ? 'valid-untrusted' : 'unsigned', reason: unmet.join('; ') };
    }
    const selectable = counted;
    if (!selectable.length) {
        return { ...base, decision: 'refuse', state: base.signed ? 'valid-untrusted' : 'unsigned', reason: 'nothing that can be checked vouches for it' };
    }
    if (alarms.length) {
        return { ...base, decision: 'ask', state: 'valid-untrusted', reason: `marked bad by ${alarms.join(', ')}, whom you trust` };
    }
    const known = selectable.filter((item) => item.known);
    if (known.length) {
        return { ...base, decision: 'proceed', state: 'valid', reason: `vouched for by ${known.map((item) => describe(item.evidence)).join(', ')}` };
    }
    return { ...base, decision: 'ask', state: 'valid-untrusted', reason: 'nobody accepted for it before vouches for this version' };
}

/** What a review's selectable items are: everything that counts. */
export function selectable(review: Review): ReviewItem[] {
    return review.items.filter((item) => !item.excluded);
}

/** Add what was accepted now to what was accepted before. */
export function accept(previous: Accepted, chosen: ReviewItem[]): Accepted {
    const next: Accepted = {
        signers: [...previous.signers],
        certificates: [...previous.certificates],
        attesters: [...previous.attesters],
    };
    for (const { evidence } of chosen) {
        if (evidence.type === 'signature' && !next.signers.some((signer) => sameSigner(signer, evidence))) {
            next.signers.push({ identity: evidence.identity, issuer: evidence.issuer });
        }
        if (evidence.type === 'certificate' && !next.certificates.includes(evidence.anchor)) next.certificates.push(evidence.anchor);
        if (evidence.type === 'attestation' && evidence.verdict === 'good' && !next.attesters.includes(evidence.did)) next.attesters.push(evidence.did);
    }
    return next;
}

export function noneAccepted(): Accepted {
    return { signers: [], certificates: [], attesters: [] };
}

/** One line for a piece of evidence. */
export function describe(evidence: Evidence): string {
    switch (evidence.type) {
        case 'signature': return `${evidence.identity} via ${evidence.issuer}`;
        case 'certificate': return `${evidence.subject.replace(/\n/g, ', ')}${evidence.anchored ? '' : ' (not anchored)'}`;
        case 'attestation': return `${describeAttester(evidence)}${evidence.kind ? ` as ${evidence.kind}` : ''}`;
    }
}

function describeAttester(evidence: { did: string; handle?: string | undefined }): string {
    return evidence.handle ? `${evidence.handle} (${evidence.did})` : evidence.did;
}

function sameSigner(a: Signer, b: { identity: string; issuer: string }): boolean {
    return a.identity === b.identity && a.issuer === b.issuer;
}

/** An install refused, with the state it corresponds to. */
export function refusal(state: VerificationState, reason: string, review?: Review): Error {
    return Object.assign(new Error(reason), { code: 'ERR_BUNDLE_UNTRUSTED', state, review });
}
