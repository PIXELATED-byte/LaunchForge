# LaunchForge

Website builder for freelancers. Frontend: `index.html` (GitHub Pages). Backend: `server.js` on Render with Gemini AI editing, accounts, and project storage in Neon Postgres.

## What is where
| File | Purpose |
|---|---|
| `index.html` | The whole frontend. |
| `server.js` | Express app: `/api/health`, `/api/auth/*`, `/api/projects/*`, `/api/edit` (Gemini). |
| `auth.js`, `security.js`, `web.js` | Register/login/logout logic, Origin + CSRF checks, session and cookie wiring. |
| `api.js`, `projects.js`, `store.js`, `users.js`, `passwords.js`, `db.js` | Project rules, Express wrapper, SQL, Argon2id hashing, connection. |
| `migrations/`, `migrate.js`, `scripts/` | Versioned SQL migrations and the operator scripts (`migrate`, `assign-legacy`). |
| `test/` | Automated tests (`npm test`). |

## How accounts and ownership work
- **Sign-up/login** with email + password. Passwords are stored only as Argon2id hashes (19 MiB, 2 passes). Minimum 10 characters.
- **Sessions are server-side** in Postgres (`express-session` + `connect-pg-simple`). The browser only holds an opaque, signed session id in an `HttpOnly`, `Secure`, `SameSite=None` cookie named `__Host-lf.sid`. No password or token is kept in localStorage. Sessions last 7 days and are destroyed on logout. A new session id is issued at every login (no fixation).
- **CSRF**: because the page and API are different sites, every state-changing request must (1) come from an allowed `Origin` (exact list, never `*`) and (2) carry the per-session `X-CSRF-Token`. Credentialed CORS is limited to `ALLOWED_ORIGINS`.
- **Ownership**: every project row has `user_id` (a foreign key to `users`). The user id comes only from the session; ids sent in request bodies are ignored. Every query filters on `user_id`, so another user's project is simply "not found". `/api/edit` requires login and, when a project id is given, ownership.
- **There is no publish/deploy endpoint** in the code today. When one is added it must live under `/api/projects/...` (already login-protected) and use the same ownership checks.

## Your two existing projects (legacy)
They stay in the database exactly as they are. Migration `002` only adds columns; it does not touch their data. They have no owner (`user_id` is NULL), so **no account can see them**.
To attach them to your account (one time, after you register):
1. Deploy, then open the app **in the same browser you used before** and log in.
2. The dashboard shows "2 projects from before accounts were found for this browser" with an **Add to my account** button. This works because that browser still holds the old private token. Click it. (The token is then removed from the browser.)
3. If that browser data is gone, use the operator script instead (see "Rescue script").

## Environment variables
See `.env.example`. New for accounts: `SESSION_SECRET` (**required in production**, 32+ random characters), `NODE_ENV=production`, `COOKIE_SAMESITE`, `SESSION_DAYS`, `MIGRATION_DATABASE_URL` (optional), `AUTO_MIGRATE` (local only). Existing: `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ALLOWED_ORIGINS`.

## Run locally
```
npm install
cp .env.example .env          # fill in GEMINI_API_KEY, DATABASE_URL (a Neon DEV branch), SESSION_SECRET
npm run migrate               # shows what would run
npm run preflight             # read-only schema check
npm run migrate -- --apply --confirm-host <host>   # applies it (to the DEV branch)
npm start                     # open http://localhost:3000
```
Locally the page talks to your local server and cookies use `SameSite=Lax` over http. This does not prove production behaviour (see "Verify the real origins").

## Social sign-in (Google, GitHub, Apple)
Implemented but **off by default**: a provider is live only when its environment variables are set and the optional migration `003_oauth.sql` has been applied by you (`npm run migrate -- --with-optional --apply`; it is skipped by startup, `AUTO_MIGRATE` and a plain `--apply`). See **OAUTH.md** for the variables, provider-console steps, callback URLs, the safe procedure, what was and was not verified, and why "Forgot password" is not included. `npm run oauth:check` shows what is configured (no secret values are printed).

## Tests
```
npm test                                                  # no database needed
TEST_DATABASE_URL="postgres://YOURMACUSERNAME@localhost:5432/launchforge_test" npm test   # also runs the Postgres tests
node --test --test-reporter=spec test/*.test.js           # list every test and skip reasons
```
Database tests are guarded (`test/_guard.js`, unit-tested in `test/guard.test.js`): they run only when `TEST_DATABASE_URL` is a `localhost` address, and never when it is the same database as `DATABASE_URL` or `MIGRATION_DATABASE_URL` (shell or `.env`). A cloud or production address is refused even if it is stored nowhere on your Mac, and there is no setting or environment variable that can allow a remote test database. Use a freshly created, EMPTY database: the tests create tables and test users in it and delete the rows they create. One migration test runs inside a transaction that is rolled back.

Tests are isolated from your real `.env`: the Express tests blank `DATABASE_URL`, `MIGRATION_DATABASE_URL` and `GEMINI_API_KEY` before the server loads, use in-memory storage and a fake password hasher, and never call Gemini. `test/safety.test.js` pins these rules (read-only preflight, guarded apply, no auto-migration in production, no secrets in `.env.example`).

**Easiest safe database for the Postgres tests: a local one on your Mac** (nothing in the cloud), for example with Postgres.app or Homebrew `postgresql@16`: create an empty database called `launchforge_test` and use `TEST_DATABASE_URL="postgres://YOURMACUSERNAME@localhost:5432/launchforge_test" npm test`. Keep the `YOURMACUSERNAME@` part: without it the app treats the database as remote and demands SSL.

## Deploy to production (do these in order; nothing here has been done for you)
1. **Back up first.** Neon console > Branches > New branch from `main` (instant, free). Optionally also `pg_dump "$DATABASE_URL" -t projects > projects-backup.sql`.
2. **Preflight (read-only).** `DATABASE_URL="<main string>" npm run preflight` compares the REAL `projects` table with what migrations 001/002 and the app expect, and prints exactly what each migration would create/alter and what happens to your existing rows. It runs in a READ ONLY transaction that is always rolled back. Exit code 2 / `BLOCKED` means stop: for example a Stage 1 table that lacks `legacy_local_id` or `updated_at` (`CREATE TABLE IF NOT EXISTS` would not add them). Do not continue until the result says no blocking problems. Optionally also check by hand in the Neon SQL editor: `SELECT id, name, created_at, legacy_local_id, left(owner_id,8) AS owner_prefix FROM projects ORDER BY created_at;`
3. **Rehearse on a copy.** The Neon branch from step 1 is a copy of production data. Run steps 2 and 4 against that branch's connection string first and confirm both projects are unchanged.
4. **Dry-run, then apply on `main`:** `DATABASE_URL="<main string>" npm run migrate` prints the preflight and changes nothing. To apply, you must pass the host you reviewed: `npm run migrate -- --apply --confirm-host <host printed above>`. It refuses when the preflight is blocked or the host does not match. Migrations are additive; nothing is dropped, truncated or rewritten, and nothing is assigned to a user. Re-run the SELECT from step 2: both rows must be unchanged, with `user_id` empty. Without `schema_migrations` both migrations are listed as pending; they are recorded only because they actually ran (as no-ops where the schema already matches).
5. **Render > Environment**: add `SESSION_SECRET` (generate it as shown in `.env.example`), `NODE_ENV=production`. Keep `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ALLOWED_ORIGINS=https://pixelated-byte.github.io`. Leave `AUTO_MIGRATE` unset.
6. `npm install` (updates `package-lock.json` for the new packages), check `git status` does not list `.env`, commit, push. Render redeploys; GitHub Pages updates the frontend.
7. **Verify** (below), starting from `https://launchforge-4a6u.onrender.com/` (same-origin). Then register an account.
8. **Attach your two existing projects, on purpose.** Nothing is assigned automatically. Use the rescue script below: first the dry run (it only lists the projects and their ids), then `--ids ID1,ID2 --apply` with the two ids. (The in-browser "claim" button only works on the web address whose browser still holds the old anonymous token, which is the GitHub Pages address, not the Render address.)

Until step 4 is done the new backend answers account/project calls with `503 SCHEMA_OUTDATED` (and `/api/health` shows `"database":"needs_migration"`), rather than touching the database.

## Verify the real origins (cannot be proven by the automated tests)
1. `https://launchforge-4a6u.onrender.com/api/health` shows `"database":"connected"` and `"authConfigured":true`.
2. Open `https://launchforge-4a6u.onrender.com/` first, then also https://pixelated-byte.github.io/LaunchForge/, sign up, reload: you should still be logged in. In DevTools > Application > Cookies for the Render domain, `__Host-lf.sid` must be HttpOnly, Secure, SameSite=None.
3. Repeat in **Chrome, Firefox and Safari**, and in a private window.
4. Create a project, apply an AI edit, log out, confirm the project list is empty/login-gated, log in as a second account and confirm you cannot see the first account's projects.

### Known cross-site cookie risk (important)
GitHub Pages and Render are different sites, so the session cookie is a third-party cookie. **Safari blocks these by default** (and some Chrome/Brave privacy settings do too); login may appear to succeed but not persist. If that happens, either use the app from `https://launchforge-4a6u.onrender.com/` (the backend serves the same page, same-origin, and cookies then work everywhere), or move the frontend and API under one domain you own (for example `app.example.com` and `api.example.com`) and set `COOKIE_SAMESITE=lax`. Decide before announcing the product.

## Rescue script (operator only)
If the old browser data is gone, attach legacy projects to an account by id. Dry run by default:
```
DATABASE_URL="<main string>" node scripts/assign-legacy.js --email you@example.com
DATABASE_URL="<main string>" node scripts/assign-legacy.js --email you@example.com --ids ID1,ID2 --apply
```
It only moves projects that have no owner, only to an account that already exists, and `--apply` is refused unless you name the projects with `--ids` (it never assigns "everything unclaimed" for you).

## Rollback
- Code: revert the commit (or use Render's rollback). The old backend works on the new schema (extra columns, `owner_id` now nullable); projects it creates are unowned until claimed.
- Data: the migration deletes nothing. To restore fully, use the Neon branch from step 1. Do not drop `users`/`user_sessions` unless you are abandoning accounts.

## Limits and honest notes
- Registration reveals whether an email is taken (there is no email verification or password reset yet). Login errors are generic. Both are rate limited in memory per instance (reset on restart).
- No email verification, password reset, account deletion, or 2FA yet.
- Neon free tier: every logged-in request reads its session from Postgres, and expired sessions are pruned at login (no background timer, so the database can still sleep).
- Dependencies are not audited here; run `npm audit` after installing.
