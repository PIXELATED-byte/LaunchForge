# Social sign-in (Google, GitHub, Apple) and what is still needed

## Status: code complete, NOT yet verified against real providers

| Provider | In the code | Switched on in this repo | Verified end to end with the real provider |
|---|---|---|---|
| Google | yes (authorization code + PKCE + nonce) | **no**: needs credentials | **no** |
| GitHub | yes (authorization code + PKCE) | **no**: needs credentials | **no** |
| Apple  | yes (authorization code + signed client secret + nonce, `form_post`) | **no**: needs an Apple Developer account | **no** |

Nothing here has talked to Google, GitHub or Apple, because no credentials exist yet. What *has* been tested is everything on our side
of the conversation, using a fake provider (see "How it was tested"). Do not announce a provider as working until you have signed in
with it once on the real deployment (checklist at the bottom).

A provider button is **live only when all three are true**: its environment variables are set on the server, migration `003_oauth.sql`
has been applied to that database (by you, with `--with-optional`), and the server can reach the provider. Otherwise the button is shown disabled with the reason
("Not configured" / "Not available yet"), and clicking it explains why. Email and password sign-in is not affected in any case.

## How it works (plain English)

1. You press "Continue with Google". The browser goes to `/api/auth/oauth/google/start` on **our server**.
2. The server makes a random one-time `state` and a PKCE secret, keeps them in *your server-side session*, and sends you to Google.
3. Google asks you to approve, then sends you back to `/api/auth/oauth/google/callback` with a one-time `code`.
4. The server checks the `state` matches this browser's session (and is under 10 minutes old, and unused), then exchanges the `code`
   with Google **server to server**, using the client secret. The secret never reaches the browser.
5. The server checks the identity Google returned (audience, issuer, expiry, nonce, verified email), finds or creates the LaunchForge
   user, starts a **new** session, and sends you to the dashboard.

Apple is the same except Apple sends the result back as a form POST, and our "client secret" is a short-lived signed token made from your Apple key.

### Account rules (deliberate, for security)

* A social account is identified by the provider's own stable user id, not by email.
* A **new** account is created only from an email the provider says is **verified**.
* If a LaunchForge account with that email already exists, the social sign-in is **refused** ("An account with this email already exists.
  Log in with your email and password."). It is never merged automatically: password sign-up does not verify emails today, so merging
  would let someone who pre-registered a victim's email take over the victim's social login. Linking an extra provider to an existing
  account should be a *"Connect"* button inside a signed-in session (not built yet).
* Social-only accounts have no password and can never be entered with one. Existing password accounts, hashes and sessions are untouched.
* Project ownership works exactly as before: it comes from the server-side session's user id.

## Environment variables

Set these on the server (Render > Environment). Never put them in the repository or in `index.html`. Names only; values are yours.

| Variable | Needed for | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | callback URLs | Optional. Full address of this server, e.g. `https://launchforge-pr-2.onrender.com`. If absent, Render's automatic `RENDER_EXTERNAL_URL` is used, then the request's own address. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google | Both required. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub | Both required. |
| `APPLE_CLIENT_ID` | Apple | The **Services ID** (for example `com.yourcompany.launchforge.web`), not the App ID. |
| `APPLE_TEAM_ID` | Apple | 10-character Team ID. |
| `APPLE_KEY_ID` | Apple | Key ID of the "Sign in with Apple" key. |
| `APPLE_PRIVATE_KEY` | Apple | Contents of the `.p8` file. Newlines may be written as `\n`. |
| `APPLE_DOMAIN_ASSOCIATION` | Apple | Only if Apple asks you to verify the domain: paste the content of the file Apple gives you. The server then serves it at `/.well-known/apple-developer-domain-association.txt`. |

Check your setup any time (read-only, prints no values): `npm run oauth:check`. It lists what is missing and the exact callback URL for each provider.

## Callback (redirect) URLs to register

`<your address>/api/auth/oauth/<provider>/callback`, where `<your address>` is what `npm run oauth:check` prints. For the PR #2 preview that is, for example:

* Google: `https://launchforge-pr-2.onrender.com/api/auth/oauth/google/callback`
* GitHub: `https://launchforge-pr-2.onrender.com/api/auth/oauth/github/callback`
* Apple: `https://launchforge-pr-2.onrender.com/api/auth/oauth/apple/callback`

A preview address changes with every pull request, and production has its own address. Register each one you really use.
GitHub allows **one** callback per OAuth app, so create a separate GitHub OAuth app for the preview and for production.
Apple needs HTTPS and a real domain (no `localhost`), so test Apple on a stable deployment rather than on short-lived previews.

## Provider setup (menu names change; follow the provider's current documentation if they differ)

**Google.** Google Cloud Console > APIs & Services > *OAuth consent screen* (External; app name and support email; scopes `openid` and `email` need no review).
While the consent screen is in *Testing*, only listed test users can sign in; move it to *In production* for everyone.
Then *Credentials* > *Create credentials* > *OAuth client ID* > *Web application* > add the Google callback URL under *Authorized redirect URIs*.
Copy the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

**GitHub.** GitHub > Settings > Developer settings > *OAuth Apps* > *New OAuth App*. Homepage URL = your site; *Authorization callback URL* = the GitHub callback URL.
Then *Generate a new client secret*. Copy both into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. We ask only for the `user:email` scope.

**Apple** (requires a paid Apple Developer Program membership).
1. developer.apple.com > Certificates, Identifiers & Profiles > *Identifiers*: have an **App ID** with the *Sign in with Apple* capability.
2. Create a **Services ID** (this is `APPLE_CLIENT_ID`), enable *Sign in with Apple*, *Configure*: choose the primary App ID, add your domain and the Apple callback URL as a *Return URL*.
3. If Apple asks to verify the domain, put the file's content in `APPLE_DOMAIN_ASSOCIATION`, deploy, then press *Verify*.
4. *Keys* > create a key with *Sign in with Apple* for that App ID. Download the `.p8` **once** (Apple will not show it again). Note the *Key ID*. Your *Team ID* is on the membership page.
5. Set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`.
6. Apple's "Hide My Email" gives us a private relay address; it is treated as a normal verified email. Apple sends the user's name only on the very first sign-in; we do not store names.
7. Apple replies with a cross-site POST, so the session cookie must be `SameSite=None` (the production default). If you set `COOKIE_SAMESITE=lax`, Apple sign-in fails with the "expired or interrupted" message.

## Database upgrade (migration 003): optional, manual, never automatic

`migrations/003_oauth.sql` does two additive things: it creates the `oauth_identities` table (links a Google/GitHub/Apple account to a user), and it
lets `users.password_hash` be empty (social-only accounts have no password). It changes no existing row: your users, password hashes, sessions and projects stay exactly as they are.

It is **skipped** by the server's startup check (a pending 003 never shows "migrations pending"), by `AUTO_MIGRATE`, and by a plain
`npm run migrate -- --apply`. It runs **only** when you add `--with-optional`. Until then the app works exactly as before and the social buttons stay off.

Procedure. Use a preview or dev database first (for example a Neon branch), never start with production. Put the database address in your shell for one command at a time; never paste it into chat or commit it.

1. **Look first (read-only; changes nothing):**
   ```
   DATABASE_URL="<that database>" psql "$DATABASE_URL" -c "BEGIN READ ONLY; SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'; SELECT to_regclass('public.oauth_identities') AS oauth_table; SELECT count(*) AS users FROM users; ROLLBACK;"
   ```
   Before: `password_hash` is `NO` and `oauth_table` is empty.
2. **Dry run (changes nothing):** `DATABASE_URL="<that database>" npm run migrate -- --with-optional`. It lists `003_oauth.sql` as pending.
3. **Apply (only after you decide):** `DATABASE_URL="<that database>" npm run migrate -- --with-optional --apply`
4. **Check again** with the command from step 1: `password_hash` is now `YES`, `oauth_table` is `oauth_identities`, and the user count is unchanged. Confirm password login still works.
5. Only then set a provider's variables on that environment and restart it.

## Forgot password: deliberately not included

A correct reset flow needs things that do not exist yet, and a half-working one would be a security risk (for example, accepting reset links for the wrong account):
* an email service (Resend, Postmark, Amazon SES or similar) with a verified sending domain, and an API key as a server secret;
* a `password_resets` table (hashed token, expiry, single use) and a migration;
* `POST /api/auth/forgot` (always answers the same, rate limited) and `POST /api/auth/reset` (checks the token, sets a new Argon2 hash, ends other sessions);
* the reset page and the "Forgot password?" link;
* a decision for social-only accounts (they have no password to reset).
Until then the sign-in page shows no "Forgot password?" link, so nothing in the interface promises something that does not work.

## Error messages you may see (`/#/login?oauth_error=...`)

`cancelled` (user pressed Cancel) · `state` (expired, interrupted, or a different browser/session) · `provider_error` (the provider refused or was unreachable) ·
`no_verified_email` · `account_exists` · `not_configured` · `needs_upgrade` (migration 003 not applied) · `rate_limit` · `failed` (unexpected; details are in the server log, never in the page).
The server log lines look like `[oauth] google state` and never contain codes, tokens, secrets or keys.

## How it was tested, and what remains

* Automated (no network): `test/oauth.test.js` runs the whole flow against a fake provider that enforces PKCE for real. It checks state (missing, wrong, other provider, expired, replayed), nonce, audience, issuer, expiry, verified email, the refusal to merge accounts, passwordless users, Apple's signed client secret, and that no secret, token, code or key ever appears in a redirect, response or log. Each rule was also broken on purpose to confirm a test fails.
* Express routes: `test/http.test.js` (runs after `npm install`).
* Page: `test/frontend.test.js`, and the page was exercised in a real headless browser against a stand-in API (buttons, disabled states, validation, keyboard, mobile).
* **Not tested:** a real login with Google, GitHub or Apple; Safari/Firefox; the real database with migration 003 applied.

### Checklist before calling a provider "working"
- [ ] `npm run oauth:check` shows it configured on the target server
- [ ] migration 003 applied to that server's database (read-only check first)
- [ ] the button is enabled on the sign-in page
- [ ] a brand-new account can sign in and lands on the dashboard; reload keeps the session; log out works
- [ ] a second sign-in with the same provider reuses the same account
- [ ] signing in with a provider whose email matches an existing password account is refused with the "already exists" message
- [ ] the same checks in Safari and Chrome
