# LaunchForge

Website builder for freelancers. Frontend: `index.html` (GitHub Pages). Backend: `server.js` (Render): Gemini AI editor plus project storage in Neon Postgres.

## Files
| File | Purpose |
|---|---|
| `index.html` | The whole frontend (active file). |
| `server.js` | Express backend: `/api/health`, `/api/edit` (Gemini), `/api/projects` (storage). |
| `api.js`, `projects.js`, `store.js`, `db.js`, `schema.sql` | Project storage: API rules, Express wrapper, SQL, connection, table definition. |
| `test/` | Automated tests (`npm test`). |
| `script.js`, `style.css`, `index.html.pre-api-fix`, `index.html.broken-backup` | Old files kept untouched; the app does not use them. |

## How saving works (Stage 1)
- **Server-saved projects** live in Neon Postgres and autosave about 2 seconds after each change (including AI edits). The badge shows Saving / Saved to server / Save failed.
- **Local-only projects** (the old behaviour) stay in your browser's localStorage and are labelled "Local only". If the server is unavailable, new projects are local-only.
- **No accounts yet.** Your browser holds a random anonymous token; the server only stores its hash. Anyone who obtains that token can read those projects, clearing site data loses it, and it does not work across devices. Do not store sensitive information. Real accounts are a later stage.
- If a save fails, your edits stay in a recovery copy in the browser and are offered back when you reopen the project. If the server copy changed meanwhile, you choose which version to keep. Nothing is overwritten silently.
- **Import:** on the dashboard, "Import to server" copies local projects up. It never deletes local copies and never overwrites existing server data. "Download backup" saves your raw browser data as a JSON file.

## One-time setup

### 1. Install tools (MacBook)
In Terminal: `node -v`. You need Node 20 or newer. If missing: install from https://nodejs.org (LTS) or run `brew install node`.

### 2. Create the free Neon database
1. Sign up at https://neon.com (no card needed) and create a project. Choose a region close to your Render service.
2. In the project dashboard click **Connect**, pick branch `main`, and turn **Connection pooling** on. Copy the string (it looks like `postgresql://user:password@ep-...-pooler....neon.tech/neondb?sslmode=require`). This is a secret: never paste it into chat, Git, or the frontend.
3. Create a second branch for local work and tests: **Branches > New branch**, name it `dev`, and copy its connection string the same way.
4. Free-plan limits change; check the plan page in your Neon console. The free compute sleeps after about 5 idle minutes, so the first request afterwards is slower.

The table is created automatically on first use; you do not run any SQL by hand.

### 3. Run locally
```
cd path/to/LaunchForge-Stage1
npm install
cp .env.example .env
```
Open `.env` in a text editor and fill in `GEMINI_API_KEY` and `DATABASE_URL` (use the **dev** branch string). Then:
```
npm start
```
Open http://localhost:3000 (not the file directly). When served from localhost the page talks to your local server, never production. Check http://localhost:3000/api/health: expect `"aiConfigured":true` and `"database":"connected"`.

To try the "server not configured" fallback, leave `DATABASE_URL` empty and restart: the app works in local-only mode and the AI editor still works.

### 4. Run the tests
```
npm test                                  # everything that needs no database
TEST_DATABASE_URL="<your dev branch string>" npm test   # also runs the Postgres tests
```
Database tests only touch rows they create and delete them afterwards. As a safety net they refuse to run (and say so) if `TEST_DATABASE_URL` points at the same database as your `DATABASE_URL` (shell or `.env`), so use the Neon **dev** branch. If the `test/` folder is missing, `npm test` now fails with a clear error instead of reporting 0 tests. Skipped tests are listed with the reason; for the full list run `node --test --test-reporter=spec test/*.test.js`.

### 5. Configure Render
1. Render dashboard > your `launchforge` web service > **Environment**.
2. Add `DATABASE_URL` = the **main** branch pooled string. Check that `GEMINI_API_KEY`, `GEMINI_MODEL` and `ALLOWED_ORIGINS` (`https://pixelated-byte.github.io`) are already set. Do not change them.
3. Save. Render redeploys. (If you push code first, add the variable before or right after; until it is set the app simply runs in local-only mode.)

### 6. Commit and deploy
```
npm install            # updates package-lock.json with the new "pg" dependency; commit it
git status             # confirm .env is NOT listed
git add -A
git commit -m "Stage 1: persistent project storage with autosave"
git push
```
A push updates GitHub Pages (frontend) and, if auto-deploy is on, Render (backend). Roll back by reverting the commit (`git revert HEAD && git push`) or using Render's rollback on a previous deploy.

### 7. Verify the deployed app
1. Open https://launchforge-4a6u.onrender.com/api/health (may take up to a minute if the service was asleep): expect `"database":"connected"` and the same `provider`/`model` as before.
2. Open https://pixelated-byte.github.io/LaunchForge/ (hard refresh). The dashboard note should say server storage is connected.
3. Create a project, generate a site, watch the badge go Saving, then Saved to server. Reload the page: the project is still there.
4. Apply an AI edit, wait for Saved, reload, and confirm the edit persisted. Export HTML and check it is the edited version.
5. Rename and delete a project; reload to confirm.
6. If you had old local projects, use **Import to server** and confirm they appear as "Saved on server".
7. Failure check: open the project, set the browser to offline (DevTools > Network > Offline), edit, and confirm "Save failed ... kept in this browser". Go back online and press Retry now.

## Free-tier risks
Limits can stop the database working (the app falls back to local-only and keeps recovery copies). Neon's restore window is short, so use **Download backup** now and then. The caps in `.env.example` limit abuse, but a public, login-less backend can still be used by strangers to fill your free storage.
