import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import {
    CID, decode, encode, readCar, writeCar, verifyRecordProof, signingKey, formatMultikey, sign, verifySignature,
    pointKey, compressedPoint, type Curve, type DidDocument, type Value,
} from '../src/repo.ts';
import { COLLECTION, parseAttester, parseDuration, readProof, writeProof, type Attester } from '../src/attestation.ts';
import * as ATPROTO from '../src/atproto.ts';
import { verifySync, wholeFileHash, STATES } from '../src/manifest.ts';
import { open as openBundle } from '../src/provider.ts';
import { main as launchMain } from '../src/launch.ts';
import { main, UNDECIDED } from '../src/cli.ts';
import { install, update, installed, records, warningsOf } from '../src/install.ts';
import { selectable, type Review } from '../src/review.ts';
import { loadPolicy } from '../src/policy.ts';
import { oauthLogin } from '../src/oauth.ts';
import { lexicons, authorityOf, checkLexicons, publishLexicons, SCHEMA_COLLECTION } from '../src/lexicon.ts';
import { APP, ROOT, build, collector, mount, scratch, tree } from './helpers.ts';

// Attestations: proofs checked with nothing but node:crypto, a policy checked
// against a cache, and the commands that fill it.
//
// The repository-proof code is tested against real bytes from a production PDS
// (test/fixtures/atproto) — the part where agreeing with ourselves would prove
// nothing — and everything else against a fake PDS built here with the same
// code, which signs real commits over a real (flat) Merkle Search Tree.

const FIXTURES = PATH.join(ROOT, 'test', 'fixtures', 'atproto');
const tmp = scratch('atproto');
const CACHE = PATH.join(tmp, 'cache');
process.env['BUNDLE_ATTESTATIONS'] = CACHE;
process.env['BUNDLE_PLC_DIRECTORY'] = 'https://plc.test';
process.env['BUNDLE_INSTALL_DIR'] = PATH.join(tmp, 'bin');
process.env['XDG_STATE_HOME'] = PATH.join(tmp, 'state');
process.env['BUNDLE_NO_WINDOWS_SETUP'] = '1';
delete process.env['BUNDLE_ATTESTERS'];
// Discovery goes to the fake index below; no machine policy.
const POLICY_FILE = PATH.join(tmp, 'policy.json');
process.env['BUNDLE_SYSTEM_POLICY'] = PATH.join(tmp, 'no-system-policy.json');
process.env['BUNDLE_POLICY'] = POLICY_FILE;
function writePolicy(policy: Record<string, unknown>): void {
    FS.writeFileSync(POLICY_FILE, JSON.stringify({ discovery: 'https://index.test', ...policy }));
}
writePolicy({});
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

// ------------------------------------------------------------- a fake PDS ---

let accounts = 0;

/** One account on its own PDS: a key, a DID document, and a repository. */
class Account {
    readonly did: string;
    readonly handle: string;
    readonly pds: string;
    readonly password = 'app-password';
    readonly curve: Curve;
    private privateKey: CRYPTO.KeyObject;
    private publicKey: CRYPTO.KeyObject;
    readonly records = new Map<string, Value>();
    private revision = 0;

    constructor(curve: Curve = 'secp256k1') {
        const n = ++accounts;
        const suffix = [...String(n)].map((digit) => 'abcdefghij'[Number(digit)]).join('');
        this.did = `did:plc:${suffix.padStart(24, 'z')}`;
        this.handle = `attester${n}.test`;
        this.pds = `https://pds${n}.test`;
        this.curve = curve;
        const pair = CRYPTO.generateKeyPairSync('ec', { namedCurve: curve === 'P-256' ? 'prime256v1' : 'secp256k1' });
        this.privateKey = pair.privateKey;
        this.publicKey = pair.publicKey;
    }

    doc(): DidDocument {
        return {
            id: this.did,
            alsoKnownAs: [`at://${this.handle}`],
            verificationMethod: [{
                id: `${this.did}#atproto`, type: 'Multikey', controller: this.did,
                publicKeyMultibase: formatMultikey(this.curve, this.publicKey),
            }],
            service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: this.pds }],
        };
    }

    /** The CAR `sync.getRecord` answers with — a proof of presence or of absence. */
    proof(collection: string, rkey: string, { signWith }: { signWith?: CRYPTO.KeyObject } = {}): Buffer {
        const blocks: [CID, Buffer][] = [];
        const entries = [...this.records.entries()]
            .map(([key, value]) => {
                const bytes = encode(value);
                const cid = CID.of(bytes);
                if (key === `${collection}/${rkey}`) blocks.push([cid, bytes]);
                return [Buffer.from(key), cid] as const;
            })
            .sort(([a], [b]) => Buffer.compare(a, b));
        const node = encode({ l: null, e: entries.map(([k, v]) => ({ p: 0, k, v, t: null })) });
        const commit = { did: this.did, version: 3, data: CID.of(node), rev: `3l${String(++this.revision).padStart(11, '2')}`, prev: null };
        const signed = encode({ ...commit, sig: sign(this.curve, signWith ?? this.privateKey, encode(commit)) });
        const root = CID.of(signed);
        return writeCar([root], [[root, signed], [CID.of(node), node], ...blocks]);
    }

    rotate(): void {
        const pair = CRYPTO.generateKeyPairSync('ec', { namedCurve: this.curve === 'P-256' ? 'prime256v1' : 'secp256k1' });
        this.privateKey = pair.privateKey;
        this.publicKey = pair.publicKey;
    }
}

const network: Account[] = [];
const requests: string[] = [];
let offline = false;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Everything the code under test fetches goes through here: the PLC directory,
// every account's PDS, and a download server for install.
const DOWNLOADS = new Map<string, Buffer>();

// An OAuth authorization server, as strict as atproto's: pushed requests only,
// PKCE, DPoP on every request with a nonce it insists on, tokens bound to the
// key that asked for them. The PDSes accept those tokens only with a proof
// from that same key, over that same token.
const AUTH = {
    origin: 'https://auth.test',
    nonce: 'as-nonce-1',
    pdsNonce: 'pds-nonce-1',
    rejectGranular: false,
    expired: new Set<string>(),
    lieAboutSub: false,
    wrongIssuer: false,
    pushed: [] as string[],
    refreshes: 0,
    requests: new Map<string, { params: URLSearchParams; jkt: string }>(),
    codes: new Map<string, { params: URLSearchParams; jkt: string }>(),
    tokens: new Map<string, { did: string; jkt: string }>(),
    refreshTokens: new Map<string, { did: string; jkt: string; scope: string; clientId: string }>(),
};
const realFetch = globalThis.fetch;

/** Check a DPoP proof; returns the key's thumbprint, 'nonce' when it lacks the current nonce, or throws. */
function checkDpop(proof: string | undefined, method: string, url: URL, nonce: string, token?: string): string {
    assert.ok(proof, 'a DPoP proof on every request');
    const [h, p, sig] = proof.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString()) as { typ: string; alg: string; jwk: CRYPTO.webcrypto.JsonWebKey };
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    assert.equal(header.typ, 'dpop+jwt');
    assert.equal(header.alg, 'ES256');
    const key = CRYPTO.createPublicKey({ format: 'jwk', key: header.jwk });
    assert.ok(CRYPTO.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')), 'proof signature');
    assert.equal(payload['htm'], method);
    assert.equal(payload['htu'], `${url.origin}${url.pathname}`);
    assert.equal(typeof payload['jti'], 'string');
    if (token) assert.equal(payload['ath'], CRYPTO.createHash('sha256').update(token).digest('base64url'), 'ath binds the proof to the token');
    if (payload['nonce'] !== nonce) return 'nonce';
    const { crv, kty, x, y } = header.jwk;
    return CRYPTO.createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('base64url');
}

function authorizationServer(url: URL, init: RequestInit | undefined): Response {
    const headers = init?.headers as Record<string, string> | undefined;
    const form = new URLSearchParams(String(init?.body ?? ''));
    const needNonce = () => new Response(JSON.stringify({ error: 'use_dpop_nonce' }),
        { status: 400, headers: { 'content-type': 'application/json', 'dpop-nonce': AUTH.nonce } });
    switch (url.pathname) {
        case '/.well-known/oauth-authorization-server':
            return json({
                issuer: AUTH.origin,
                authorization_endpoint: `${AUTH.origin}/oauth/authorize`,
                token_endpoint: `${AUTH.origin}/oauth/token`,
                pushed_authorization_request_endpoint: `${AUTH.origin}/oauth/par`,
                revocation_endpoint: `${AUTH.origin}/oauth/revoke`,
                require_pushed_authorization_requests: true,
                code_challenge_methods_supported: ['S256'],
                dpop_signing_alg_values_supported: ['ES256'],
            });
        case '/oauth/par': {
            const jkt = checkDpop(headers?.['dpop'], 'POST', url, AUTH.nonce);
            if (jkt === 'nonce') return needNonce();
            const scope = form.get('scope')!;
            AUTH.pushed.push(scope);
            if (AUTH.rejectGranular && scope.includes('repo:')) return json({ error: 'invalid_scope', error_description: 'unknown scope' }, 400);
            assert.equal(form.get('code_challenge_method'), 'S256');
            assert.equal(form.get('response_type'), 'code');
            const uri = `urn:ietf:params:oauth:request_uri:${CRYPTO.randomUUID()}`;
            AUTH.requests.set(uri, { params: form, jkt });
            return json({ request_uri: uri, expires_in: 299 }, 201);
        }
        case '/oauth/authorize': {
            // What the browser would end up at once the person signs in and
            // approves: the redirect back to the client.
            const request = AUTH.requests.get(url.searchParams.get('request_uri')!);
            assert.ok(request, 'the browser carries a pushed request');
            assert.equal(url.searchParams.get('client_id'), request.params.get('client_id'));
            const code = CRYPTO.randomUUID();
            AUTH.codes.set(code, request);
            const back = new URL(request.params.get('redirect_uri')!);
            back.search = new URLSearchParams({ code, state: request.params.get('state')!, iss: AUTH.wrongIssuer ? 'https://evil.test' : AUTH.origin }).toString();
            return json({ location: back.toString() });
        }
        case '/oauth/token': {
            const jkt = checkDpop(headers?.['dpop'], 'POST', url, AUTH.nonce);
            if (jkt === 'nonce') return needNonce();
            const issue = (did: string, scope: string, clientId: string) => {
                const access = `at-${CRYPTO.randomUUID()}`;
                const refresh = `rt-${CRYPTO.randomUUID()}`;
                AUTH.tokens.set(access, { did, jkt });
                AUTH.refreshTokens.set(refresh, { did, jkt, scope, clientId });
                const sub = AUTH.lieAboutSub ? network.find((each) => each.did !== did)!.did : did;
                return json({ access_token: access, token_type: 'DPoP', sub, scope, refresh_token: refresh, expires_in: 300 });
            };
            if (form.get('grant_type') === 'refresh_token') {
                const known = AUTH.refreshTokens.get(form.get('refresh_token')!);
                if (!known || known.jkt !== jkt) return json({ error: 'invalid_grant' }, 400);
                AUTH.refreshTokens.delete(form.get('refresh_token')!); // single use
                AUTH.refreshes++;
                return issue(known.did, known.scope, known.clientId);
            }
            const granted = AUTH.codes.get(form.get('code')!);
            if (!granted) return json({ error: 'invalid_grant' }, 400);
            AUTH.codes.delete(form.get('code')!);
            assert.equal(jkt, granted.jkt, 'the token is asked for with the key that pushed the request');
            assert.equal(CRYPTO.createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), granted.params.get('code_challenge'), 'PKCE');
            assert.equal(form.get('redirect_uri'), granted.params.get('redirect_uri'));
            assert.equal(form.get('client_id'), granted.params.get('client_id'));
            const hint = granted.params.get('login_hint')!;
            const who = network.find((each) => each.did === hint || each.handle === hint)!;
            return issue(who.did, granted.params.get('scope')!, form.get('client_id')!);
        }
        case '/oauth/revoke':
            AUTH.refreshTokens.delete(form.get('token')!);
            return json({});
        default:
            return json({ error: 'not found' }, 404);
    }
}

/** What a browser does: follow the authorization URL, and land on the loopback redirect. */
function browser(url: string): void {
    void (async () => {
        const { location } = await (await fetch(url)).json() as { location: string };
        await realFetch(location);
    })();
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    if (offline) throw new TypeError('fetch failed');
    if (url.origin === 'https://dl.test') {
        const bytes = DOWNLOADS.get(url.pathname);
        return bytes ? new Response(bytes) : new Response('not found', { status: 404 });
    }
    // Constellation, as far as attestations go: who has a record at the
    // canonical key whose `hash` field names the subject.
    if (url.origin === 'https://index.test' && url.pathname === '/xrpc/blue.microcosm.links.getBacklinks') {
        const subject = url.searchParams.get('subject')!;
        const records = network.flatMap((each) => [...each.records.entries()]
            .filter(([key, value]) => key.startsWith(`${COLLECTION}/`) && (value as { hash?: string }).hash === subject)
            .map(([key]) => ({ did: each.did, collection: COLLECTION, rkey: key.slice(COLLECTION.length + 1) })));
        return json({ total: records.length, records, cursor: null });
    }
    if (url.origin === AUTH.origin) return authorizationServer(url, init);
    if (url.origin === 'https://plc.test') {
        const account = network.find((each) => `/${encodeURIComponent(each.did)}` === url.pathname);
        return account ? json(account.doc()) : json({ message: 'DID not registered' }, 404);
    }
    const account = network.find((each) => each.pds === url.origin);
    if (!account) return new Response('no such host', { status: 502 });
    const params = url.searchParams;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = init?.headers as Record<string, string> | undefined;
    let authorized = headers?.['authorization'] === 'Bearer token';
    if (headers?.['authorization']?.startsWith('DPoP ')) {
        const token = headers['authorization'].slice('DPoP '.length);
        const jkt = checkDpop(headers['dpop'], init?.method ?? 'GET', url, AUTH.pdsNonce, token);
        if (jkt === 'nonce') {
            return new Response(JSON.stringify({ error: 'use_dpop_nonce' }), {
                status: 401, headers: { 'www-authenticate': 'DPoP error="use_dpop_nonce"', 'dpop-nonce': AUTH.pdsNonce },
            });
        }
        if (AUTH.expired.has(token)) {
            return new Response(JSON.stringify({ error: 'invalid_token' }), {
                status: 401, headers: { 'www-authenticate': 'DPoP error="invalid_token", error_description="expired"' },
            });
        }
        const bound = AUTH.tokens.get(token);
        authorized = Boolean(bound && bound.jkt === jkt && bound.did === account.did);
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
        return json({ resource: account.pds, authorization_servers: [AUTH.origin] });
    }

    switch (url.pathname) {
        case '/xrpc/com.atproto.sync.getRecord':
            return new Response(account.proof(params.get('collection')!, params.get('rkey')!),
                { headers: { 'content-type': 'application/vnd.ipld.car' } });
        case '/xrpc/com.atproto.repo.listRecords': {
            const prefix = `${params.get('collection')}/`;
            return json({
                records: [...account.records.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({
                    uri: `at://${account.did}/${key}`, cid: CID.of(encode(value)).toString(), value,
                })),
            });
        }
        case '/xrpc/com.atproto.server.createSession':
            if (body['identifier'] !== account.did || body['password'] !== account.password) {
                return json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, 401);
            }
            return json({ did: account.did, handle: account.handle, accessJwt: 'token' });
        case '/xrpc/com.atproto.repo.putRecord': {
            if (!authorized || body['repo'] !== account.did) return json({ error: 'AuthRequired' }, 401);
            const key = `${String(body['collection'])}/${String(body['rkey'])}`;
            account.records.set(key, body['record'] as Value);
            return json({ uri: `at://${account.did}/${key}`, cid: CID.of(encode(body['record'] as Value)).toString() });
        }
        case '/xrpc/com.atproto.repo.deleteRecord':
            if (!authorized) return json({ error: 'AuthRequired' }, 401);
            account.records.delete(`${String(body['collection'])}/${String(body['rkey'])}`);
            return json({});
        default:
            return json({ error: 'MethodNotImplemented' }, 501);
    }
}) as typeof fetch;

// Handles resolve through DNS in real life; here, through the same table.
const resolveTxt = async (name: string): Promise<string[][]> => {
    const account = network.find((each) => `_atproto.${each.handle}` === name);
    if (!account) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return [[`did=${account.did}`]];
};

function account(curve?: Curve): Account {
    const created = new Account(curve);
    network.push(created);
    return created;
}

async function attestAs(who: Account, archive: string, kind?: string, verdict?: 'good' | 'bad'): Promise<void> {
    const hashed = wholeFileHash(archive)!;
    const session = await ATPROTO.login(who.did, who.password);
    await ATPROTO.attest(session, { hashAlg: hashed.hashAlg, hex: hashed.hash, kind, verdict });
}

let versions = 0;
/** A fresh unsigned archive — a new version nobody has said anything about yet. */
async function version(): Promise<string> {
    const n = ++versions;
    const output = PATH.join(tmp, `v${n}.run`);
    await build(tree(tmp, { ...APP, 'greet.js': `export const greeting = 'v${n}';` }, `v${n}`), output, { signed: false });
    return output;
}

const source = tree(tmp);
const UNSIGNED = await build(source, PATH.join(tmp, 'unsigned.run'), { signed: false });
const SIGNED = await build(source, PATH.join(tmp, 'signed.nzip'));

// ------------------------------------------------------- real repository bytes ---

test('a real PDS proof of a record verifies, and says what the record is', () => {
    const doc = JSON.parse(FS.readFileSync(PATH.join(FIXTURES, 'bsky.did.json'), 'utf-8')) as DidDocument;
    const proof = verifyRecordProof(FS.readFileSync(PATH.join(FIXTURES, 'profile.car')), {
        did: doc.id, key: signingKey(doc), collection: 'app.bsky.actor.profile', rkey: 'self',
    });
    assert.equal(proof.did, doc.id);
    assert.ok(proof.record);
    assert.equal((proof.record.value as { $type: string }).$type, 'app.bsky.actor.profile');
    assert.equal(proof.commit.toString(), readCar(FS.readFileSync(PATH.join(FIXTURES, 'profile.car'))).roots[0]!.toString());
});

test('a real PDS proof of absence verifies as absence', () => {
    const doc = JSON.parse(FS.readFileSync(PATH.join(FIXTURES, 'bsky.did.json'), 'utf-8')) as DidDocument;
    const proof = verifyRecordProof(FS.readFileSync(PATH.join(FIXTURES, 'absent.car')), {
        did: doc.id, key: signingKey(doc), collection: COLLECTION, rkey: 'abc',
    });
    assert.equal(proof.record, null);
});

test('a real proof fails against another key, another DID, or one changed byte', () => {
    const doc = JSON.parse(FS.readFileSync(PATH.join(FIXTURES, 'bsky.did.json'), 'utf-8')) as DidDocument;
    const car = FS.readFileSync(PATH.join(FIXTURES, 'profile.car'));
    const args = { did: doc.id, key: signingKey(doc), collection: 'app.bsky.actor.profile', rkey: 'self' };

    const other = CRYPTO.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey;
    assert.throws(() => verifyRecordProof(car, { ...args, key: { curve: 'secp256k1', key: other } }), /signature does not verify/);
    assert.throws(() => verifyRecordProof(car, { ...args, did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' }), /not did:plc:a/);

    // Every byte of every block is covered by a CID; flip one near the end, in
    // whichever block that is.
    const flipped = Buffer.from(car);
    flipped[flipped.length - 5]! ^= 1;
    assert.throws(() => verifyRecordProof(flipped, args), /does not hash to its CID|signature does not verify/);
});

test('DAG-CBOR re-encodes a real commit to the bytes that were signed', () => {
    const { roots, blocks } = readCar(FS.readFileSync(PATH.join(FIXTURES, 'profile.car')));
    const bytes = blocks.get(roots[0]!.toString())!;
    assert.ok(encode(decode(bytes)).equals(bytes));
    assert.equal(CID.parse(roots[0]!.toString()).toString(), roots[0]!.toString());
});

test('keys round-trip through Multikey on both curves, and high-S signatures are refused', () => {
    for (const curve of ['secp256k1', 'P-256'] as const) {
        const { privateKey, publicKey } = CRYPTO.generateKeyPairSync('ec', { namedCurve: curve === 'P-256' ? 'prime256v1' : 'secp256k1' });
        const doc = { id: 'did:web:x.test', verificationMethod: [{ id: '#atproto', type: 'Multikey', publicKeyMultibase: formatMultikey(curve, publicKey) }] };
        const key = signingKey(doc);
        assert.equal(key.curve, curve);
        assert.ok(pointKey(curve, compressedPoint(publicKey)).equals(publicKey));

        const data = Buffer.from('commit bytes');
        const low = sign(curve, privateKey, data);
        assert.ok(verifySignature(key, data, low));
        // The other valid `s` for the same signature — same math, refused by rule.
        const order = curve === 'P-256'
            ? 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
            : 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
        const s = BigInt(`0x${low.subarray(32).toString('hex')}`);
        const high = Buffer.concat([low.subarray(0, 32), Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex')]);
        assert.ok(CRYPTO.verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, high));
        assert.equal(verifySignature(key, data, high), false);
    }
});

// ------------------------------------------------------------------ policy ---

test('attester specs and durations parse', () => {
    assert.deepEqual(parseAttester('audited@did:web:audit.example.com'), { subject: 'did:web:audit.example.com', kind: 'audited' });
    assert.deepEqual(parseAttester('alice.example.com'), { subject: 'alice.example.com', kind: undefined });
    assert.throws(() => parseAttester('audited@'), /names no attester/);
    assert.equal(parseDuration('7d'), 7 * 86400_000);
    assert.equal(parseDuration('90'), 90_000);
    assert.throws(() => parseDuration('soon'), /not a duration/);
});

// ---------------------------------------------------------- the whole flow ---

test('an unsigned archive is valid once the required attester vouches for it, and not before', async () => {
    const alice = account();
    const policy = { attesters: [{ did: alice.did }] };

    const before = verifySync(UNSIGNED, policy);
    assert.equal(before.state, 'unsigned');
    assert.match(before.reason, /0 of 1 required attestation/);
    assert.equal(before.hash, wholeFileHash(UNSIGNED)!.hash);

    await attestAs(alice, UNSIGNED, 'audited');
    const after = verifySync(UNSIGNED, policy);
    assert.equal(after.state, 'valid', after.reason);
    assert.equal(after.signed, false);
    assert.equal(after.attestations?.[0]?.attested, 'audited');
    assert.equal(after.attestations?.[0]?.handle, alice.handle);

    // Without a policy nothing about an unsigned archive changes.
    assert.equal(verifySync(UNSIGNED).state, 'unsigned');
});

test('the attestation is of these bytes: a changed archive is not attested', async () => {
    const alice = account();
    await attestAs(alice, UNSIGNED);
    const copy = PATH.join(tmp, 'changed.run');
    // The same members laid out again with one changed, so the archive stays
    // well-formed and only its hash moves.
    await build(tree(tmp, { ...APP, 'greet.js': "export const greeting = 'changed';" }, 'changed'), copy, { signed: false });
    const res = verifySync(copy, { attesters: [{ did: alice.did }] });
    assert.equal(res.state, 'unsigned');
    assert.match(res.reason, /no attestation of this file/);
});

test('a required kind must be the kind attested', async () => {
    const bob = account('P-256');
    await attestAs(bob, UNSIGNED, 'published');
    assert.equal(verifySync(UNSIGNED, { attesters: [{ did: bob.did, kind: 'published' }] }).state, 'valid');
    const wrong = verifySync(UNSIGNED, { attesters: [{ did: bob.did, kind: 'audited' }] });
    assert.equal(wrong.state, 'unsigned');
    assert.match(wrong.reason, /attested as 'published', and 'audited' is required/);
});

test('a quorum counts the attesters that vouched', async () => {
    const carol = account();
    const dave = account();
    await attestAs(carol, UNSIGNED);
    const attesters: Attester[] = [{ did: carol.did }, { did: dave.did }];
    assert.equal(verifySync(UNSIGNED, { attesters }).state, 'unsigned');
    assert.equal(verifySync(UNSIGNED, { attesters, quorum: 1 }).state, 'valid');
});

test('a cached proof older than the policy allows no longer counts', async () => {
    const erin = account();
    await attestAs(erin, UNSIGNED);
    const hex = wholeFileHash(UNSIGNED)!.hash;
    const cached = readProof(CACHE, erin.did, hex)!;
    writeProof(CACHE, erin.did, hex, { ...cached, checkedAt: new Date(Date.now() - 2 * 3600_000) });

    assert.equal(verifySync(UNSIGNED, { attesters: [{ did: erin.did }], maxAge: parseDuration('3h') }).state, 'valid');
    const stale = verifySync(UNSIGNED, { attesters: [{ did: erin.did }], maxAge: parseDuration('1h') });
    assert.equal(stale.state, 'unsigned');
    assert.match(stale.reason, /longer ago than the policy allows/);
});

test('a tampered cache entry is caught when it is read', async () => {
    const frank = account();
    await attestAs(frank, UNSIGNED);
    const hex = wholeFileHash(UNSIGNED)!.hash;
    const cached = readProof(CACHE, frank.did, hex)!;
    // Someone else's proof, filed under frank.
    const mallory = new Account();
    mallory.records.set(`${COLLECTION}/${hex}`, { $type: COLLECTION, hash: `sha256:${hex}`, createdAt: new Date().toISOString() });
    writeProof(CACHE, frank.did, hex, { ...cached, car: mallory.proof(COLLECTION, hex) });
    const res = verifySync(UNSIGNED, { attesters: [{ did: frank.did }] });
    assert.equal(res.state, 'unsigned');
    assert.match(res.reason, /does not verify/);
});

test('a signed archive needs a trusted signer only when the policy asks for one', async () => {
    const grace = account();
    await attestAs(grace, SIGNED, 'audited');
    const attesters = [{ did: grace.did, kind: 'audited' }];

    // The test PKI is trusted by nothing, and that does not matter here: the
    // signature is genuine, and the auditors vouched for the bytes.
    assert.equal(verifySync(SIGNED).state, 'valid-untrusted');
    const audited = verifySync(SIGNED, { attesters });
    assert.equal(audited.state, 'valid', audited.reason);
    assert.equal(audited.signed, true);

    // Asking for a sigstore signer as well cannot be met by a CA-signed archive.
    const both = verifySync(SIGNED, { attesters, identity: 'https://github.com/x/y/.github/workflows/z.yml@refs/heads/main' });
    assert.equal(both.state, 'valid-untrusted');
    assert.match(both.reason, /not sigstore-signed/);

    // And an attestation never rescues a signature that does not verify.
    const broken = PATH.join(tmp, 'broken.nzip');
    const bytes = FS.readFileSync(SIGNED);
    // One hex digit of the signature, swapped for another hex digit.
    const digit = bytes.lastIndexOf(Buffer.from('SIGNED:')) + 'SIGNED:'.length + 64 + 1 + 3;
    bytes[digit] = bytes[digit] === 0x30 ? 0x31 : 0x30;
    FS.writeFileSync(broken, bytes);
    assert.equal(verifySync(broken, { attesters }).state, 'invalid');
});

test('withdrawing an attestation reaches the cache on the next refresh', async () => {
    const heidi = account();
    await attestAs(heidi, UNSIGNED);
    const policy = { attesters: [{ did: heidi.did }] };
    assert.equal(verifySync(UNSIGNED, policy).state, 'valid');

    heidi.records.clear();
    // The cache still answers from what it last confirmed...
    assert.equal(verifySync(UNSIGNED, policy).state, 'valid');
    // ...until it is refreshed.
    const refreshed = await ATPROTO.refreshAttester(heidi.did);
    assert.deepEqual(refreshed, { present: 0, fetched: 0, removed: 1 });
    assert.equal(verifySync(UNSIGNED, policy).state, 'unsigned');
});

test('refreshing an attester fetches everything it has attested, and survives a key rotation', async () => {
    const ivan = account();
    await attestAs(ivan, UNSIGNED);
    await attestAs(ivan, SIGNED);
    FS.rmSync(PATH.join(CACHE, encodeURIComponent(ivan.did)), { recursive: true });
    assert.deepEqual(await ATPROTO.refreshAttester(ivan.did), { present: 2, fetched: 2, removed: 0 });
    assert.deepEqual(await ATPROTO.refreshAttester(ivan.did), { present: 2, fetched: 0, removed: 0 });

    // A new repository key — a PDS migration, say — invalidates every cached
    // proof; the refresh notices and fetches them again under the new key.
    ivan.rotate();
    assert.deepEqual(await ATPROTO.refreshAttester(ivan.did), { present: 2, fetched: 2, removed: 0 });
    assert.equal(verifySync(UNSIGNED, { attesters: [{ did: ivan.did }] }).state, 'valid');
});

test('a proof signed by the wrong key is never cached', async () => {
    const judy = account();
    const hex = wholeFileHash(UNSIGNED)!.hash;
    judy.records.set(`${COLLECTION}/${hex}`, { $type: COLLECTION, hash: `sha256:${hex}`, createdAt: new Date().toISOString() });
    const original = judy.proof.bind(judy);
    const impostor = CRYPTO.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey;
    judy.proof = (collection, rkey) => original(collection, rkey, { signWith: impostor });
    await assert.rejects(ATPROTO.fetchAttestation(judy.did, 'sha256', hex), /signature does not verify/);
    assert.equal(readProof(CACHE, judy.did, hex), null);
});

test('a handle resolves to its DID only when the DID document claims it back', async () => {
    const ken = account();
    assert.equal((await ATPROTO.resolveHandle(ken.handle, { resolveTxt })).did, ken.did);
    assert.deepEqual(await ATPROTO.resolveAttester(`audited@${ken.handle}`, { resolveTxt }), { did: ken.did, kind: 'audited' });

    // Point another handle at ken's DID: ken's document does not agree.
    const liar = async (name: string) => (name === '_atproto.liar.test' ? [[`did=${ken.did}`]] : resolveTxt(name));
    await assert.rejects(ATPROTO.resolveHandle('liar.test', { resolveTxt: liar }), /does not claim liar\.test back/);
});

// ------------------------------------------------------------- enforcement ---

test('the verifying provider mounts an attested unsigned archive, from the cache alone', async () => {
    const leo = account();
    await attestAs(leo, UNSIGNED);
    const before = requests.length;
    const provider = openBundle(UNSIGNED, { attesters: [leo.did] });
    assert.ok(provider);
    assert.equal(requests.length, before, 'mounting reached for the network');
    assert.throws(() => openBundle(UNSIGNED, { attesters: [account().did] }), /ERR_BUNDLE_UNTRUSTED|refusing to mount/);
});

test('the preload enforces BUNDLE_ATTESTERS in a real node process', async () => {
    const mia = account();
    await attestAs(mia, UNSIGNED);
    process.env['BUNDLE_ATTESTERS'] = mia.did;
    try {
        const ran = mount(UNSIGNED, { roots: [] });
        assert.equal(ran.status, 0, ran.stderr);
        assert.match(ran.stdout, /hello from a signed bundle/);

        process.env['BUNDLE_ATTESTERS'] = `audited@${mia.did}`;
        const refused = mount(UNSIGNED, { roots: [] });
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /'audited' is required/);
    } finally {
        delete process.env['BUNDLE_ATTESTERS'];
    }
});

test('a sealed runtime refuses attesters from its command line', async () => {
    const write = process.stderr.write;
    let said = '';
    process.stderr.write = ((chunk: string) => { said += chunk; return true; }) as typeof process.stderr.write;
    try {
        assert.equal(await launchMain(['--attester', 'did:web:x.test', UNSIGNED], { sealed: true }), 64);
    } finally {
        process.stderr.write = write;
    }
    assert.match(said, /--attester is not accepted/);
});

test('an install that demands an attester is refused without it, and installed notices a withdrawal', async () => {
    const nina = account();
    const archive = await version();
    DOWNLOADS.set('/tool.nzip', FS.readFileSync(archive));

    await assert.rejects(install('https://dl.test/tool.nzip', { attesters: [{ did: nina.did }] }), /requires attestations from/);

    await attestAs(nina, archive);
    FS.rmSync(CACHE, { recursive: true }); // install fetches what it needs
    const record = await install('https://dl.test/tool.nzip', { attesters: [{ did: nina.did }] });
    assert.deepEqual(record.accepted?.attesters, [nina.did]);
    assert.deepEqual(record.attestedBy, [nina.did]);
    assert.equal(installed()[0]?.state, 'ok');

    // A release nobody has said anything about is refused — there is nothing
    // to ask about — and the installed copy stays.
    DOWNLOADS.set('/tool.nzip', FS.readFileSync(await version()));
    const [nothing] = await update('tool');
    assert.equal(nothing!.state, 'refused');
    assert.match(nothing!.reason ?? '', /nothing that can be checked vouches for it/);
    assert.equal(records()['tool']?.sha256, record.sha256);

    // Withdrawn: installed() reports it once the cache has been refreshed.
    nina.records.clear();
    await ATPROTO.refreshAttester(nina.did);
    assert.equal(installed()[0]?.state, 'unsigned');
    FS.rmSync(PATH.join(tmp, 'bin', 'tool'));
    (await import('../src/install.ts')).uninstall('tool');
});

test('install discovers attesters nobody named, asks about them, and update remembers the answer', async () => {
    const quinn = account();
    const rita = account();
    const first = await version();
    await attestAs(quinn, first, 'audited');
    DOWNLOADS.set('/found.nzip', FS.readFileSync(first));

    // Found through the index, verified from quinn's PDS — and new, so asked about.
    let asked: Review | undefined;
    const record = await install('https://dl.test/found.nzip', { decide: async (review) => (asked = review, selectable(review)) });
    assert.deepEqual(asked?.items.map((item) => [item.evidence.type, (item.evidence as { did?: string }).did, item.known]),
        [['attestation', quinn.did, undefined]]);
    assert.deepEqual(record.accepted?.attesters, [quinn.did]);

    // quinn vouches for the next version too: no question.
    const second = await version();
    await attestAs(quinn, second, 'audited');
    DOWNLOADS.set('/found.nzip', FS.readFileSync(second));
    const [proceeded] = await update('found', { decide: async () => assert.fail('nothing should be asked') });
    assert.equal(proceeded!.state, 'updated');

    // Only rita, whom nobody accepted, vouches for the one after: a question,
    // not a failure — and with nobody to ask, it waits.
    const third = await version();
    await attestAs(rita, third, 'reproduced');
    DOWNLOADS.set('/found.nzip', FS.readFileSync(third));
    const [waiting] = await update('found');
    assert.equal(waiting!.state, 'unconfirmed');
    const [accepted] = await update('found', { decide: async (review) => selectable(review) });
    assert.equal(accepted!.state, 'updated');
    assert.deepEqual(records()['found']!.accepted?.attesters.sort(), [quinn.did, rita.did].sort());

    // Turned off, discovery finds nobody new.
    const fourth = await version();
    await attestAs(account(), fourth);
    DOWNLOADS.set('/found.nzip', FS.readFileSync(fourth));
    const [blind] = await update('found', { discover: false });
    assert.equal(blind!.state, 'refused');
});

test('bad verdicts: a warning from strangers, a question from the trusted, a refusal from blockers', async () => {
    const sam = account();      // vouches
    const tess = account();     // a stranger who warns
    const uma = account();      // trusted, and warns
    const scanner = account();  // blocked on
    const dhh = account();      // ignored
    const archive = await version();
    await attestAs(sam, archive);
    DOWNLOADS.set('/warned.nzip', FS.readFileSync(archive));
    const policy = { trust: { attesters: [sam.did] } };

    // A stranger's warning is shown, and decides nothing.
    await attestAs(tess, archive, 'malware', 'bad');
    writePolicy(policy);
    let shown: Review | undefined;
    await install('https://dl.test/warned.nzip', { onReview: (review) => { shown = review; } });
    assert.equal(shown?.decision, 'proceed');
    const warning = shown?.items.find((item) => (item.evidence as { did?: string }).did === tess.did);
    assert.equal(warning?.excluded, 'marked it bad');
    assert.deepEqual(warningsOf(shown!), [`warning: ${tess.handle} marked it bad (malware)`]);
    assert.match(installed().find((check) => check.record.name === 'warned')!.reason, /warning: .* marked it bad \(malware\)/);

    // Someone this machine trusts says it is bad: nothing proceeds without asking.
    await attestAs(uma, archive, 'vulnerable', 'bad');
    writePolicy({ trust: { attesters: [sam.did, uma.did] } });
    await assert.rejects(install('https://dl.test/warned.nzip', { name: 'warned2' }), /marked bad by .*, whom you trust/);

    // Blocked on: refused, whatever else vouches for it, and --yes does not help.
    await attestAs(scanner, archive, 'malware', 'bad');
    writePolicy({ ...policy, block: [scanner.did] });
    await assert.rejects(install('https://dl.test/warned.nzip', { name: 'warned3', decide: async (review) => selectable(review) }),
        /marked bad by .*, which this machine blocks on/);
    assert.equal(installed().find((check) => check.record.name === 'warned')?.state, 'invalid');

    // And the same at mount time, from the cache: the verifier refuses outright.
    const blocked = verifySync(archive, { block: [{ did: scanner.did }] });
    assert.equal(blocked.state, 'invalid');
    assert.match(blocked.reason, /marked bad by/);
    assert.equal(blocked.unmet, true);

    // Ignored: their verdicts are not even shown.
    await attestAs(dhh, archive, 'bloat', 'bad');
    writePolicy({ ...policy, ignore: [dhh.did, tess.did] });
    const ignored: Review[] = [];
    await install('https://dl.test/warned.nzip', { name: 'warned4', onReview: (review) => { ignored.push(review); } });
    const dids = ignored[0]!.items.map((item) => (item.evidence as { did?: string }).did);
    assert.ok(dids.includes(sam.did) && dids.includes(uma.did));
    assert.ok(!dids.includes(dhh.did) && !dids.includes(tess.did), 'ignored attesters are not shown');
    writePolicy({});
});

test('the policy file: requirements apply, trust adds up, typos are refused', async () => {
    const victor = account();
    const archive = await version();
    await attestAs(victor, archive, 'audited');
    DOWNLOADS.set('/ruled.nzip', FS.readFileSync(archive));

    // A machine policy and a user policy: both apply.
    const system = PATH.join(tmp, 'system-policy.json');
    FS.writeFileSync(system, JSON.stringify({ require: { signature: true } }));
    process.env['BUNDLE_SYSTEM_POLICY'] = system;
    try {
        writePolicy({ trust: { attesters: [`audited@${victor.did}`] } });
        const effective = loadPolicy('ruled');
        assert.deepEqual(effective.files, [system, POLICY_FILE]);
        await assert.rejects(install('https://dl.test/ruled.nzip'), /requires a signature/);
    } finally {
        process.env['BUNDLE_SYSTEM_POLICY'] = PATH.join(tmp, 'no-system-policy.json');
    }

    // Trusted by the user's policy: installs without a question.
    const record = await install('https://dl.test/ruled.nzip', { decide: async () => assert.fail('nothing should be asked') });
    assert.deepEqual(record.accepted?.attesters, [victor.did]);

    // A per-app requirement applies to that app alone.
    writePolicy({ apps: { other: { require: { attesters: [account().did] } } } });
    assert.equal(loadPolicy('ruled').attesters.length, 0);
    assert.equal(loadPolicy('other').attesters.length, 1);

    // Unknown settings and malformed values are errors, not silently ignored.
    writePolicy({ requires: { signature: true } });
    assert.throws(() => loadPolicy(), /unknown setting 'requires'/);
    writePolicy({ trust: { attesters: ['alice.example.com'] } });
    assert.throws(() => loadPolicy(), /must be a DID/);
    writePolicy({ block: ['audited@did:web:x.test'] });
    assert.throws(() => loadPolicy(), /block takes DIDs/);
    writePolicy({});

    const shown = collector();
    assert.equal(await main(['policy'], shown), 0);
    assert.match(shown.stdout.join('\n'), /discovery: +https:\/\/index\.test/);
});

test('the review is shown numbered, and a terminal answer picks from it', async () => {
    const wendy = account();
    const xavier = account();
    const archive = await version();
    await attestAs(wendy, archive, 'audited');
    await attestAs(xavier, archive, 'reproduced');
    DOWNLOADS.set('/picked.nzip', FS.readFileSync(archive));

    const answers = ['5', '2'];
    const io = { ...collector(), ask: async () => answers.shift()! };
    assert.equal(await main(['install', 'https://dl.test/picked.nzip'], io), 0, io.stderr.join('\n'));
    const said = io.stderr.join('\n');
    assert.match(said, / {2}1 attested by .* as (audited|reproduced), .* — new/);
    assert.match(said, / {2}2 attested by /);
    assert.match(said, /'5' is not one of 1–2/);
    assert.equal(records()['picked']!.accepted?.attesters.length, 1);

    // Non-interactive, nothing to proceed on: exit 4, not a verification failure.
    const another = await version();
    await attestAs(account(), another);
    DOWNLOADS.set('/picked.nzip', FS.readFileSync(another));
    const quiet = collector();
    assert.equal(await main(['update', 'picked'], quiet), UNDECIDED);
    assert.match(quiet.stdout.join('\n'), /picked: unconfirmed/);
});

test('bundle attest, verify --attester and attest --revoke, end to end', async () => {
    const olive = account();
    process.env['BUNDLE_ATPROTO_PASSWORD'] = olive.password;
    try {
        const verified = collector();
        assert.equal(await main(['verify', '--attester', `audited@${olive.did}`, UNSIGNED], verified), 3);
        assert.match(verified.stdout.join('\n'), /missing: {2}.* as audited — no attestation of this file/);

        const attested = collector();
        assert.equal(await main(['attest', '--as', olive.did, '--kind', 'audited', UNSIGNED], attested), 0, attested.stderr.join('\n'));
        assert.match(attested.stdout.join('\n'), new RegExp(`attested .*unsigned\\.run \\(sha256:[0-9a-f]{64}\\) as ${olive.did} \\(audited\\)`));

        const valid = collector();
        assert.equal(await main(['verify', '--json', '--attester', `audited@${olive.did}`, UNSIGNED], valid), 0);
        const json = JSON.parse(valid.stdout.join('\n')) as { state: string; signed: boolean; attestations: { ok: boolean; kind: string }[] };
        assert.equal(json.state, 'valid');
        assert.equal(json.signed, false);
        assert.deepEqual(json.attestations.map(({ ok, kind }) => ({ ok, kind })), [{ ok: true, kind: 'audited' }]);

        // Offline, the cache answers.
        offline = true;
        const cached = collector();
        assert.equal(await main(['verify', '--attester', olive.did, UNSIGNED], cached), 0);
        assert.match(cached.stderr.join('\n'), /using the cache/);
        offline = false;

        const revoked = collector();
        assert.equal(await main(['attest', '--as', olive.did, '--revoke', UNSIGNED], revoked), 0);
        assert.equal(await main(['verify', '--attester', olive.did, UNSIGNED], collector()), 3);

        // Bad passwords and broken archives are refused before anything is written.
        process.env['BUNDLE_ATPROTO_PASSWORD'] = 'wrong';
        const denied = collector();
        assert.equal(await main(['attest', '--as', olive.did, UNSIGNED], denied), 70);
        assert.match(denied.stderr.join('\n'), /Invalid identifier or password/);
    } finally {
        offline = false;
        delete process.env['BUNDLE_ATPROTO_PASSWORD'];
    }
});

test('bundle trust refreshes every attester it knows about', async () => {
    const pat = account();
    await attestAs(pat, UNSIGNED);
    const out = collector();
    assert.equal(await main(['trust', '--no-sigstore', '--attester', pat.did], out), 0, out.stderr.join('\n'));
    assert.match(out.stdout.join('\n'), new RegExp(`${pat.did}: 1 attestation\\b`));
});

// ------------------------------------------------------------------- OAuth ---

test('attest signs in with OAuth — attestation-only scope, DPoP-bound — writes as that account, and keeps nothing', async () => {
    const yara = account();
    const archive = await version();
    const lines: string[] = [];
    const session = await oauthLogin(yara.did, { open: browser, log: (line) => lines.push(line) });
    assert.equal(session.did, yara.did);
    assert.equal(session.how, 'OAuth (attestations only)');
    assert.equal(AUTH.pushed.at(-1), `atproto repo:${COLLECTION}`);
    assert.match(lines.join('\n'), /sign in to https:\/\/auth\.test as did:plc:/);

    // The PDS asks for its own nonce first; the write goes through on the retry.
    const hashed = wholeFileHash(archive)!;
    await ATPROTO.attest(session, { hashAlg: hashed.hashAlg, hex: hashed.hash, kind: 'audited' });
    assert.equal(verifySync(archive, { attesters: [{ did: yara.did, kind: 'audited' }] }).state, 'valid');

    // Done: the refresh token is revoked, and nothing was ever written to disk.
    const live = AUTH.refreshTokens.size;
    await session.end?.();
    assert.equal(AUTH.refreshTokens.size, live - 1);
    assert.equal(FS.existsSync(PATH.join(tmp, 'state', 'bundle', 'oauth')), false);
});

test('an access token that expires mid-command is refreshed, in memory', async () => {
    const zoe = account();
    const session = await oauthLogin(zoe.did, { open: browser });
    for (const token of AUTH.tokens.keys()) AUTH.expired.add(token);
    const refreshes = AUTH.refreshes;
    const archive = await version();
    const hashed = wholeFileHash(archive)!;
    await ATPROTO.attest(session, { hashAlg: hashed.hashAlg, hex: hashed.hash });
    assert.equal(AUTH.refreshes, refreshes + 1);
    assert.equal(verifySync(archive, { attesters: [{ did: zoe.did }] }).state, 'valid');
    await session.end?.();
});

test('a server without granular scopes is asked for general write access instead, and that is said', async () => {
    const abe = account();
    AUTH.rejectGranular = true;
    try {
        const lines: string[] = [];
        const session = await oauthLogin(abe.did, { open: browser, log: (line) => lines.push(line) });
        assert.equal(session.how, 'OAuth');
        assert.deepEqual(AUTH.pushed.slice(-2), [`atproto repo:${COLLECTION}`, 'atproto transition:generic']);
        assert.match(lines.join('\n'), /does not offer access to just com\.pipobscure\.bundle\.attestation; asking for general write access/);
    } finally {
        AUTH.rejectGranular = false;
    }
});

test('a sign-in that answers for another account, or from another server, is refused', async () => {
    const bea = account();
    AUTH.lieAboutSub = true;
    try {
        await assert.rejects(oauthLogin(bea.did, { open: browser }), /signed in did:plc:.*, not did:plc:/);
    } finally {
        AUTH.lieAboutSub = false;
    }
    AUTH.wrongIssuer = true;
    try {
        await assert.rejects(oauthLogin(bea.did, { open: browser }), /the answer came from https:\/\/evil\.test/);
    } finally {
        AUTH.wrongIssuer = false;
    }
});

test('bundle attest takes several archives under one sign-in, and checks them all first', async () => {
    const cal = account();
    delete process.env['BUNDLE_ATPROTO_PASSWORD'];
    const archives = [await version(), await version(), await version()];

    let opened = 0;
    const io = { ...collector(), open: (url: string) => { opened++; browser(url); } };
    assert.equal(await main(['attest', '--as', cal.did, '--kind', 'reproduced', ...archives], io), 0, io.stderr.join('\n'));
    assert.equal(opened, 1, 'one sign-in for all of them');
    assert.match(io.stderr.join('\n'), /signed in as did:plc:.* through OAuth \(attestations only\)/);
    for (const archive of archives) assert.equal(verifySync(archive, { attesters: [{ did: cal.did, kind: 'reproduced' }] }).state, 'valid');

    // One broken archive among them stops the lot, before anyone signs in.
    const broken = PATH.join(tmp, 'broken-member.run');
    const bytes = FS.readFileSync(await version());
    const at = bytes.indexOf(Buffer.from('greeting'));
    bytes[at] = bytes[at]! ^ 0x20;
    FS.writeFileSync(broken, bytes);
    const fresh = await version();
    const refused = { ...collector(), open: () => assert.fail('nobody should be asked to sign in') };
    assert.equal(await main(['attest', '--as', cal.did, fresh, broken], refused), STATES.invalid.code);
    assert.equal(verifySync(fresh, { attesters: [{ did: cal.did }] }).state, 'unsigned', 'nothing was written');

    // And the same sign-in withdraws them all.
    const withdrawn = { ...collector(), open: browser };
    assert.equal(await main(['attest', '--as', cal.did, '--revoke', ...archives], withdrawn), 0);
    for (const archive of archives) assert.equal(verifySync(archive, { attesters: [{ did: cal.did }] }).state, 'unsigned');
});

// ---------------------------------------------------------------- lexicons ---

test('the lexicons this package carries are where their NSIDs say, under the authority DNS needs', () => {
    const docs = lexicons();
    assert.deepEqual(docs.map((doc) => doc.id), [COLLECTION]);
    assert.equal(authorityOf(COLLECTION), 'bundle.pipobscure.com');
    assert.equal(docs[0]!.defs['main'] && (docs[0]!.defs['main'] as { type: string }).type, 'record');
});

test('lexicon publish needs DNS to name the account, writes with lexicon-only access, and reads it back', async () => {
    const dana = account();
    const dns = new Map<string, string>();
    const resolveTxt = async (name: string) => {
        const did = dns.get(name);
        if (!did) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        return [[`did=${did}`]];
    };

    // Signed in for publishing lexicons, and for nothing else.
    const session = await oauthLogin(dana.did, { open: browser, scope: `atproto repo:${SCHEMA_COLLECTION}` });
    assert.equal(AUTH.pushed.at(-1), `atproto repo:${SCHEMA_COLLECTION}`);
    assert.equal(session.how, `OAuth (repo:${SCHEMA_COLLECTION})`);

    // Nothing resolves to this account yet: refused, unless forced.
    assert.deepEqual((await checkLexicons({ resolveTxt })).map((each) => each.state), ['no-authority']);
    await assert.rejects(publishLexicons(session, { resolveTxt }), /_lexicon\.bundle\.pipobscure\.com has no 'did=' TXT record yet/);
    dns.set('_lexicon.bundle.pipobscure.com', account().did);
    await assert.rejects(publishLexicons(session, { resolveTxt }), /names did:plc:.*, not did:plc:.* — publish from that account/);

    // Pointed at this account: unpublished, then published and current.
    dns.set('_lexicon.bundle.pipobscure.com', dana.did);
    assert.deepEqual((await checkLexicons({ resolveTxt })).map((each) => each.state), ['unpublished']);
    const [written] = await publishLexicons(session, { resolveTxt });
    assert.equal(written!.uri, `at://${dana.did}/${SCHEMA_COLLECTION}/${COLLECTION}`);
    const record = dana.records.get(`${SCHEMA_COLLECTION}/${COLLECTION}`) as Record<string, unknown>;
    assert.equal(record['$type'], SCHEMA_COLLECTION);
    assert.equal(record['id'], COLLECTION);
    assert.deepEqual((await checkLexicons({ resolveTxt })).map((each) => each.state), ['current']);

    // Changed since: check says so.
    dana.records.set(`${SCHEMA_COLLECTION}/${COLLECTION}`, { ...record, description: 'an older version' });
    assert.deepEqual((await checkLexicons({ resolveTxt })).map((each) => each.state), ['different']);
});
