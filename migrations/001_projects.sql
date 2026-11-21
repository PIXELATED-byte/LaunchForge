-- LaunchForge Stage 1 schema. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,                 -- SHA-256 of the anonymous owner token (Stage 1). Becomes a user id when accounts exist.
  name text NOT NULL,
  business_type text NOT NULL DEFAULT 'other',
  description text NOT NULL DEFAULT '',
  audience text NOT NULL DEFAULT '',
  style text NOT NULL DEFAULT 'Modern',
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  html text NOT NULL DEFAULT '',
  mode text,
  generated_at timestamptz,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,     -- optimistic concurrency: bumps on every change
  legacy_local_id text,                   -- id of the browser-local project this was imported from
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_updated_idx ON projects (owner_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_legacy_uq ON projects (owner_id, legacy_local_id) WHERE legacy_local_id IS NOT NULL;
