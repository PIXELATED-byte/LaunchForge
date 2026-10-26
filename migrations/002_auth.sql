-- Stage 2: accounts, sessions, project ownership.
-- Additive and idempotent: nothing is dropped, truncated or rewritten. Existing projects keep every column and value.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,                       -- stored normalized (trimmed, lower-case)
  password_hash text NOT NULL,               -- Argon2id hash; never the password
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (email);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_normalized' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)));
  END IF;
END $$;

-- Server-side sessions (table layout used by connect-pg-simple).
CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

-- Ownership. Legacy rows keep owner_id (hash of the old anonymous token) and get user_id NULL until claimed.
-- Rows with user_id NULL are invisible to every account.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE projects ALTER COLUMN owner_id DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_has_owner' AND conrelid = 'projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_has_owner CHECK (user_id IS NOT NULL OR owner_id IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON projects (user_id, updated_at DESC) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projects_user_legacy_uq ON projects (user_id, legacy_local_id) WHERE user_id IS NOT NULL AND legacy_local_id IS NOT NULL;
