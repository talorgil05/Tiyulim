// Command line tools (run locally, or against Turso with TURSO_DATABASE_URL + TURSO_AUTH_TOKEN set):
//   npm run create-admin -- "<full name>" <phone>     → creates a מג״ד and prints a temporary password
//   npm run reset-password -- "<full name>"           → prints a new temporary password
//   npm run seed-demo                                  → LOCAL ONLY: demo accounts for every role and company
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { hashPassword, randomPassword } from './auth.js';
import { ROLES, COMPANIES } from './constants.js';
import { normalizeName } from './names.js';

for (const k of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'DB_PATH']) if (process.env[k] !== undefined) process.env[k] = process.env[k].trim();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.TURSO_DATABASE_URL || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tiyulim.db');
const [cmd, arg1, arg2] = process.argv.slice(2);
const db = await openDb(DB_URL, process.env.TURSO_AUTH_TOKEN);

try {
  if (cmd === 'create-admin') {
    const name = normalizeName(arg1);
    const phone = String(arg2 || '').replace(/\D/g, '');
    if (!name || phone.length !== 10) throw new Error('שימוש: npm run create-admin -- "<שם מלא>" <טלפון 10 ספרות>');
    const pw = randomPassword();
    await db.run(`INSERT INTO users (full_name, phone, password_hash, kind, created_at) VALUES (?, ?, ?, 'admin', ?)`,
      name, phone, await hashPassword(pw), new Date().toISOString());
    console.log(`נוצר מג״ד "${name}". סיסמה זמנית: ${pw}`);
  } else if (cmd === 'reset-password') {
    const name = normalizeName(arg1);
    if (!name) throw new Error('שימוש: npm run reset-password -- "<שם מלא>"');
    const pw = randomPassword();
    const r = await db.run('UPDATE users SET password_hash = ? WHERE full_name = ? AND deleted_at IS NULL', await hashPassword(pw), name);
    if (!r.changes) throw new Error('המשתמש לא נמצא');
    await db.run('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE full_name = ?)', name);
    console.log(`סיסמה חדשה ל־${name}: ${pw}`);
  } else if (cmd === 'seed-demo') {
    // LOCAL DEMO ONLY: one account per role and company, all with the password "demo1234".
    if (process.env.TURSO_DATABASE_URL) throw new Error('seed-demo רץ רק על מסד מקומי');
    const hash = await hashPassword('demo1234');
    const now = new Date().toISOString();
    for (const [i, r] of ROLES.entries()) {
      await db.run(`INSERT OR IGNORE INTO users (full_name, phone, password_hash, kind, role_key, created_at) VALUES (?, ?, ?, 'officer', ?, ?)`,
        `קצין ${r.label}`, `05000001${String(i).padStart(2, '0')}`, hash, r.key, now);
    }
    for (const [i, c] of COMPANIES.entries()) {
      await db.run(`INSERT OR IGNORE INTO users (full_name, phone, password_hash, kind, company_key, created_at) VALUES (?, ?, ?, 'company', ?, ?)`,
        `רס״פ ${c}`, `05000002${String(i).padStart(2, '0')}`, hash, c, now);
    }
    console.log('נוצרו משתמשי דמו (סיסמה demo1234): "קצין ק. רכב" … ו־"רס״פ א" …');
  } else {
    throw new Error('פקודות: create-admin, reset-password, seed-demo');
  }
} catch (e) {
  console.error('✖', e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
