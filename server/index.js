import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '0.0.0.0';
// Production: Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN). Development: a local file.
const DB_URL = process.env.TURSO_DATABASE_URL || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tiyulim.db');

// On Render the local disk is wiped on every deploy: never run there without Turso, or data would be lost.
if (process.env.RENDER && !process.env.TURSO_DATABASE_URL) {
  console.error('✖ TURSO_DATABASE_URL חסר ב־Render. השרת לא יעלה על קובץ זמני כדי לא לאבד נתונים.');
  process.exit(1);
}

const { server, db } = await createApp({
  dbUrl: DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  setupCode: process.env.SETUP_CODE,             // one-time secret for creating the first מג״ד (see README)
  secureCookies: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
});

server.listen(PORT, HOST, async () => {
  console.log(`טופס טיולים גדודי פועל: http://localhost:${PORT}`);
  console.log(`מסד נתונים: ${process.env.TURSO_DATABASE_URL ? 'Turso' : DB_URL}`);
  const done = await db.get(`SELECT 1 AS x FROM app_settings WHERE key = 'setup_completed_at'`);
  if (!done) {
    console.log(process.env.SETUP_CODE
      ? '\nהמערכת ממתינה למג״ד: היכנסו לאפליקציה ובחרו "הקמת מג״ד ראשון" עם קוד ההקמה (SETUP_CODE).\n'
      : '\n⚠ אין עדיין מג״ד. הגדירו SETUP_CODE (לפחות 12 תווים), או מקומית: npm run create-admin\n');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
