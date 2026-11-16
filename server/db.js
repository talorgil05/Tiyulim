import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('admin','officer','company')),
  role_key TEXT,
  company_key TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'officer') = (role_key IS NOT NULL)),
  CHECK ((kind = 'company') = (company_key IS NOT NULL))
);

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

-- One signature per round + company + staff role: a second signature is impossible.
CREATE TABLE IF NOT EXISTS signatures (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  company_key TEXT NOT NULL,
  role_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  signer_name TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  PRIMARY KEY (round_id, company_key, role_key)
);

-- The מג״ד's final approval, one per round + company.
CREATE TABLE IF NOT EXISTS approvals (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  company_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  approver_name TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (round_id, company_key)
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
`;

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
  return db;
}
