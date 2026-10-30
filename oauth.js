// Social sign-in (Google, GitHub, Apple) using the server-side authorization-code flow.
// Framework-free, like auth.js: every dependency (fetch, clock, user store, session adapter) is injected, so it is unit-tested without a network.
//
// Security properties (each one is covered by test/oauth.test.js):
//  * state: a random value stored in the server-side session and compared in constant time; single use; expires after 10 minutes.
//  * PKCE (S256) for Google and GitHub; nonce for Google and Apple (OpenID Connect), checked inside the returned ID token.
//  * Client secrets exist only in server environment variables. They are never placed in a URL, a redirect, a response body or a log line.
//  * The ID token's SIGNATURE is verified with `jose` (RS256 only) against the provider's fixed JWKS URL (JWKS_URLS below). Issuer, audience,
//    expiry, issued-at, nonce and subject are checked as well. Key URLs or keys supplied inside a token (jku, jwk, x5u, x5c) are rejected, never used.
//    `jose` v6 is ESM-only, so it is loaded lazily with import() and can be replaced through deps.jose (tests use local keys, no network).
//  * Only a provider-VERIFIED email is accepted for a NEW account. A social login is never merged into an existing account that
//    has the same email (the password sign-up does not verify emails, so merging would allow account takeover). That case is refused.
//  * The session id is regenerated on success (no fixation). Redirect targets are fixed paths, never taken from the request.
const crypto = require('crypto');
const { createLimiter } = require('./security');
const { normalizeEmail } = require('./auth');

const STATE_TTL_MS = 10 * 60 * 1000;
const SUCCESS_REDIRECT = '/#/dashboard';
const errorRedirect = code => '/#/login?oauth_error=' + encodeURIComponent(code);
const b64u = b => Buffer.from(b).toString('base64url');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const challenge = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The ONLY places signing keys are ever fetched from. Never derived from a token, a request or the environment.
const JWKS_URLS = Object.freeze({ google: 'https://www.googleapis.com/oauth2/v3/certs', apple: 'https://appleid.apple.com/auth/keys' });
let joseModule = null;
const loadJose = () => joseModule || (joseModule = import('jose').catch(e => { joseModule = null; throw e; }));

const PROVIDERS = {
  google: { label: 'Google', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email', oidc: true, pkce: true, issuers: ['https://accounts.google.com', 'accounts.google.com'], extra: { prompt: 'select_account' }, vars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
  github: { label: 'GitHub', authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'user:email', oidc: false, pkce: true, vars: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] },
  // Apple answers with a cross-site form POST (required when email is requested). It does not use PKCE here: it authenticates with a signed client secret.
  apple: { label: 'Apple', authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', scope: 'email', oidc: true, pkce: false, issuers: ['https://appleid.apple.com'], extra: { response_mode: 'form_post' }, vars: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'] }
};
const NAMES = Object.keys(PROVIDERS);

class OAuthError extends Error { constructor(code, detail) { super(detail || code); this.oauthCode = code; } }
const fail = (code, detail) => { throw new OAuthError(code, detail); };

const applePem = v => String(v || '').trim().replace(/\\n/g, '\n');   // env files often hold the key with literal \n
// Returns the provider's settings when EVERY required variable is present (and, for Apple, the key parses); otherwise null. Never throws, never logs.
function providerConfig(name, env = process.env) {
  const p = PROVIDERS[name];
  if (!p) return null;
  const v = k => String(env[k] || '').trim();
  if (name === 'apple') {
    if (!p.vars.every(k => v(k))) return null;
    try { const key = crypto.createPrivateKey(applePem(env.APPLE_PRIVATE_KEY)); if (key.asymmetricKeyType !== 'ec') return null; } catch (e) { return null; }
    return { ...p, name, clientId: v('APPLE_CLIENT_ID'), teamId: v('APPLE_TEAM_ID'), keyId: v('APPLE_KEY_ID'), privateKey: applePem(env.APPLE_PRIVATE_KEY) };
  }
  const id = v(name.toUpperCase() + '_CLIENT_ID'), secret = v(name.toUpperCase() + '_CLIENT_SECRET');
  return id && secret ? { ...p, name, clientId: id, clientSecret: secret } : null;
}

// Public address of THIS server as the provider must see it. Environment first (no hard-coded URLs), then the request itself.
function publicOrigin(env, selfOrigin) {
  const raw = String(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || selfOrigin || '').trim();
  try { const u = new URL(raw); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch (e) { return null; }
}
const callbackUrl = (origin, provider) => origin + '/api/auth/oauth/' + provider + '/callback';

function buildAuthorizeUrl(cfg, redirectUri, st) {
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, scope: cfg.scope, state: st.state });
  if (cfg.pkce) { q.set('code_challenge', challenge(st.verifier)); q.set('code_challenge_method', 'S256'); }
  if (cfg.oidc) q.set('nonce', st.nonce);
  for (const [k, val] of Object.entries(cfg.extra || {})) q.set(k, val);
  return cfg.authorize + '?' + q.toString();
}

// Apple's "client secret" is a short-lived ES256 JWT signed with the .p8 key from the Apple Developer account.
function appleClientSecret(cfg, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: cfg.teamId, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: cfg.clientId }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: crypto.createPrivateKey(cfg.privateKey), dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}

// Verifies the signature (RS256 only, keys from the provider's fixed JWKS) and every claim. Returns the verified payload or throws OAuthError.
async function verifyIdToken(jose, jwks, cfg, token, nonce, nowMs) {
  if (typeof token !== 'string' || !token || token.length > 16384) fail('provider_error', 'id_token missing');
  let header;
  try { header = jose.decodeProtectedHeader(token); } catch (e) { return fail('provider_error', 'id_token header unreadable'); }
  if (header.alg !== 'RS256') fail('provider_error', 'unsupported id_token algorithm');
  for (const k of ['jku', 'jwk', 'x5u', 'x5c']) if (k in header) fail('provider_error', 'id_token carries its own key reference');
  let payload;
  try {
    ({ payload } = await jose.jwtVerify(token, jwks, {
      algorithms: ['RS256'], issuer: cfg.issuers, audience: cfg.clientId,
      currentDate: new Date(nowMs), clockTolerance: 30, requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub']
    }));
  } catch (e) { return fail('provider_error', 'id_token rejected: ' + String((e && (e.code || e.name)) || 'error').slice(0, 60)); }
  if (typeof payload.iat !== 'number' || payload.iat * 1000 > nowMs + 5 * 60000) fail('provider_error', 'id_token issued in the future');
  if (!safeEqual(payload.nonce, nonce)) fail('state', 'nonce mismatch');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) fail('provider_error', 'bad subject');
  return payload;
}

function createOAuthApi(deps) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const doFetch = deps.fetch || ((...a) => globalThis.fetch(...a));
  const limit = createLimiter(40, 10 * 60000);   // per IP, start + callback together
  const jwksSets = {};   // one cached remote key set per provider; the URL is always the fixed one from JWKS_URLS
  const jwksFor = (jose, cfg) => jwksSets[cfg.name] || (jwksSets[cfg.name] = jose.createRemoteJWKSet(new URL(JWKS_URLS[cfg.name]), { timeoutDuration: 5000 }));
  const log = (provider, code, detail) => console.error('[oauth]', provider, code, detail || '');

  async function getJson(url, init) {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    let j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok || j == null) fail('provider_error', 'HTTP ' + res.status + ' from ' + new URL(url).host);
    return j;
  }

  async function exchange(cfg, redirectUri, code, verifier) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cfg.clientId });
    body.set('client_secret', cfg.name === 'apple' ? appleClientSecret(cfg, now()) : cfg.clientSecret);
    if (cfg.pkce) body.set('code_verifier', verifier);
    const j = await getJson(cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (j.error) fail('provider_error', 'token endpoint refused: ' + String(j.error).slice(0, 60));
    return j;
  }

  // -> { subject, email(): Promise<{ email, verified }> }. The email is fetched lazily: a returning user needs only the subject.
  async function identify(cfg, tokens, nonce) {
    if (cfg.oidc) {
      const jose = deps.jose || await loadJose();
      const claims = await verifyIdToken(jose, jwksFor(jose, cfg), cfg, tokens.id_token, nonce, now());
      return { subject: claims.sub, email: async () => ({ email: claims.email, verified: claims.email_verified === true || claims.email_verified === 'true' }) };
    }
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) fail('provider_error', 'no access token');
    const headers = { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'LaunchForge', 'X-GitHub-Api-Version': '2022-11-28' };
    const user = await getJson('https://api.github.com/user', { headers });
    if (user.id == null || !String(user.id) || String(user.id).length > 255) fail('provider_error', 'bad GitHub user id');
    return {
      subject: String(user.id),
      email: async () => {
        const list = await getJson('https://api.github.com/user/emails', { headers });
        const primary = Array.isArray(list) ? list.find(e => e && e.primary === true && e.verified === true && typeof e.email === 'string') : null;
        return { email: primary && primary.email, verified: Boolean(primary) };
      }
    };
  }

  return {
    names: NAMES,

    // Which buttons may be used. Booleans and a reason only: nothing about the configuration itself is exposed.
    async providers() {
      const ready = await deps.users.oauthReady().catch(() => false);
      const out = {};
      for (const n of NAMES) out[n] = providerConfig(n, env) ? (ready ? { available: true } : { available: false, reason: 'needs_database_upgrade' }) : { available: false, reason: 'not_configured' };
      return out;
    },

    // -> { redirect } (external provider URL, or an in-app error path)
    async start({ provider, session, selfOrigin, ip }) {
      if (!PROVIDERS[provider]) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such sign-in provider.' } } };
      try {
        if (limit.blocked(ip)) fail('rate_limit');
        limit.add(ip);
        const cfg = providerConfig(provider, env);
        if (!cfg) fail('not_configured');
        if (!(await deps.users.oauthReady())) fail('needs_upgrade');
        const origin = publicOrigin(env, selfOrigin);
        if (!origin) fail('not_configured', 'no usable public address');
        const st = { provider, state: rand(), verifier: rand(), nonce: rand(16), at: now() };
        await session.stash('oauth', st);
        return { redirect: buildAuthorizeUrl(cfg, callbackUrl(origin, provider), st) };
      } catch (e) { return handleError(provider, e); }
    },

    // params = the query (Google, GitHub) or the form body (Apple). -> { redirect }
    async callback({ provider, params, session, selfOrigin, ip }) {
      if (!PROVIDERS[provider]) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such sign-in provider.' } } };
      try {
        if (limit.blocked(ip)) fail('rate_limit');
        limit.add(ip);
        const saved = await session.take('oauth');            // single use: consumed even if the rest fails
        const p = params && typeof params === 'object' ? params : {};
        if (typeof p.error === 'string') fail(p.error === 'access_denied' || p.error === 'user_cancelled_authorize' ? 'cancelled' : 'provider_error', 'provider error: ' + p.error.slice(0, 40));
        if (!saved || saved.provider !== provider || !safeEqual(saved.state, typeof p.state === 'string' ? p.state : '') || !(now() - saved.at <= STATE_TTL_MS && now() >= saved.at - 1000)) fail('state');
        if (typeof p.code !== 'string' || !p.code || p.code.length > 2048) fail('provider_error', 'no authorization code');
        const cfg = providerConfig(provider, env);
        if (!cfg) fail('not_configured');
        if (!(await deps.users.oauthReady())) fail('needs_upgrade');
        const origin = publicOrigin(env, selfOrigin);
        if (!origin) fail('not_configured', 'no usable public address');

        const tokens = await exchange(cfg, callbackUrl(origin, provider), p.code, saved.verifier);
        const who = await identify(cfg, tokens, saved.nonce);

        let user = await deps.users.findByIdentity(provider, who.subject);
        if (!user) {
          const { email: rawEmail, verified } = await who.email();
          const email = normalizeEmail(rawEmail);
          if (!email || !verified) fail('no_verified_email');
          if (await deps.users.findByEmail(email)) fail('account_exists');      // never merge into an existing account
          try { user = await deps.users.createSocial(email, provider, who.subject); }
          catch (e) { if (e && e.code === 'EMAIL_TAKEN') fail('account_exists'); throw e; }
        }
        await session.start(user.id);                           // new session id (prevents fixation)
        await deps.users.touchLogin(user.id).catch(() => {});
        return { redirect: SUCCESS_REDIRECT };
      } catch (e) { return handleError(provider, e); }
    }
  };

  function handleError(provider, e) {
    if (e instanceof OAuthError) { if (e.oauthCode !== 'cancelled') log(provider, e.oauthCode, e.message === e.oauthCode ? '' : e.message); return { redirect: errorRedirect(e.oauthCode) }; }
    log(provider, 'failed', (e && e.name) + (e && e.cause && e.cause.code ? ':' + e.cause.code : ''));   // never e.message: it can echo a URL
    return { redirect: errorRedirect('failed') };
  }
}

// Read-only helper for `npm run oauth:check`: which providers are ready and the exact callback URLs to register. Prints no values.
function describeSetup(env = process.env, selfOrigin = 'http://localhost:3000') {
  const origin = publicOrigin(env, selfOrigin);
  return NAMES.map(n => {
    const missing = PROVIDERS[n].vars.filter(k => !String(env[k] || '').trim());
    const configured = Boolean(providerConfig(n, env));
    return { provider: n, label: PROVIDERS[n].label, configured, missing, invalidKey: n === 'apple' && !missing.length && !configured, callback: origin ? callbackUrl(origin, n) : null };
  });
}

module.exports = { createOAuthApi, providerConfig, publicOrigin, callbackUrl, buildAuthorizeUrl, appleClientSecret, verifyIdToken, JWKS_URLS, describeSetup, PROVIDERS, NAMES, STATE_TTL_MS };
