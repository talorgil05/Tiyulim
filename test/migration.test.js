// A database made by the first version (username login) is upgraded in place: every account,
// round, signature and session is kept, login works with the full name, and a duplicate name gets "(2)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';

test('v1 database → v2 (login by full name, phone, pending)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiyulim-mig-'));
  const file = path.join(dir, 'v1.db');
  fs.copyFileSync(new URL('./fixtures/v1.db', import.meta.url), file);

  const db = await openDb(file);
  const users = await db.all('SELECT id, full_name, phone, kind, role_key, company_key FROM users ORDER BY id');
  assert.deepEqual(users.map((u) => [u.id, u.full_name, u.kind]), [
    [1, 'סא״ל ישראל', 'admin'], [2, 'קצין רכב', 'officer'], [3, 'קצין רכב (2)', 'officer'], [4, 'רס״פ א', 'company'],
  ]);
  assert.ok(users.every((u) => u.phone === ''));
  const cols = (await db.all('PRAGMA table_info(users)')).map((c) => c.name);
  assert.ok(!cols.includes('username'));
  assert.ok(cols.includes('onboarded_at') && cols.includes('deleted_at'));
  // v3: the old whole-role signature is kept as one "<area>.legacy" row
  const sigs = await db.all('SELECT * FROM signatures');
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].item_key, 'rechev.legacy');
  assert.equal(sigs[0].signer_name, 'קצין רכב');
  assert.equal((await db.all('SELECT * FROM sessions')).length, 1);
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
  // the new kind is accepted, and the setup triggers are back
  await db.run(`INSERT INTO users (full_name, phone, password_hash, kind, created_at) VALUES ('חדש חדש', '0501112233', 'x', 'pending', 'now')`);
  const triggers = (await db.all(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)).map((t) => t.name).sort();
  assert.deepEqual(triggers, ['trg_setup_done', 'trg_setup_done_update']);
  db.close();

  // opening again does nothing more
  const db2 = await openDb(file);
  assert.equal((await db2.all('SELECT * FROM users')).length, 5);
  db2.close();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows */ }
});
