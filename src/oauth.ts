import * as CRYPTO from 'node:crypto';
import type * as HTTP from 'node:http';
import { COLLECTION } from './attestation.ts';
import { net, resolveDid, resolveHandle, type NetworkOptions, type Session } from './atproto.ts';
import { patiently } from './ratelimit.ts';
import { pdsEndpoint } from './repo.ts';
import { listen, respond, openBrowser, canOpenBrowser } from './oidc.ts';

// Logging in to someone's PDS the way atproto means it to be done: OAuth.
//
// atproto's profile of OAuth 2.1 is stricter than the usual kind, and every
// part of it is here:
//
//   * **Discovery from the identity.** The handle or DID resolves to a DID
//     document, that names the PDS, the PDS names its authorization server
//     (`/.well-known/oauth-protected-resource`), and that server describes
//     itself (`/.well-known/oauth-authorization-server`). Nothing is assumed
//     about where an account lives.
//   * **Pushed authorization requests**, so the parameters go to the server
//     directly and the browser only carries a reference to them.
//   * **PKCE (S256)**, and a `state` checked on the way back, with the `iss`
//     the server says it is.
//   * **DPoP**: every token is bound to a key this process generates, and every
//     request carries a fresh proof signed with it — with the server's nonce,
//     which it hands out on first contact and rotates, so a request is retried
//     once when it asks for a new one.
//   * **The token is for the account that was asked for.** The `sub` the
//     server returns must be the DID that was resolved, or the session is
//     refused: a server answering for someone else's account is exactly the
//     thing to catch.
//
// The client is a public one: there is no secret a CLI could keep. By default
// it is atproto's loopback development client — a `client_id` of
// `http://localhost?…` carrying its own redirect URI and scope — which needs no
// hosted metadata. `BUNDLE_OAUTH_CLIENT_ID` names a hosted client metadata
// document instead, which is what a client that is not "in development" should
// have (see `clientId()`).
//
// The scope asked for is the narrowest there is: write access to attestation
// records and nothing else (`repo:com.pipobscure.bundle.attestation`). A server that
// does not understand granular scopes refuses that request, and only then is
// the broad `transition:generic` asked for instead — and said so.
//
// **Nothing is kept.** A session lives for one command — an attestation, or a
// lexicon published — and is revoked when that command is done. Every write to
// someone's repository is therefore preceded by that person signing in and
// approving it, which for something that vouches in their name is the point;
// and no refresh token or DPoP key is ever left on disk to be taken. A command
// that has several things to write does them all under one sign-in.

/** Write access to attestations, and nothing else. */
export const SCOPE = `atproto repo:${COLLECTION}`;
/** What a server that predates granular scopes is asked for instead. */
export const FALLBACK_SCOPE = 'atproto transition:generic';

export interface OAuthOptions extends NetworkOptions {
    log?: ((line: string) => void) | undefined;
    /** How the authorization URL is opened (default: the system browser). For tests. */
    open?: ((url: string) => void) | undefined;
    /**
     * What to ask for (default: `SCOPE`, attestations only). A server that
     * refuses a granular scope is asked for `FALLBACK_SCOPE` instead.
     */
    scope?: string | undefined;
}

/** A live session: everything needed to make DPoP-bound requests, and to refresh. Held in memory only. */
interface Live {
    did: string;
    pds: string;
    issuer: string;
    tokenEndpoint: string;
    revocationEndpoint?: string | undefined;
    clientId: string;
    scope: string;
    accessToken: string;
    refreshToken?: string | undefined;
    /** Milliseconds since the epoch. */
    expiresAt: number;
    /** The DPoP private key. */
    dpop: CRYPTO.KeyObject;
}

interface ServerMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    pushed_authorization_request_endpoint?: string;
    revocation_endpoint?: string;
    code_challenge_methods_supported?: string[];
    dpop_signing_alg_values_supported?: string[];
}

// ---------------------------------------------------------------- sessions ---

/**
 * Sign in as `identifier` (a handle or a DID), through the browser. The
 * session is good for this process only: call its `end()` when done, which
 * revokes it.
 */
export async function oauthLogin(identifier: string, options: OAuthOptions = {}): Promise<Session> {
    const did = identifier.startsWith('did:') ? identifier : (await resolveHandle(identifier, options)).did;
    const doc = await resolveDid(did, options);
    return session(await authorize(did, pdsEndpoint(doc), identifier, options), options);
}

// The `Session` atproto.ts writes records through: requests to the PDS carry
// the access token and a DPoP proof bound to it, an access token that expires
// mid-command is refreshed once, and `end()` revokes the lot.
function session(live: Live, options: OAuthOptions): Session {
    let current = live;
    return {
        did: current.did,
        pds: current.pds,
        how: current.scope.split(' ').includes('transition:generic') ? 'OAuth'
            : current.scope.includes(`repo:${COLLECTION}`) ? 'OAuth (attestations only)'
            : `OAuth (${current.scope.split(' ').filter((part) => part !== 'atproto').join(', ')})`,
        request: async (url, init) => {
            const send = () => dpopFetch(url, {
                ...init,
                headers: { ...(init.headers as Record<string, string> | undefined), authorization: `DPoP ${current.accessToken}` },
            }, current.dpop, current.accessToken, options);
            let response = await send();
            if (response.status === 401 && /invalid_token|expired/i.test(response.headers.get('www-authenticate') ?? '') && current.refreshToken) {
                current = await refresh(current, options);
                response = await send();
            }
            return response;
        },
        end: async () => {
            if (!current.revocationEndpoint || !current.refreshToken) return;
            try {
                await dpopFetch(current.revocationEndpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ token: current.refreshToken, client_id: current.clientId }).toString(),
                }, current.dpop, undefined, options);
            } catch {
                // The tokens lapse on their own within minutes; nothing is left behind here either way.
            }
        },
    };
}

// ----------------------------------------------------------- authorization ---

async function authorize(did: string, pds: string, hint: string, options: OAuthOptions): Promise<Live> {
    const log = options.log ?? (() => {});
    const server = await authorizationServer(pds, options);
    const dpop = CRYPTO.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;

    const { server: loopback, port } = await listen();
    try {
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const verifier = CRYPTO.randomBytes(32).toString('base64url');
        const state = CRYPTO.randomBytes(16).toString('base64url');

        let scope = options.scope ?? SCOPE;
        let clientId = clientIdFor(scope);
        let pushed = await pushAuthorization(server, dpop, { clientId, redirectUri, scope, verifier, state, hint }, options);
        if ('error' in pushed && pushed.error === 'invalid_scope') {
            log(`  ${server.issuer} does not offer access to just ${scope.split(' ').filter((part) => part.startsWith('repo:')).map((part) => part.slice(5)).join(', ')}; asking for general write access instead`);
            scope = FALLBACK_SCOPE;
            clientId = clientIdFor(scope);
            pushed = await pushAuthorization(server, dpop, { clientId, redirectUri, scope, verifier, state, hint }, options);
        }
        if ('error' in pushed) throw new Error(`${server.issuer} refused the sign-in request: ${pushed.error}${pushed.description ? ` — ${pushed.description}` : ''}`);

        const url = new URL(server.authorization_endpoint);
        url.search = new URLSearchParams({ client_id: clientId, request_uri: pushed.requestUri }).toString();
        log(`  sign in to ${server.issuer} as ${hint} in your browser`);
        log(`  if it does not open, visit:\n    ${url}`);
        if (options.open) options.open(url.toString());
        else if (canOpenBrowser()) openBrowser(url.toString());

        const code = await callback(loopback, state, server.issuer);
        const tokens = await tokenRequest(server.token_endpoint, dpop, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
        }, options);

        // The session must be for the account that was asked for. The server
        // was found through that account's own PDS, so a different `sub` is a
        // server speaking for someone else.
        if (tokens.sub !== did) throw new Error(`${server.issuer} signed in ${String(tokens.sub)}, not ${did}`);
        return {
            did, pds,
            issuer: server.issuer,
            tokenEndpoint: server.token_endpoint,
            revocationEndpoint: server.revocation_endpoint,
            clientId,
            scope: tokens.scope,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000,
            dpop,
        };
    } finally {
        loopback.close();
    }
}

/**
 * The OAuth client this CLI is. `BUNDLE_OAUTH_CLIENT_ID` names a hosted client
 * metadata document (a public, `native` client whose redirect URIs include
 * `http://127.0.0.1/callback`); without one, it is atproto's loopback
 * development client, whose `client_id` carries its own redirect URI and scope.
 */
export function clientIdFor(scope: string): string {
    const hosted = process.env['BUNDLE_OAUTH_CLIENT_ID'];
    if (hosted) return hosted;
    // The port is not part of the match for a loopback redirect, which is what
    // lets one client_id serve every ephemeral port.
    return `http://localhost?${new URLSearchParams({ redirect_uri: 'http://127.0.0.1/callback', scope }).toString()}`;
}

async function authorizationServer(pds: string, options: OAuthOptions): Promise<ServerMetadata> {
    const fetch = net(options);
    const resource = await json(await fetch(`${pds}/.well-known/oauth-protected-resource`, { redirect: 'error' }),
        `${pds}/.well-known/oauth-protected-resource`) as { authorization_servers?: string[] };
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) throw new Error(`${pds} names no authorization server`);
    const origin = new URL(issuer);
    if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') {
        throw new Error(`${pds}: authorization server ${issuer} is not https`);
    }
    if (origin.origin !== issuer.replace(/\/$/, '')) throw new Error(`${pds}: authorization server ${issuer} is not a bare origin`);

    const metadata = await json(await fetch(`${origin.origin}/.well-known/oauth-authorization-server`, { redirect: 'error' }),
        `${origin.origin}/.well-known/oauth-authorization-server`) as ServerMetadata;
    if (metadata.issuer !== origin.origin) throw new Error(`${origin.origin} describes itself as ${String(metadata.issuer)}`);
    if (!metadata.pushed_authorization_request_endpoint) throw new Error(`${metadata.issuer} does not take pushed authorization requests`);
    if (!(metadata.code_challenge_methods_supported ?? []).includes('S256')) throw new Error(`${metadata.issuer} does not support PKCE S256`);
    if (!(metadata.dpop_signing_alg_values_supported ?? []).includes('ES256')) throw new Error(`${metadata.issuer} does not support ES256 DPoP`);
    return metadata;
}

async function pushAuthorization(server: ServerMetadata, dpop: CRYPTO.KeyObject, request: {
    clientId: string; redirectUri: string; scope: string; verifier: string; state: string; hint: string;
}, options: OAuthOptions): Promise<{ requestUri: string } | { error: string; description?: string | undefined }> {
    const response = await dpopFetch(server.pushed_authorization_request_endpoint!, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: request.clientId,
            response_type: 'code',
            redirect_uri: request.redirectUri,
            scope: request.scope,
            state: request.state,
            code_challenge: CRYPTO.createHash('sha256').update(request.verifier).digest('base64url'),
            code_challenge_method: 'S256',
            login_hint: request.hint,
        }).toString(),
    }, dpop, undefined, options);
    const body = await response.json().catch(() => ({})) as { request_uri?: string; error?: string; error_description?: string };
    if (!response.ok || !body.request_uri) return { error: body.error ?? `HTTP ${response.status}`, description: body.error_description };
    return { requestUri: body.request_uri };
}

// The one request the loopback server waits for: the browser coming back with
// a code — for this flow (`state`), from this server (`iss`).
function callback(server: HTTP.Server, state: string, issuer: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for the browser sign-in to complete')), 5 * 60_000);
        timer.unref?.();
        server.on('request', (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.pathname !== '/callback') return respond(res, 404, 'Not found.');
            clearTimeout(timer);
            const params = url.searchParams;
            if (params.get('state') !== state) {
                respond(res, 400, 'Sign-in failed: state mismatch.');
                return reject(new Error('sign-in failed: the state parameter did not match'));
            }
            if (params.get('iss') !== issuer) {
                respond(res, 400, 'Sign-in failed: wrong issuer.');
                return reject(new Error(`sign-in failed: the answer came from ${String(params.get('iss'))}, not ${issuer}`));
            }
            const error = params.get('error');
            if (error) {
                respond(res, 400, `Sign-in failed: ${error}`);
                return reject(new Error(`sign-in failed: ${params.get('error_description') || error}`));
            }
            const code = params.get('code');
            if (!code) {
                respond(res, 400, 'Sign-in failed: no authorization code.');
                return reject(new Error('sign-in failed: no authorization code in the callback'));
            }
            respond(res, 200, 'Signed in. You can close this tab and return to the terminal.');
            resolve(code);
        });
        server.on('error', reject);
    });
}

interface TokenResponse {
    access_token: string;
    token_type: string;
    sub: string;
    scope: string;
    refresh_token?: string;
    expires_in?: number;
}

async function tokenRequest(endpoint: string, dpop: CRYPTO.KeyObject, params: Record<string, string>, options: OAuthOptions): Promise<TokenResponse> {
    const response = await dpopFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    }, dpop, undefined, options);
    const body = await response.json().catch(() => ({})) as Partial<TokenResponse> & { error?: string; error_description?: string };
    if (!response.ok) throw new Error(`token request refused: ${body.error ?? response.status}${body.error_description ? ` — ${body.error_description}` : ''}`);
    if (body.token_type?.toLowerCase() !== 'dpop') throw new Error(`token is not DPoP-bound (${String(body.token_type)})`);
    if (!body.access_token || !body.sub) throw new Error('token response carries no access token or subject');
    if (!body.scope?.split(' ').includes('atproto')) throw new Error('token response does not grant the atproto scope');
    return body as TokenResponse;
}

async function refresh(stored: Live, options: OAuthOptions): Promise<Live> {
    if (!stored.refreshToken) throw new Error('the session cannot be refreshed');
    const tokens = await tokenRequest(stored.tokenEndpoint, stored.dpop, {
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: stored.clientId,
    }, options);
    if (tokens.sub !== stored.did) throw new Error(`refreshing signed in ${tokens.sub}, not ${stored.did}`);
    return {
        ...stored,
        scope: tokens.scope,
        accessToken: tokens.access_token,
        // Refresh tokens are single-use: the new one replaces the old.
        refreshToken: tokens.refresh_token ?? stored.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000,
    };
}

// -------------------------------------------------------------------- DPoP ---

// The latest nonce each server handed out, by origin. A server hands one out
// on first contact and rotates it; a request it rejects for want of the current
// one is sent once more with it. A server that says to slow down is waited for,
// and asked again with a proof made afresh: a proof is good for one request.
const nonces = new Map<string, string>();

async function dpopFetch(url: string, init: RequestInit, dpop: CRYPTO.KeyObject, accessToken: string | undefined, options: OAuthOptions): Promise<Response> {
    const fetch = options.fetch ?? globalThis.fetch;
    const origin = new URL(url).origin;
    const attempt = async () => {
        const proof = dpopProof(dpop, init.method ?? 'GET', url, nonces.get(origin), accessToken);
        const response = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), dpop: proof } });
        const nonce = response.headers.get('dpop-nonce');
        if (nonce) nonces.set(origin, nonce);
        return response;
    };
    return await patiently(async () => {
        const response = await attempt();
        if (await wantsNonce(response)) return await attempt();
        return response;
    }, url, { ...options, signal: init.signal ?? options.signal });
}

// An authorization server says so in a 400's JSON body; a resource server in
// a 401's WWW-Authenticate header.
async function wantsNonce(response: Response): Promise<boolean> {
    if (response.status === 401) return /use_dpop_nonce/.test(response.headers.get('www-authenticate') ?? '');
    if (response.status !== 400) return false;
    try {
        return (await response.clone().json() as { error?: string }).error === 'use_dpop_nonce';
    } catch {
        return false;
    }
}

/** A DPoP proof: a JWT signed with the session key, for one request. */
export function dpopProof(dpop: CRYPTO.KeyObject, method: string, url: string, nonce?: string | undefined, accessToken?: string | undefined): string {
    const { kty, crv, x, y } = CRYPTO.createPublicKey(dpop).export({ format: 'jwk' });
    const target = new URL(url);
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty, crv, x, y } };
    const payload = {
        jti: CRYPTO.randomBytes(16).toString('base64url'),
        htm: method.toUpperCase(),
        htu: `${target.origin}${target.pathname}`,
        iat: Math.floor(Date.now() / 1000),
        ...(nonce ? { nonce } : {}),
        ...(accessToken ? { ath: CRYPTO.createHash('sha256').update(accessToken).digest('base64url') } : {}),
    };
    const input = `${encode(header)}.${encode(payload)}`;
    const signature = CRYPTO.sign('sha256', Buffer.from(input), { key: dpop, dsaEncoding: 'ieee-p1363' });
    return `${input}.${signature.toString('base64url')}`;
}

function encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function json(response: Response, what: string): Promise<unknown> {
    if (!response.ok) throw new Error(`${what}: ${response.status} ${response.statusText}`);
    return await response.json();
}
