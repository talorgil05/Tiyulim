import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, dummyVerify, newToken, tokenHash, randomPassword, AttemptLimiter } from './auth.js';
import { ROLES, ROLE_KEYS, ROLE_LABEL, COMPANIES, KINDS, KIND_LABEL } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 30;
const COOKIE = 'ty_session';
const CSRF_HEADER = 'tiyulim';

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (msg, code = 'invalid') => new HttpError(400, msg, code);
const forbidden = () => new HttpError(403, 'אין לך הרשאה לפעולה זו', 'forbidden');
const notFound = (msg = 'לא נמצא') => new HttpError(404, msg, 'not_found');
const conflict = (msg, code = 'conflict') => new HttpError(409, msg, code);

// ---------- validation ----------
const text = (v, field, { min = 1, max = 60 } = {}) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (s.length < min) throw bad(`יש למלא ${field}`);
  if (s.length > max) throw bad(`${field} ארוך מדי`);
  return s;
};
const password = (v) => {
  if (typeof v !== 'string' || v.length < 8 || v.length > 200) throw bad('סיסמה חייבת להכיל לפחות 8 תווים', 'password');
  return v;
};
const companyKey = (v) => { if (!COMPANIES.includes(v)) throw bad('פלוגה לא קיימת', 'company'); return v; };
const roleKey = (v) => { if (!ROLE_KEYS.includes(v)) throw bad('תפקיד לא קיים', 'role'); return v; };

const publicUser = (u) => u && ({
  id: u.id, full_name: u.full_name, username: u.username, kind: u.kind, kind_label: KIND_LABEL[u.kind],
  role_key: u.role_key, role_label: u.role_key ? ROLE_LABEL[u.role_key] : null, company_key: u.company_key,
  active: !!u.active, created_at: u.created_at,
});

/**
 * dbUrl: Turso URL (libsql://…) with authToken, or a local file path for development and tests.
 * setupCode: secret one-time code that lets the first מג״ד create an account. Dead once any מג״ד exists.
 */
export async function createApp({ dbUrl, authToken, setupCode, clock = () => new Date(), secureCookies = false, trustProxy = false, log = console } = {}) {
  const db = await openDb(dbUrl, authToken);
  const nowIso = () => clock().toISOString();

  const clientIp = (req) => {
    if (!trustProxy) return req.socket.remoteAddress;
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return xff[xff.length - 1] || req.socket.remoteAddress;
  };

  // ---------- first-admin setup code (same flow as תיאומון) ----------
  const SETUP_MIN_LEN = 12;
  const setupSecret = typeof setupCode === 'string' && setupCode.trim().length >= SETUP_MIN_LEN ? setupCode.trim() : null;
  if (setupCode && !setupSecret) log.error?.(`[setup] SETUP_CODE קצר מדי (לפחות ${SETUP_MIN_LEN} תווים) — הקמת מג״ד ראשון כבויה`);
  const setupLimiter = new AttemptLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const codeMatches = (given) => !!setupSecret && typeof given === 'string' && crypto.timingSafeEqual(sha(given.trim()), sha(setupSecret));
  const setupOpen = async (h = db) => !!setupSecret && !(await h.get(`SELECT 1 AS x FROM app_settings WHERE key = 'setup_completed_at'`));

  const loginLimiter = new AttemptLimiter({ max: 8 });

  // ---------- live updates (server-sent events) ----------
  const sseClients = new Set();
  let version = 0;
  function changed() {
    version++;
    for (const res of sseClients) res.write(`event: change\ndata: ${version}\n\n`);
  }

  // ---------- sessions ----------
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function cookieAttrs(req) {
    const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https';
    return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }
  async function currentUser(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const row = await db.get('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', tokenHash(token));
    if (!row) return null;
    if (row.expires_at < nowIso()) { await db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token)); return null; }
    if (!row.active) return null;
    return row;
  }
  async function startSession(res, req, userId) {
    const token = newToken();
    const exp = new Date(clock().getTime() + SESSION_DAYS * 864e5).toISOString();
    await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', tokenHash(token), userId, nowIso(), exp);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req)}; Max-Age=${SESSION_DAYS * 86400}`);
  }

  // ---------- round data ----------
  const openRound = (h = db) => h.get(`SELECT * FROM rounds WHERE status = 'open'`);
  /** The round everyone sees: the open one, otherwise the last closed one (read-only). */
  const shownRound = async () => (await openRound()) || db.get('SELECT * FROM rounds ORDER BY number DESC LIMIT 1');
  const roundView = (r) => r && ({
    id: r.id, number: r.number, status: r.status, opened_at: r.opened_at, opened_by_name: r.opened_by_name,
    closed_at: r.closed_at, closed_by_name: r.closed_by_name,
  });

  /** Forms of the given companies in a round: every role with its signature (or null) + the approval. */
  async function forms(roundId, companies) {
    const sigs = roundId ? await db.all('SELECT * FROM signatures WHERE round_id = ?', roundId) : [];
    const apps = roundId ? await db.all('SELECT * FROM approvals WHERE round_id = ?', roundId) : [];
    return companies.map((c) => {
      const roles = ROLES.map((r) => {
        const s = sigs.find((x) => x.company_key === c && x.role_key === r.key);
        return { key: r.key, label: r.label, signed: !!s, signer_name: s?.signer_name ?? null, signed_at: s?.signed_at ?? null };
      });
      const a = apps.find((x) => x.company_key === c);
      const signedCount = roles.filter((r) => r.signed).length;
      const status = a ? 'approved' : signedCount === ROLES.length ? 'awaiting_approval' : 'awaiting_signatures';
      return {
        company: c, roles, signed_count: signedCount, total: ROLES.length, status,
        approval: a ? { approver_name: a.approver_name, approved_at: a.approved_at } : null,
      };
    });
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, kinds, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, kinds, handler });
  };
  const PUBLIC = 'public';
  const ANY = null;
  const ADMIN = ['admin'];

  route('GET', '/api/health', PUBLIC, async () => ({ ok: (await db.get('SELECT 1 AS x')).x === 1, storage: db.storage }));
  route('GET', '/api/meta', PUBLIC, async () => ({ roles: ROLES, companies: COMPANIES, kinds: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })) }));
  route('GET', '/api/setup/status', PUBLIC, async () => ({ open: await setupOpen() }));

  /** First מג״ד: only with the secret setup code, only while no מג״ד exists. */
  route('POST', '/api/setup', PUBLIC, async ({ body, req, res }) => {
    const ip = clientIp(req);
    if (setupLimiter.blocked(ip)) throw new HttpError(429, 'יותר מדי ניסיונות. נסו שוב בעוד שעה', 'rate');
    const data = { full_name: text(body.full_name, 'שם מלא'), username: text(body.username, 'שם משתמש', { max: 40 }), password: password(body.password) };
    const hash = await hashPassword(data.password);
    const id = await db.tx(async (t) => {
      if (!(await setupOpen(t))) throw conflict('הקמת המערכת כבר הושלמה. קוד ההקמה אינו פעיל יותר', 'setup_closed');
      if (!codeMatches(body.setup_code)) { setupLimiter.fail(ip); throw new HttpError(403, 'קוד ההקמה שגוי', 'bad_setup_code'); }
      if (await t.get('SELECT 1 AS x FROM users WHERE username = ?', data.username)) throw conflict('שם המשתמש כבר תפוס', 'username_taken');
      return (await t.run(`INSERT INTO users (full_name, username, password_hash, kind, created_at) VALUES (?, ?, ?, 'admin', ?)`,
        data.full_name, data.username, hash, nowIso())).lastInsertRowid;
    });
    await startSession(res, req, id);
    return { user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', id)) };
  });

  route('POST', '/api/auth/login', PUBLIC, async ({ body, req, res }) => {
    const uname = typeof body.username === 'string' ? body.username.trim() : '';
    const pw = typeof body.password === 'string' ? body.password : '';
    const key = `${clientIp(req)}|${uname.toLowerCase()}`;
    if (loginLimiter.blocked(key)) throw new HttpError(429, 'יותר מדי ניסיונות התחברות. נסו שוב בעוד כמה דקות', 'rate');
    const u = uname ? await db.get('SELECT * FROM users WHERE username = ?', uname) : null;
    const ok = u ? await verifyPassword(pw, u.password_hash) : await dummyVerify(pw);
    if (!ok) { loginLimiter.fail(key); throw new HttpError(401, 'שם משתמש או סיסמה שגויים', 'bad_credentials'); }
    if (!u.active) throw new HttpError(403, 'החשבון מושבת. פנו למג״ד', 'inactive');
    loginLimiter.reset(key);
    await startSession(res, req, u.id);
    return { user: publicUser(u) };
  });

  route('POST', '/api/auth/logout', PUBLIC, async ({ req, res }) => {
    const token = parseCookies(req)[COOKIE];
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
    return { ok: true };
  });

  route('GET', '/api/auth/me', ANY, async ({ user }) => ({ user: publicUser(user) }));

  /**
   * The current state, scoped strictly to who is asking:
   *  officer → own signature (own role) for every company
   *  company → own company's form only
   *  admin   → every company's form
   */
  route('GET', '/api/state', ANY, async ({ user }) => {
    const r = await shownRound();
    const round = roundView(r);
    if (user.kind === 'officer') {
      const all = await forms(r?.id, COMPANIES);
      return {
        round,
        companies: all.map((f) => {
          const mine = f.roles.find((x) => x.key === user.role_key);
          return { company: f.company, signed: mine.signed, signer_name: mine.signer_name, signed_at: mine.signed_at };
        }),
      };
    }
    if (user.kind === 'company') return { round, form: (await forms(r?.id, [user.company_key]))[0] };
    return { round, forms: await forms(r?.id, COMPANIES) };
  });

  /** A staff officer signs for one company — always in the name of the role on their own account. */
  route('POST', '/api/sign', ['officer'], async ({ user, body }) => {
    const c = companyKey(body.company);
    if (body.role !== undefined && body.role !== user.role_key) throw new HttpError(403, 'אפשר לחתום רק בשם התפקיד שלך', 'wrong_role');
    await db.tx(async (t) => {
      const r = await openRound(t);
      if (!r) throw conflict('אין סבב פתוח. אי אפשר לחתום כרגע', 'no_round');
      const res = await t.run(`INSERT OR IGNORE INTO signatures (round_id, company_key, role_key, user_id, signer_name, signed_at)
        VALUES (?, ?, ?, ?, ?, ?)`, r.id, c, user.role_key, user.id, user.full_name, nowIso());
      if (!res.changes) throw conflict('כבר נחתם לפלוגה זו בסבב הנוכחי', 'already_signed');
    });
    changed();
    return { ok: true };
  });

  // --- מג״ד: rounds and final approval ---
  route('POST', '/api/rounds/open', ADMIN, async ({ user }) => {
    await db.tx(async (t) => {
      if (await openRound(t)) throw conflict('כבר יש סבב פתוח. יש לסיים אותו לפני פתיחת סבב חדש', 'round_open');
      const n = ((await t.get('SELECT MAX(number) AS n FROM rounds')).n || 0) + 1;
      await t.run(`INSERT INTO rounds (number, status, opened_at, opened_by, opened_by_name) VALUES (?, 'open', ?, ?, ?)`, n, nowIso(), user.id, user.full_name);
    });
    changed();
    return { round: roundView(await openRound()) };
  });

  route('POST', '/api/rounds/close', ADMIN, async ({ user }) => {
    await db.tx(async (t) => {
      const r = await openRound(t);
      if (!r) throw conflict('אין סבב פתוח', 'no_round');
      await t.run(`UPDATE rounds SET status = 'closed', closed_at = ?, closed_by = ?, closed_by_name = ? WHERE id = ?`, nowIso(), user.id, user.full_name, r.id);
    });
    changed();
    return { ok: true };
  });

  route('POST', '/api/approve', ADMIN, async ({ user, body }) => {
    const c = companyKey(body.company);
    await db.tx(async (t) => {
      const r = await openRound(t);
      if (!r) throw conflict('אין סבב פתוח', 'no_round');
      const { n } = await t.get('SELECT COUNT(*) AS n FROM signatures WHERE round_id = ? AND company_key = ?', r.id, c);
      if (n < ROLES.length) throw conflict(`חסרות חתימות (${n}/${ROLES.length}). אי אפשר לאשר עדיין`, 'missing_signatures');
      const res = await t.run('INSERT OR IGNORE INTO approvals (round_id, company_key, user_id, approver_name, approved_at) VALUES (?, ?, ?, ?, ?)',
        r.id, c, user.id, user.full_name, nowIso());
      if (!res.changes) throw conflict('הטופס כבר אושר', 'already_approved');
    });
    changed();
    return { ok: true };
  });

  route('GET', '/api/rounds', ADMIN, async () => {
    const rows = await db.all('SELECT * FROM rounds ORDER BY number DESC');
    const counts = await db.all('SELECT round_id, COUNT(*) AS n FROM approvals GROUP BY round_id');
    return { rounds: rows.map((r) => ({ ...roundView(r), approved: counts.find((c) => c.round_id === r.id)?.n || 0, total: COMPANIES.length })) };
  });

  route('GET', '/api/rounds/:id', ADMIN, async ({ params }) => {
    const r = await db.get('SELECT * FROM rounds WHERE id = ?', Number(params.id));
    if (!r) throw notFound('הסבב לא נמצא');
    return { round: roundView(r), forms: await forms(r.id, COMPANIES) };
  });

  // --- מג״ד: users ---
  route('GET', '/api/users', ADMIN, async () => ({
    users: (await db.all('SELECT * FROM users ORDER BY active DESC, kind, company_key, role_key, full_name')).map(publicUser),
  }));

  route('POST', '/api/users', ADMIN, async ({ body }) => {
    const kind = KINDS.includes(body.kind) ? body.kind : null;
    if (!kind) throw bad('יש לבחור סוג משתמש', 'kind');
    const data = {
      full_name: text(body.full_name, 'שם מלא'),
      username: text(body.username, 'שם משתמש', { max: 40 }),
      password: password(body.password),
      role_key: kind === 'officer' ? roleKey(body.role_key) : null,
      company_key: kind === 'company' ? companyKey(body.company_key) : null,
    };
    const hash = await hashPassword(data.password);
    let id;
    try {
      id = (await db.run('INSERT INTO users (full_name, username, password_hash, kind, role_key, company_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        data.full_name, data.username, hash, kind, data.role_key, data.company_key, nowIso())).lastInsertRowid;
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw conflict('שם המשתמש כבר תפוס', 'username_taken');
      throw e;
    }
    return { user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', id)) };
  });

  route('POST', '/api/users/:id/reset-password', ADMIN, async ({ params }) => {
    const u = await db.get('SELECT * FROM users WHERE id = ?', Number(params.id));
    if (!u) throw notFound('המשתמש לא נמצא');
    const pw = randomPassword();
    await db.tx(async (t) => {
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), u.id);
      await t.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    });
    return { password: pw };
  });

  route('POST', '/api/users/:id/active', ADMIN, async ({ user, params, body }) => {
    const id = Number(params.id);
    if (id === user.id) throw conflict('אי אפשר להשבית את החשבון שלך', 'self');
    const active = body.active ? 1 : 0;
    const res = await db.tx(async (t) => {
      const r = await t.run('UPDATE users SET active = ? WHERE id = ?', active, id);
      if (!active) await t.run('DELETE FROM sessions WHERE user_id = ?', id);
      return r;
    });
    if (!res.changes) throw notFound('המשתמש לא נמצא');
    return { ok: true };
  });

  // ---------- http plumbing (same as תיאומון) ----------
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  };
  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }
  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }
  function readBody(req, limit = 32 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'הבקשה גדולה מדי', 'too_large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
        catch { reject(bad('גוף הבקשה אינו JSON תקין')); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    try {
      if (pathname === '/api/events' && req.method === 'GET') {
        const user = await currentUser(req);
        if (!user) throw new HttpError(401, 'יש להתחבר', 'unauthenticated');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${version}\n\n`);
        sseClients.add(res);
        const hb = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
        return;
      }
      let match, rt;
      for (const r of routes) if (r.method === req.method && (match = r.re.exec(pathname))) { rt = r; break; }
      if (!rt) throw notFound('נתיב לא קיים');
      if (req.method !== 'GET') {
        // CSRF defence in depth (the cookie is SameSite=Strict as well)
        if (!String(req.headers['content-type'] || '').startsWith('application/json') || req.headers['x-requested-with'] !== CSRF_HEADER) {
          throw new HttpError(403, 'בקשה לא מורשית', 'csrf');
        }
      }
      const params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      const body = req.method === 'GET' ? {} : await readBody(req);
      let user = null;
      if (rt.kinds !== PUBLIC) {
        user = await currentUser(req);
        if (!user) throw new HttpError(401, 'יש להתחבר מחדש', 'unauthenticated');
        if (rt.kinds && !rt.kinds.includes(user.kind)) throw forbidden();
      }
      sendJson(res, 200, await rt.handler({ req, res, user, params, body }));
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
      log.error?.(e);
      sendJson(res, 500, { error: 'שגיאת שרת. נסו שוב', code: 'server' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('close', () => { for (const r of sseClients) r.end(); });
  return { server, db };
}
