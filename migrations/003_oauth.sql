-- 003: social sign-in (Google, GitHub, Apple). OPTIONAL: the app keeps working without it; social buttons stay off until it is applied.
-- Additive only. No existing user, password hash, session or project row is changed or removed.

-- Accounts created through a social provider have no password, so the hash must be allowed to be empty.
-- (Existing rows already have a hash and keep it. Password login for a user without a hash is always refused.)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- One row per provider account that is linked to a LaunchForge user. (provider, subject) is the provider's own stable user id.
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider   text        NOT NULL CHECK (provider IN ('google', 'github', 'apple')),
  subject    text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS oauth_identities_user_idx ON oauth_identities (user_id);
