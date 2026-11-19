import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { LEGACY_ROLE_MAP, ROLE_KEYS } from './constants.js';

// Users log in with their full name (unique, like תיאומון). A new registration is "pending" until the
// מג״ד gives it a permission. phone may be '' only for accounts created before phones were required.
const USERS_TABLE = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL DEFAULT '' CHECK (phone = '' OR (length(phone) = 10 AND phone NOT GLOB '*[^0-9]*')),
  password_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('admin','officer','company','pending')),
  role_key TEXT,
  company_key TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  onboarded_at TEXT,
  deleted_at TEXT,
  CHECK ((kind = 'officer') = (role_key IS NOT NULL)),
  CHECK ((kind = 'company') = (company_key IS NOT NULL))
);`;

// One signature per round + company + row (item): a second signature on the same row is impossible.
// item_key is "<area>.<n>" (see constants.js); role_key is the area that signed it.
const SIGNATURES_TABLE = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  company_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  role_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  signer_name TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  PRIMARY KEY (round_id, company_key, item_key)
);`;

const SCHEMA = `
${USERS_TABLE('users')}

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- A round is one weekly cycle. Only the מג״ד opens and closes it; at most one is open at a time.
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  opened_at TEXT NOT NULL,
  opened_by INTEGER REFERENCES users(id),
  opened_by_name TEXT NOT NULL,
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  closed_by_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_round ON rounds(status) WHERE status = 'open';

${SIGNATURES_TABLE('signatures')}

-- The מג״ד's final approval, one per round + company.
CREATE TABLE IF NOT EXISTS approvals (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  company_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  approver_name TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (round_id, company_key)
);

-- An officer may hold several areas (e.g. תקשוב + הדרכה). users.role_key is the first of them.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role_key TEXT NOT NULL,
  PRIMARY KEY (user_id, role_key)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- First-admin setup is one-time: once any מג״ד account exists, the setup code never works again.
CREATE TRIGGER IF NOT EXISTS trg_setup_done AFTER INSERT ON users WHEN NEW.kind = 'admin'
BEGIN
  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('setup_completed_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_setup_done_update AFTER UPDATE OF kind ON users WHEN NEW.kind = 'admin'
BEGIN
  INSERT OR IGNORE INTO app_settings (key, value) VALUES ('setup_completed_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
`;

/**
 * v1 → v2: login by full name (username dropped), phone, "pending" kind, onboarded_at, deleted_at.
 * SQLite can't change CHECK constraints in place, so the users table is rebuilt (the documented
 * create-copy-drop-rename procedure), all in one transaction with foreign keys off. Every row is kept;
 * a duplicate full name gets " (2)", " (3)"… so the name stays a unique login name.
 */
async function migrateUsersV2(db, client) {
  const cols = (await db.all('PRAGMA table_info(users)')).map((c) => c.name);
  if (!cols.includes('username')) return;
  console.log('[migration] users v2: התחברות לפי שם מלא, טלפון, ממתינים');
  try {
    await runRebuild(client);
  } catch (e) {
    try { await client.execute('ROLLBACK'); } catch { /* not in a transaction */ }
    try { await client.execute('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }
    throw e;
  }
}
/**
 * v2 → v3: the 11 staff roles became 21 areas, and every row of an area is its own signature.
 *  - officers keep their area when it still exists (LEGACY_ROLE_MAP); otherwise they become pending.
 *  - old whole-role signatures are kept as one row "<area>.legacy" each, so history still shows who signed.
 */
async function migrateAreasV3(db, client) {
  const cols = (await db.all('PRAGMA table_info(signatures)')).map((c) => c.name);
  if (cols.includes('item_key')) return;
  console.log('[migration] v3: תחומי אחריות — חתימה לכל שורה');
  const caseMap = `CASE role_key ${Object.entries(LEGACY_ROLE_MAP).map(([o, n]) => `WHEN '${o}' THEN '${n}'`).join(' ')} ELSE role_key END`;
  const known = ROLE_KEYS.map((k) => `'${k}'`).join(',');
  try {
    await client.executeMultiple(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      UPDATE users SET role_key = ${caseMap} WHERE kind = 'officer';
      UPDATE users SET kind = 'pending', role_key = NULL WHERE kind = 'officer' AND role_key NOT IN (${known});
      DROP TABLE IF EXISTS signatures_new;
      ${SIGNATURES_TABLE('signatures_new')}
      INSERT INTO signatures_new (round_id, company_key, item_key, role_key, user_id, signer_name, signed_at)
        SELECT round_id, company_key, (${caseMap}) || '.legacy', ${caseMap}, user_id, signer_name, signed_at FROM signatures;
      DROP TABLE signatures;
      ALTER TABLE signatures_new RENAME TO signatures;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } catch (e) {
    try { await client.execute('ROLLBACK'); } catch { /* not in a transaction */ }
    try { await client.execute('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * v4: the form is per calendar week, opened automatically (Monday 00:00 Israel) — no manual open/close.
 * A round now carries its ISO year/week and dates. Rounds that were opened by hand stay in history, closed.
 */
async function migrateWeeksV4(db) {
  const cols = (await db.all('PRAGMA table_info(rounds)')).map((c) => c.name);
  if (!cols.includes('iso_week')) {
    console.log('[migration] v4: טופס לפי שבוע קלנדרי');
    await db.exec(`
      ALTER TABLE rounds ADD COLUMN iso_year INTEGER;
      ALTER TABLE rounds ADD COLUMN iso_week INTEGER;
      ALTER TABLE rounds ADD COLUMN starts_on TEXT;
      ALTER TABLE rounds ADD COLUMN ends_on TEXT;
    `);
    await db.run(`UPDATE rounds SET status = 'closed', closed_at = ?, closed_by_name = 'מעבר לטופס שבועי'
      WHERE status = 'open'`, new Date().toISOString());
  }
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS one_round_per_week ON rounds(iso_year, iso_week) WHERE iso_week IS NOT NULL;');
  // v5: the מג״ד can edit past weeks — reopen one for the officers, and mark missing rows himself
  if (!cols.includes('reopened')) {
    const has = (await db.all('PRAGMA table_info(rounds)')).map((c) => c.name);
    if (!has.includes('reopened')) await db.exec('ALTER TABLE rounds ADD COLUMN reopened INTEGER NOT NULL DEFAULT 0;');
  }
  const sigCols = (await db.all('PRAGMA table_info(signatures)')).map((c) => c.name);
  if (!sigCols.includes('by_admin')) await db.exec('ALTER TABLE signatures ADD COLUMN by_admin INTEGER NOT NULL DEFAULT 0;');
  // v6: at registration a user says who he is (staff areas, or a company) — a request until the מג״ד approves it
  const userCols = (await db.all('PRAGMA table_info(users)')).map((c) => c.name);
  if (!userCols.includes('req_kind')) {
    await db.exec(`
      ALTER TABLE users ADD COLUMN req_kind TEXT;
      ALTER TABLE users ADD COLUMN req_roles TEXT;
      ALTER TABLE users ADD COLUMN req_company TEXT;
    `);
  }
}

function runRebuild(client) {
  return client.executeMultiple(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    DROP TABLE IF EXISTS users_new;
    ${USERS_TABLE('users_new')}
    INSERT INTO users_new (id, full_name, phone, password_hash, kind, role_key, company_key, active, created_at)
      SELECT u.id,
        CASE WHEN (SELECT COUNT(*) FROM users p WHERE p.full_name = u.full_name COLLATE NOCASE AND p.id < u.id) = 0 THEN u.full_name
          ELSE u.full_name || ' (' || ((SELECT COUNT(*) FROM users p WHERE p.full_name = u.full_name COLLATE NOCASE AND p.id < u.id) + 1) || ')' END,
        '', u.password_hash, u.kind, u.role_key, u.company_key, u.active, u.created_at
      FROM users u ORDER BY u.id;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/**
 * Small async layer over libSQL (same as תיאומון). The same code runs against
 *  - Turso in production:      url = libsql://<db>.turso.io + authToken
 *  - a local file in dev/tests: url = file:./data/tiyulim.db
 */
class Db {
  #exec;
  constructor(exec) { this.#exec = exec; }
  static rows(rs) {
    return rs.rows.map((r) => { const o = {}; rs.columns.forEach((c, i) => { o[c] = r[i]; }); return o; });
  }
  async all(sql, ...args) { return Db.rows(await this.#exec({ sql, args })); }
  async get(sql, ...args) { return (await this.all(sql, ...args))[0]; }
  async run(sql, ...args) {
    const rs = await this.#exec({ sql, args });
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
  }
}

class RootDb extends Db {
  #client; #queue = Promise.resolve();
  constructor(client) {
    super((stmt) => client.execute(stmt));
    this.#client = client;
  }
  /** Serialise writes (the app runs as one server). */
  #serial(fn) {
    const p = this.#queue.then(fn, fn);
    this.#queue = p.catch(() => {});
    return p;
  }
  async run(sql, ...args) { return this.#serial(() => super.run(sql, ...args)); }
  async exec(sql) { return this.#serial(() => this.#client.executeMultiple(sql)); }
  /** Write transaction: fn(t) gets get/all/run; commits if fn resolves, else rolls back. */
  tx(fn) {
    return this.#serial(async () => {
      const t = await this.#client.transaction('write');
      try {
        const out = await fn(new Db((stmt) => t.execute(stmt)));
        await t.commit();
        return out;
      } catch (e) {
        try { await t.rollback(); } catch { /* already closed */ }
        throw e;
      } finally { t.close(); }
    });
  }
  close() { this.#client.close(); }
}

/** dbUrl: "libsql://…" (Turso) or a file path / "file:…" for local use. */
export async function openDb(dbUrl, authToken) {
  let url = dbUrl;
  const local = !/^(libsql|https?|wss?):\/\//.test(url);
  if (local) {
    const p = url.replace(/^file:/, '');
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    url = `file:${p}`;
  }
  const client = createClient({ url, authToken, intMode: 'number' });
  if (local) await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const db = new RootDb(client);
  db.storage = local ? 'file' : 'turso';
  await db.exec(SCHEMA);
  await migrateUsersV2(db, client);
  await migrateAreasV3(db, client);
  await db.exec(SCHEMA);   // recreates the triggers that were dropped with the old users table
  await migrateWeeksV4(db);
  // every officer's main area is also in user_roles (accounts from before several areas existed)
  await db.run(`INSERT OR IGNORE INTO user_roles (user_id, role_key)
    SELECT id, role_key FROM users WHERE kind = 'officer' AND role_key IS NOT NULL`);
  await db.run(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE kind <> 'officer')`);
  return db;
}
