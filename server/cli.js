// Command line tools (run locally, or against Turso with TURSO_DATABASE_URL + TURSO_AUTH_TOKEN set):
//   npm run create-admin -- <username> "<full name>"     → creates a מג״ד and prints a temporary password
//   npm run reset-password -- <username>                 → prints a new temporary password
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { hashPassword, randomPassword } from './auth.js';
import { ROLES, COMPANIES } from './constants.js';

for (const k of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'DB_PATH']) if (process.env[k] !== undefined) process.env[k] = process.env[k].trim();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_URL = process.env.TURSO_DATABASE_URL || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tiyulim.db');
const [cmd, username, fullName] = process.argv.slice(2);
const db = await openDb(DB_URL, process.env.TURSO_AUTH_TOKEN);

try {
  if (cmd === 'create-admin') {
    if (!username || !fullName) throw new Error('שימוש: npm run create-admin -- <שם משתמש> "<שם מלא>"');
    const pw = randomPassword();
    await db.run(`INSERT INTO users (full_name, username, password_hash, kind, created_at) VALUES (?, ?, ?, 'admin', ?)`,
      fullName, username, await hashPassword(pw), new Date().toISOString());
    console.log(`נוצר מג״ד "${fullName}". שם משתמש: ${username}  סיסמה זמנית: ${pw}`);
  } else if (cmd === 'reset-password') {
    if (!username) throw new Error('שימוש: npm run reset-password -- <שם משתמש>');
    const pw = randomPassword();
    const r = await db.run('UPDATE users SET password_hash = ? WHERE username = ?', await hashPassword(pw), username);
    if (!r.changes) throw new Error('המשתמש לא נמצא');
    await db.run('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)', username);
    console.log(`סיסמה חדשה ל־${username}: ${pw}`);
  } else if (cmd === 'seed-demo') {
    // LOCAL DEMO ONLY: one account per role and company, all with the password "demo1234".
    if (process.env.TURSO_DATABASE_URL) throw new Error('seed-demo רץ רק על מסד מקומי');
    const hash = await hashPassword('demo1234');
    const now = new Date().toISOString();
    for (const r of ROLES) {
      await db.run(`INSERT OR IGNORE INTO users (full_name, username, password_hash, kind, role_key, created_at) VALUES (?, ?, ?, 'officer', ?, ?)`,
        `קצין ${r.label}`, r.key, hash, r.key, now);
    }
    for (const [i, c] of COMPANIES.entries()) {
      await db.run(`INSERT OR IGNORE INTO users (full_name, username, password_hash, kind, company_key, created_at) VALUES (?, ?, ?, 'company', ?, ?)`,
        `רס״פ ${c}`, `co${i + 1}`, hash, c, now);
    }
    console.log('נוצרו משתמשי דמו (סיסמה demo1234): קצינים לפי מפתח התפקיד (rechev, lag, …), פלוגות co1…co10');
  } else {
    throw new Error('פקודות: create-admin, reset-password, seed-demo');
  }
} catch (e) {
  console.error('✖', e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
