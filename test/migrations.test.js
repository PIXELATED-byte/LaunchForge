// Migration safety. Static checks always run; the Postgres checks need TEST_DATABASE_URL (a throwaway database, see _guard.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listMigrations, DIR } = require('../migrate');
const { testDb } = require('./_guard');

const G = testDb();
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');
const stripped = f => read(f).replace(/--.*$/gm, '');

test('migrations are numbered in order with no gaps', () => {
  const names = listMigrations();
  assert.deepEqual(names.map(n => n.split('_')[0]), names.map((_, i) => String(i + 1).padStart(3, '0')));
  assert.ok(names.includes('001_projects.sql') && names.includes('002_auth.sql'));
});

test('migrations never drop, truncate, delete or rewrite data', () => {
  for (const f of listMigrations()) {
    const sql = stripped(f);
    assert.ok(!/\b(DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA|DATABASE)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/i.test(sql), f + ' contains a destructive statement');
    assert.ok(!/ALTER\s+TABLE\s+projects\s+(RENAME|DROP)/i.test(sql), f);
  }
});

test('migrations are idempotent: every CREATE / ADD COLUMN is guarded', () => {
  for (const f of listMigrations()) {
    const sql = stripped(f);
    for (const c of sql.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)[^;]*/gi) || []) assert.match(c, /IF NOT EXISTS/i, f + ': ' + c.slice(0, 50));
    for (const c of sql.match(/ADD\s+COLUMN[^,;]*/gi) || []) assert.match(c, /IF NOT EXISTS/i, f + ': ' + c.slice(0, 50));
    for (const c of sql.match(/ADD\s+CONSTRAINT[\s\S]*?;/gi) || []) assert.ok(/pg_constraint/i.test(sql), f + ': constraint must be guarded');
  }
});

test('002 keeps the existing projects table and adds ownership with a foreign key and an owner CHECK', () => {
  const sql = stripped('002_auth.sql');
  assert.ok(!/CREATE\s+TABLE\s+(IF NOT EXISTS\s+)?projects\b/i.test(sql), 'must not recreate projects');
  assert.match(sql, /ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users\(id\)/i);
  assert.match(sql, /ON DELETE RESTRICT/i);
  assert.match(sql, /projects_has_owner/);
  assert.match(sql, /ALTER COLUMN owner_id DROP NOT NULL/i);
  assert.match(sql, /UNIQUE INDEX IF NOT EXISTS users_email_uq/i);
});

if (!G.url) {
  test('postgres migration tests', { skip: G.skip }, () => {});
} else {
  process.env.DATABASE_URL = G.url;
  const db = require('../db');
  const { applyMigrations, pendingMigrations } = require('../migrate');
  test.after(async () => { await db.close(); });

  test('[postgres] existing (legacy) projects survive migration 002 byte-for-byte and stay unowned', async () => {
    const c = await db.getPool().connect();
    try {
      await c.query('BEGIN');                                     // everything below is rolled back: nothing persists
      await c.query('CREATE SCHEMA mig_test'); await c.query('SET LOCAL search_path TO mig_test');
      await c.query(read('001_projects.sql'));                   // the schema production already has
      const html = '<!DOCTYPE html><html><body>Existing site \u2713</body></html>';
      await c.query("INSERT INTO projects (owner_id, name, business_type, html, legacy_local_id, history) VALUES ('legacyhash1','Roast','cafe',$1,'p1','[]'::jsonb), ('legacyhash1','Northline','consulting','<html>2</html>','p2','[]'::jsonb)", [html]);
      const before = (await c.query('SELECT * FROM projects ORDER BY name')).rows;
      await c.query(read('002_auth.sql')); await c.query(read('002_auth.sql'));        // twice: idempotent
      const after = (await c.query('SELECT * FROM projects ORDER BY name')).rows;
      assert.equal(after.length, 2);
      for (let i = 0; i < 2; i++) {
        for (const k of Object.keys(before[i])) assert.deepEqual(after[i][k], before[i][k], 'column ' + k + ' changed');
        assert.equal(after[i].user_id, null); assert.equal(after[i].claimed_at, null);
      }
      assert.equal(after.find(r => r.name === 'Roast').html, html);
      // constraints
      await c.query('SAVEPOINT s1');
      await assert.rejects(() => c.query("INSERT INTO projects (user_id, name) VALUES (gen_random_uuid(), 'orphan')"), e => e.code === '23503');   // FK: no such user
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await assert.rejects(() => c.query("INSERT INTO projects (owner_id, user_id, name) VALUES (NULL, NULL, 'ownerless')"), e => e.code === '23514');  // owner CHECK
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  test('[postgres] applyMigrations is repeatable and leaves nothing pending', async () => {
    await applyMigrations(db.getPool());
    assert.deepEqual(await applyMigrations(db.getPool()), []);
    assert.deepEqual(await pendingMigrations(db.getPool()), []);
    assert.equal(await db.status(), 'connected');
  });

  test('[postgres] database rules: unique email, normalized email, unique legacy id per user, FK blocks deleting an owner with projects', async () => {
    await applyMigrations(db.getPool());
    const tag = Date.now() + '' + Math.floor(Math.random() * 1e6);
    const u = (await db.query("INSERT INTO users (email, password_hash) VALUES ($1,'h') RETURNING id", [`mig${tag}@example.com`])).rows[0].id;
    try {
      await assert.rejects(() => db.query("INSERT INTO users (email, password_hash) VALUES ($1,'h')", [`mig${tag}@example.com`]), e => e.pgCode === '23505');
      await assert.rejects(() => db.query("INSERT INTO users (email, password_hash) VALUES ($1,'h')", [`MIXED${tag}@Example.com`]), e => e.pgCode === '23514');
      await db.query("INSERT INTO projects (user_id, name, legacy_local_id) VALUES ($1,'a','L1')", [u]);
      await assert.rejects(() => db.query("INSERT INTO projects (user_id, name, legacy_local_id) VALUES ($1,'b','L1')", [u]), e => e.pgCode === '23505');
      await assert.rejects(() => db.query('DELETE FROM users WHERE id=$1', [u]), e => e.pgCode === '23503');
    } finally { await db.query('DELETE FROM projects WHERE user_id=$1', [u]); await db.query('DELETE FROM users WHERE id=$1', [u]); }
  });

  test('[postgres] legacy rows are claimable only by token hash, atomically, once', async () => {
    await applyMigrations(db.getPool());
    const { pgStore } = require('../store'); const { pgUsers } = require('../users');
    const tag = Date.now() + '' + Math.floor(Math.random() * 1e6); const hash = 'legacyhash' + tag;
    const [a, b] = [await pgUsers.create(`ca${tag}@example.com`, 'h'), await pgUsers.create(`cb${tag}@example.com`, 'h')];
    try {
      await db.query("INSERT INTO projects (owner_id, name, legacy_local_id) VALUES ($1,'Old1','p1'), ($1,'Old2','p2')", [hash]);
      assert.equal((await pgStore.list(a.id)).length, 0, 'invisible before claim');
      assert.equal((await pgStore.previewLegacy(hash)).length, 2);
      assert.equal(await pgStore.claimLegacy(a.id, 'wrong-hash'), 0);
      const [x, y] = await Promise.all([pgStore.claimLegacy(a.id, hash), pgStore.claimLegacy(b.id, hash)]);
      assert.equal(x + y, 2, 'each row is claimed exactly once across racing accounts');
      assert.equal((await pgStore.list(a.id)).length + (await pgStore.list(b.id)).length, 2);
      assert.equal(await pgStore.claimLegacy(a.id, hash), 0);
    } finally {
      for (const u of [a, b]) { await db.query('DELETE FROM projects WHERE user_id=$1', [u.id]); await db.query('DELETE FROM users WHERE id=$1', [u.id]); }
      await db.query('DELETE FROM projects WHERE owner_id=$1', [hash]);
    }
  });
}
