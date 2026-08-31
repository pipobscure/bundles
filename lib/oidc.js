import * as CRYPTO from 'node:crypto';
import * as HTTP from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Getting an OIDC identity token to present to Fulcio — the "who are you"
// half of sigstore signing. Fulcio does not care how the token was obtained,
// only that it is a valid one from an issuer it recognises, so this module's
// whole job is to produce one and then get out of the way.
//
// Three routes, tried in this order, because the right one is a property of
// where the command is running rather than something a user should have to
// pick:
//
//   * An ambient CI token. GitHub Actions exposes a token endpoint through
//     `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN` (given
//     `permissions: id-token: write`), and the resulting token names the
//     repository and workflow rather than a person. That is the identity you
//     actually want on a release artifact, so CI wins whenever it is present.
//
//   * A browser sign-in. Sigstore runs a Dex instance at oauth2.sigstore.dev
//     that federates to GitHub, Google and Microsoft; naming one as
//     `connector_id` skips its chooser and goes straight there. The
//     redirect comes back to a loopback server this process opens on an
//     ephemeral port, which is why no client secret is needed: the flow is a
//     public-client authorization code exchange bound by PKCE.
//
//   * A device code. The same Dex, for machines with no browser to open — an
//     SSH session, a container. The user is given a short code and a URL to
//     open somewhere else, and this process polls until they finish.
//
// Nothing here is sigstore-specific beyond the default endpoints; pointing
// `issuer` at another OIDC provider works, which is the point of Fulcio
// accepting a token rather than a credential of its own.

export const DEFAULT_ISSUER = 'https://oauth2.sigstore.dev/auth';
export const DEFAULT_CLIENT_ID = 'sigstore';
const DEFAULT_SCOPE = 'openid email';

// Dex identifies a connector by the upstream issuer's URL, not by a short name,
// and rejects the request outright if handed something it does not recognise.
// These are the three sigstore's instance offers; the short names are a
// convenience this module translates, so `--connector github` works and an
// unrecognised value is still passed through verbatim for another deployment.
const CONNECTORS = {
    github: 'https://github.com/login/oauth',
    google: 'https://accounts.google.com',
    microsoft: 'https://login.microsoftonline.com',
};

// Resolve a connector name to what Dex expects. An empty value means "do not
// preselect", which lands the user on the provider chooser.
export function connectorId(name) {
    if (!name || name === 'none') return undefined;
    return CONNECTORS[name.toLowerCase()] ?? name;
}

// The audience Fulcio expects to find in the token it is handed.
export const FULCIO_AUDIENCE = 'sigstore';

// Obtain an identity token.
//
// options.token      - a token supplied by the caller; returned as-is
// options.issuer     - OIDC issuer base URL (default: sigstore's Dex)
// options.clientID   - OAuth client id (default: 'sigstore')
// options.connector  - Dex connector to jump straight to (default: 'github')
// options.flow       - 'auto' | 'ci' | 'browser' | 'device' (default: 'auto')
// options.audience   - audience to request for the CI token (default: 'sigstore')
// options.log        - where progress is reported (default: process.stderr)
export async function identityToken(options = {}) {
    const opts = {
        issuer: options.issuer ?? DEFAULT_ISSUER,
        clientID: options.clientID ?? DEFAULT_CLIENT_ID,
        connector: connectorId(options.connector ?? 'github'),
        audience: options.audience ?? FULCIO_AUDIENCE,
        log: options.log ?? ((line) => process.stderr.write(`${line}\n`)),
    };
    const flow = options.flow ?? 'auto';

    if (options.token) return { token: options.token, flow: 'supplied' };

    if (flow === 'ci' || (flow === 'auto' && inCI())) {
        const token = await ciToken(opts.audience);
        return { token, flow: 'ci' };
    }
    if (flow === 'ci') throw new Error('no CI OIDC token endpoint in the environment');

    const chosen = flow === 'auto' ? (canOpenBrowser() ? 'browser' : 'device') : flow;
    const config = await discover(opts.issuer);
    const token = chosen === 'device' ? await deviceFlow(config, opts) : await browserFlow(config, opts);
    return { token, flow: chosen };
}

// Whether an ambient CI identity is available. Only GitHub's shape is
// implemented, since that is what the `--connector github` path mirrors, but
// this is the hook other providers would land on.
export function inCI() {
    return Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

// GitHub Actions' OIDC endpoint. The workflow must ask for it:
//
//   permissions:
//     id-token: write
//
// Without that the variables are simply absent, which is what `inCI()` reads.
async function ciToken(audience) {
    const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set('audience', audience);
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    });
    if (!res.ok) throw new Error(`CI OIDC token request failed: ${res.status} ${res.statusText}`);
    const body = await res.json();
    if (!body.value) throw new Error('CI OIDC token response carried no token');
    return body.value;
}

// The OIDC discovery document, so endpoints are read from the issuer rather
// than hard-coded next to it.
async function discover(issuer) {
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: ${res.status} ${res.statusText}`);
    return res.json();
}

// Authorization code + PKCE against a loopback redirect. The server is bound
// to 127.0.0.1 on an ephemeral port and lives exactly as long as the one
// request it is waiting for.
async function browserFlow(config, opts) {
    const verifier = base64url(CRYPTO.randomBytes(32));
    const challenge = base64url(CRYPTO.createHash('sha256').update(verifier).digest());
    const state = base64url(CRYPTO.randomBytes(16));
    const nonce = base64url(CRYPTO.randomBytes(16));

    const { server, port } = await listen();
    const redirect = `http://localhost:${port}/auth/callback`;
    try {
        const authorize = new URL(config.authorization_endpoint);
        authorize.search = new URLSearchParams({
            response_type: 'code',
            client_id: opts.clientID,
            scope: DEFAULT_SCOPE,
            redirect_uri: redirect,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state,
            nonce,
            ...(opts.connector ? { connector_id: opts.connector } : {}),
        }).toString();

        opts.log(`  opening ${label(opts.connector)}sign-in in your browser`);
        opts.log(`  if it does not open, visit:\n    ${authorize}`);
        openBrowser(authorize.toString());

        const code = await awaitCode(server, state);
        return await exchange(config, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirect,
            client_id: opts.clientID,
            code_verifier: verifier,
        });
    } finally {
        server.close();
    }
}

// Resolves with the `code` from the single callback request, or rejects with
// whatever the provider reported instead. `state` is checked before the code is
// accepted, so a request that did not originate from this flow is rejected.
function awaitCode(server, state) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('timed out waiting for the browser sign-in to complete'));
        }, 5 * 60_000);
        timer.unref?.();

        server.on('request', (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname !== '/auth/callback') return respond(res, 404, 'Not found.');
            clearTimeout(timer);

            const error = url.searchParams.get('error');
            if (error) {
                respond(res, 400, `Sign-in failed: ${error}`);
                return reject(new Error(`sign-in failed: ${url.searchParams.get('error_description') || error}`));
            }
            if (url.searchParams.get('state') !== state) {
                respond(res, 400, 'Sign-in failed: state mismatch.');
                return reject(new Error('sign-in failed: state parameter did not match'));
            }
            const code = url.searchParams.get('code');
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

// Device authorization: the user finishes the flow on another device while this
// process polls. `interval` and the slow_down response are honoured, because
// Dex will reject a client that ignores them.
//
// PKCE is required here as well as on the browser flow — Dex rejects a device
// request without it — even though the device flow's own security does not
// depend on it.
async function deviceFlow(config, opts) {
    const endpoint = config.device_authorization_endpoint
        ?? `${opts.issuer.replace(/\/+$/, '')}/device/code`;
    const verifier = base64url(CRYPTO.randomBytes(32));
    const challenge = base64url(CRYPTO.createHash('sha256').update(verifier).digest());

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: opts.clientID,
            scope: DEFAULT_SCOPE,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        }).toString(),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`device authorization failed: ${res.status} ${detail || res.statusText}`);
    }
    const grant = await res.json();

    opts.log(`  open ${grant.verification_uri_complete ?? grant.verification_uri}`);
    if (grant.user_code) opts.log(`  and enter the code: ${grant.user_code}`);

    const deadline = Date.now() + (grant.expires_in ?? 600) * 1000;
    let interval = (grant.interval ?? 5) * 1000;
    for (;;) {
        await sleep(interval);
        if (Date.now() > deadline) throw new Error('device sign-in expired before it was approved');
        try {
            return await exchange(config, {
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: grant.device_code,
                client_id: opts.clientID,
                code_verifier: verifier,
            });
        } catch (err) {
            // These two are the flow working as designed: still waiting for the
            // user, or told to back off. Anything else is a real failure.
            if (err.oauthError === 'authorization_pending') continue;
            if (err.oauthError === 'slow_down') { interval += 5000; continue; }
            throw err;
        }
    }
}

// Token endpoint exchange, shared by both interactive flows. Dex treats
// `sigstore` as a public client, so the empty client_secret is what it expects
// rather than an omission.
async function exchange(config, params) {
    const res = await fetch(config.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_secret: '', ...params }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw Object.assign(new Error(`token exchange failed: ${body.error_description || body.error || res.statusText}`),
            { oauthError: body.error });
    }
    if (!body.id_token) throw new Error('token exchange returned no id_token');
    return body.id_token;
}

function listen() {
    const server = HTTP.createServer();
    server.listen(0, '127.0.0.1');
    return once(server, 'listening').then(() => ({ server, port: server.address().port }));
}

function respond(res, status, message) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${message}\n`);
}

// Whether launching a browser is plausible. A headless Linux box has no
// DISPLAY, and an SSH session should not try to open one on the far end — in
// both cases the device flow is the honest answer.
function canOpenBrowser() {
    if (process.env.BUNDLE_NO_BROWSER) return false;
    if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
    if (process.platform === 'darwin' || process.platform === 'win32') return true;
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// Best effort: if this fails the URL has already been printed, and the flow
// still completes when the user opens it themselves.
function openBrowser(url) {
    const [cmd, ...args] = process.platform === 'darwin' ? ['open', url]
        : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
    try {
        spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {
        // ignored — the URL is on screen
    }
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function base64url(buf) {
    return buf.toString('base64url');
}

// A connector URL, said the way a person would.
function label(connector) {
    if (!connector) return '';
    const name = Object.keys(CONNECTORS).find((key) => CONNECTORS[key] === connector);
    return name ? `${name} ` : '';
}
