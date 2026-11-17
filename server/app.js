import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, dummyVerify, newToken, tokenHash, randomPassword, AttemptLimiter } from './auth.js';
import { ROLES, ROLE_KEYS, ROLE_LABEL, COMPANIES, KINDS, KIND_LABEL, ITEM, rolesFor, roleApplies, canManageUsers, roleKeysOf } from './constants.js';
import { normalizeName, isValidName, NAME_TAKEN_MSG } from './names.js';

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
const password = (v) => {
  if (typeof v !== 'string' || v.length < 8 || v.length > 200) throw bad('סיסמה חייבת להכיל לפחות 8 תווים', 'password');
  return v;
};
const companyKey = (v) => { if (!COMPANIES.includes(v)) throw bad('פלוגה לא קיימת', 'company'); return v; };
const roleKey = (v) => { if (!ROLE_KEYS.includes(v)) throw bad('תפקיד לא קיים', 'role'); return v; };
/** Full name — also the login name (there is no separate username), as in תיאומון. */
const fullName = (v) => {
  const s = normalizeName(v);
  if (!s) throw bad('יש למלא שם מלא', 'full_name');
  if (!isValidName(s)) throw bad('שם מלא: 2–40 תווים, מתחיל באות (מותר גם מספרים, מקף, גרש ונקודה)', 'full_name');
  return s;
};
const phone10 = (v) => {
  const s = typeof v === 'string' ? v.replace(/[\s-]/g, '') : '';
  if (!/^\d{10}$/.test(s)) throw bad('מספר טלפון חייב להכיל בדיוק 10 ספרות', 'phone');
  return s;
};

const publicUser = (u) => {
  if (!u) return u;
  const keys = roleKeysOf(u);
  return {
    id: u.id, full_name: u.full_name, phone: u.phone, kind: u.kind, kind_label: KIND_LABEL[u.kind],
    role_key: keys[0] ?? null, role_keys: keys, role_label: keys.length ? keys.map((k) => ROLE_LABEL[k]).join(' + ') : null,
    company_key: u.company_key, active: !!u.active, created_at: u.created_at, onboarded: !!u.onboarded_at, can_manage_users: canManageUsers(u),
  };
};
/** Areas in the fixed display order. */
const sortRoles = (keys) => ROLE_KEYS.filter((k) => keys.includes(k));

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
  // a whole company may sign up together from one shared network (one public IP)
  const registerLimiter = new AttemptLimiter({ max: 150, windowMs: 60 * 60 * 1000 });
  const userById = async (id) => withRoles(await db.get('SELECT * FROM users WHERE id = ?', id));

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
    if (!row.active || row.deleted_at) return null;
    return withRoles(row);
  }
  /** Attach role_keys (all the officer's areas) to user rows; h = db or a transaction. */
  async function withRoles(u, h = db) {
    if (!u) return u;
    u.role_keys = u.kind === 'officer' ? sortRoles((await h.all('SELECT role_key FROM user_roles WHERE user_id = ?', u.id)).map((r) => r.role_key)) : [];
    if (u.kind === 'officer' && !u.role_keys.length && u.role_key) u.role_keys = [u.role_key];
    return u;
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

  /**
   * Forms of the given companies in a round: every area that applies to the company, each with its rows
   * (signed or not, by whom and when), plus the מג״ד's approval. Rounds from before the rows existed
   * have one "<area>.legacy" signature per area instead; they are shown as `legacy` on the area.
   */
  async function forms(roundId, companies) {
    const sigs = roundId ? await db.all('SELECT * FROM signatures WHERE round_id = ?', roundId) : [];
    const apps = roundId ? await db.all('SELECT * FROM approvals WHERE round_id = ?', roundId) : [];
    return companies.map((c) => {
      const mine = sigs.filter((x) => x.company_key === c);
      const areas = rolesFor(c).map((r) => {
        const items = r.items.map((it) => {
          const s = mine.find((x) => x.item_key === it.key);
          return { key: it.key, label: it.label, signed: !!s, signer_name: s?.signer_name ?? null, signed_at: s?.signed_at ?? null };
        });
        const old = mine.find((x) => x.item_key === `${r.key}.legacy`);
        const signed = items.filter((i) => i.signed).length;
        return {
          key: r.key, label: r.label, items, signed_count: signed, total: items.length, done: signed === items.length,
          legacy: old ? { signer_name: old.signer_name, signed_at: old.signed_at } : null,
        };
      });
      const a = apps.find((x) => x.company_key === c);
      const signedCount = areas.reduce((n, ar) => n + ar.signed_count, 0);
      const total = areas.reduce((n, ar) => n + ar.total, 0);
      const status = a ? 'approved' : signedCount === total ? 'awaiting_approval' : 'awaiting_signatures';
      return {
        company: c, areas, signed_count: signedCount, total, areas_done: areas.filter((ar) => ar.done).length, areas_total: areas.length, status,
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
  /** Who may assign permissions: the מג״ד, and the קשר״ג (everything except מג״ד). */
  const USER_MANAGERS = (u) => canManageUsers(u);

  route('GET', '/api/health', PUBLIC, async () => ({ ok: (await db.get('SELECT 1 AS x')).x === 1, storage: db.storage }));
  route('GET', '/api/meta', PUBLIC, async () => ({ roles: ROLES, companies: COMPANIES, kinds: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })) }));
  route('GET', '/api/setup/status', PUBLIC, async () => ({ open: await setupOpen() }));

  /**
   * Registration, like תיאומון: full name (= login name) + phone + password. A new account is
   * "pending" — it can't see or sign anything until the מג״ד gives it a permission. The kind is never
   * taken from the request. Only the secret one-time setup code makes the first מג״ד.
   */
  route('POST', '/api/auth/register', PUBLIC, async ({ body, req, res }) => {
    const ip = clientIp(req);
    if (registerLimiter.blocked(ip)) throw new HttpError(429, 'יותר מדי ניסיונות הרשמה. נסו שוב מאוחר יותר', 'rate');
    registerLimiter.fail(ip);
    const data = { full_name: fullName(body.full_name), phone: phone10(body.phone), password: password(body.password) };
    if (await db.get('SELECT 1 AS x FROM users WHERE full_name = ?', data.full_name)) throw conflict(NAME_TAKEN_MSG, 'name_taken');
    const hash = await hashPassword(data.password);
    const wantsSetup = typeof body.setup_code === 'string' && body.setup_code.trim() !== '';
    let id;
    try {
      id = await db.tx(async (t) => {
        let kind = 'pending';
        if (wantsSetup) {
          if (setupLimiter.blocked(ip)) throw new HttpError(429, 'יותר מדי ניסיונות. נסו שוב בעוד שעה', 'rate');
          if (!(await setupOpen(t))) throw conflict('הקמת המערכת כבר הושלמה. קוד ההקמה אינו פעיל יותר', 'setup_closed');
          if (!codeMatches(body.setup_code)) { setupLimiter.fail(ip); throw new HttpError(403, 'קוד ההקמה שגוי', 'bad_setup_code'); }
          kind = 'admin';
        }
        return (await t.run('INSERT INTO users (full_name, phone, password_hash, kind, created_at) VALUES (?, ?, ?, ?, ?)',
          data.full_name, data.phone, hash, kind, nowIso())).lastInsertRowid;
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw conflict(NAME_TAKEN_MSG, 'name_taken');
      throw e;
    }
    await startSession(res, req, id);
    changed();   // the מג״ד's users tab shows the new pending account at once
    return { user: publicUser(await userById(id)) };
  });

  route('POST', '/api/auth/login', PUBLIC, async ({ body, req, res }) => {
    const name = normalizeName(body.full_name);
    const pw = typeof body.password === 'string' ? body.password : '';
    const key = `${clientIp(req)}|${name.toLowerCase()}`;
    if (loginLimiter.blocked(key)) throw new HttpError(429, 'יותר מדי ניסיונות התחברות. נסו שוב בעוד כמה דקות', 'rate');
    const u = name ? await db.get('SELECT * FROM users WHERE full_name = ? AND deleted_at IS NULL', name) : null;
    const ok = u ? await verifyPassword(pw, u.password_hash) : await dummyVerify(pw);
    if (!ok) { loginLimiter.fail(key); throw new HttpError(401, 'שם מלא או סיסמה שגויים', 'bad_credentials'); }
    if (!u.active) throw new HttpError(403, 'החשבון מושבת. פנו למג״ד', 'inactive');
    loginLimiter.reset(key);
    await startSession(res, req, u.id);
    return { user: publicUser(await withRoles(u)) };
  });

  route('POST', '/api/auth/logout', PUBLIC, async ({ req, res }) => {
    const token = parseCookies(req)[COOKIE];
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
    return { ok: true };
  });

  route('GET', '/api/auth/me', ANY, async ({ user }) => ({ user: publicUser(user) }));

  // --- profile (every user, including pending) ---
  route('PATCH', '/api/profile', ANY, async ({ user, body }) => {
    const data = { full_name: fullName(body.full_name), phone: phone10(body.phone) };
    try {
      await db.run('UPDATE users SET full_name = ?, phone = ? WHERE id = ?', data.full_name, data.phone, user.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw conflict(NAME_TAKEN_MSG, 'name_taken');
      throw e;
    }
    changed();
    return { user: publicUser(await userById(user.id)) };
  });

  /** Change my password; every other session of mine is logged out. */
  route('POST', '/api/profile/password', ANY, async ({ user, body, req }) => {
    if (!(await verifyPassword(typeof body.current_password === 'string' ? body.current_password : '', user.password_hash))) {
      throw bad('הסיסמה הנוכחית שגויה', 'bad_password');
    }
    const pw = password(body.new_password);
    const keep = tokenHash(parseCookies(req)[COOKIE] || '');
    await db.tx(async (t) => {
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), user.id);
      await t.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', user.id, keep);
    });
    return { ok: true };
  });

  /** The first-login tour was completed or skipped: don't show it again, on any device. */
  route('POST', '/api/onboarding/done', ANY, async ({ user }) => {
    await db.run('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?', nowIso(), user.id);
    return { ok: true };
  });

  /**
   * The current state, scoped strictly to who is asking:
   *  officer → own signature (own role) for every company
   *  company → own company's form only
   *  admin   → every company's form
   */
  route('GET', '/api/state', ANY, async ({ user }) => {
    if (user.kind === 'pending') return { pending: true };
    const r = await shownRound();
    const round = roundView(r);
    if (user.kind === 'officer') {
      // an officer sees only the rows of his own areas (one block per area), for every company
      const all = await forms(r?.id, COMPANIES);
      const companiesOf = (key) => all.map((f) => {
        const mine = f.areas.find((x) => x.key === key);
        if (!mine) return { company: f.company, applies: false, items: [], signed_count: 0, total: 0, done: false };
        return { company: f.company, applies: true, items: mine.items, signed_count: mine.signed_count, total: mine.total, done: mine.done };
      });
      const areas = roleKeysOf(user).map((key) => ({ key, label: ROLE_LABEL[key], companies: companiesOf(key) }));
      return { round, areas, companies: areas[0]?.companies ?? [] };
    }
    if (user.kind === 'company') return { round, form: (await forms(r?.id, [user.company_key]))[0] };
    return { round, forms: await forms(r?.id, COMPANIES) };
  });

  /**
   * A staff officer signs for one company — always in the name of the area on his own account.
   * { company, item }: one row.  { company } without item: every row of his that is still unsigned.
   */
  route('POST', '/api/sign', ['officer'], async ({ user, body }) => {
    const c = companyKey(body.company);
    const mine = roleKeysOf(user);
    // which of my areas: the row's area, else the one named in the request, else my only area
    let role = body.item !== undefined ? ITEM[body.item]?.role_key : body.role;
    if (body.item !== undefined && !role) throw bad('שורה לא קיימת', 'item');
    if (body.role !== undefined && body.item !== undefined && body.role !== role) throw new HttpError(403, 'אפשר לחתום רק בשם התפקיד שלך', 'wrong_role');
    if (role === undefined) {
      if (mine.length > 1) throw bad('יש לבחור באיזה תחום לחתום', 'role');
      role = mine[0];
    }
    if (!mine.includes(role)) throw new HttpError(403, 'אפשר לחתום רק על השורות של התחומים שלך', 'wrong_role');
    if (!roleApplies(role, c)) throw conflict('התחום הזה לא רלוונטי לפלוגה הזו', 'not_relevant');
    const keys = body.item !== undefined ? [body.item] : ROLES.find((r) => r.key === role).items.map((it) => it.key);
    let added = 0;
    await db.tx(async (t) => {
      const r = await openRound(t);
      if (!r) throw conflict('אין סבב פתוח. אי אפשר לחתום כרגע', 'no_round');
      const at = nowIso();
      for (const k of keys) {
        added += (await t.run(`INSERT OR IGNORE INTO signatures (round_id, company_key, item_key, role_key, user_id, signer_name, signed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, r.id, c, k, role, user.id, user.full_name, at)).changes;
      }
      if (!added) throw conflict(keys.length === 1 ? 'השורה הזו כבר נחתמה בסבב הנוכחי' : 'כל השורות שלך לפלוגה זו כבר נחתמו', 'already_signed');
    });
    changed();
    return { ok: true, signed: added };
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
      const needed = rolesFor(c).flatMap((ro) => ro.items.map((it) => it.key));
      const have = new Set((await t.all('SELECT item_key FROM signatures WHERE round_id = ? AND company_key = ?', r.id, c)).map((x) => x.item_key));
      const n = needed.filter((k) => have.has(k)).length;
      if (n < needed.length) throw conflict(`חסרות חתימות (${n}/${needed.length}). אי אפשר לאשר עדיין`, 'missing_signatures');
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

  // --- מג״ד: users and permissions ---
  route('GET', '/api/users', USER_MANAGERS, async () => {
    const rows = await db.all(`SELECT * FROM users WHERE deleted_at IS NULL
      ORDER BY (kind = 'pending' AND active = 1) DESC, active DESC, kind, company_key, role_key, full_name`);
    const roles = await db.all('SELECT user_id, role_key FROM user_roles');
    for (const u of rows) u.role_keys = u.kind === 'officer' ? sortRoles(roles.filter((r) => r.user_id === u.id).map((r) => r.role_key)) : [];
    return { users: rows.map(publicUser) };
  });

  /** Any מג״ד can give anyone any permission, including מג״ד. Only the last active מג״ד is protected. */
  async function guardLastAdmin(t, target) {
    if (target.kind !== 'admin' || !target.active) return;
    const { n } = await t.get(`SELECT COUNT(*) AS n FROM users WHERE kind = 'admin' AND active = 1 AND deleted_at IS NULL AND id <> ?`, target.id);
    if (!n) throw conflict('לא ניתן: זהו המג״ד הפעיל האחרון. קודם תנו הרשאת מג״ד למישהו אחר', 'last_admin');
  }
  const targetUser = async (t, id) => {
    const u = await t.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', Number(id));
    if (!u) throw notFound('המשתמש לא נמצא');
    return u;
  };

  route('PATCH', '/api/users/:id', USER_MANAGERS, async ({ user, params, body }) => {
    const updated = await db.tx(async (t) => {
      const u = await targetUser(t, params.id);
      // קשר״ג: may give and change every permission except מג״ד — never grants it, never touches a מג״ד's
      // account, never changes his own permission, and only the מג״ד turns accounts on/off.
      if (user.kind !== 'admin') {
        const noAdmin = () => new HttpError(403, 'רק מג״ד יכול לתת או לשנות הרשאת מג״ד', 'admin_only');
        if (body.kind === 'admin' || u.kind === 'admin') throw noAdmin();
        if (u.id === user.id) throw new HttpError(403, 'את ההרשאה שלך יכול לשנות רק המג״ד', 'self');
        if (body.active !== undefined) throw forbidden();
      }
      if (body.kind !== undefined) {
        const kind = KINDS.includes(body.kind) ? body.kind : null;
        if (!kind) throw bad('יש לבחור הרשאה', 'kind');
        // an officer may get one area or several (role_keys); role_key alone still works
        let rks = [];
        if (kind === 'officer') {
          const given = Array.isArray(body.role_keys) ? body.role_keys : [body.role_key];
          rks = sortRoles([...new Set(given.map(roleKey))]);
          if (!rks.length) throw bad('יש לבחור לפחות תחום אחד', 'role');
        }
        const ck = kind === 'company' ? companyKey(body.company_key) : null;
        if (kind !== 'admin') await guardLastAdmin(t, u);
        await t.run('UPDATE users SET kind = ?, role_key = ?, company_key = ? WHERE id = ?', kind, rks[0] ?? null, ck, u.id);
        await t.run('DELETE FROM user_roles WHERE user_id = ?', u.id);
        for (const k of rks) await t.run('INSERT INTO user_roles (user_id, role_key) VALUES (?, ?)', u.id, k);
      }
      if (body.active !== undefined) {
        const active = body.active ? 1 : 0;
        if (!active && u.id === user.id) throw conflict('אי אפשר להשבית את החשבון שלך', 'self');
        if (!active) { await guardLastAdmin(t, u); await t.run('DELETE FROM sessions WHERE user_id = ?', u.id); }
        await t.run('UPDATE users SET active = ? WHERE id = ?', active, u.id);
      }
      return withRoles(await t.get('SELECT * FROM users WHERE id = ?', u.id), t);
    });
    changed();
    return { user: publicUser(updated) };
  });

  /** The קשר״ג may reset passwords and delete users too — but never a מג״ד's account. */
  const guardManagerTarget = (user, u) => {
    if (user.kind !== 'admin' && u.kind === 'admin') throw new HttpError(403, 'רק מג״ד יכול לטפל בחשבון של מג״ד', 'admin_only');
  };

  route('POST', '/api/users/:id/reset-password', USER_MANAGERS, async ({ user, params }) => {
    const pw = randomPassword();
    await db.tx(async (t) => {
      const u = await targetUser(t, params.id);
      guardManagerTarget(user, u);
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(pw), u.id);
      await t.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    });
    return { password: pw };
  });

  /**
   * Permanent delete: the name, phone and password are erased and the name becomes free.
   * Past signatures and approvals keep the signer's name (they store it as text).
   */
  route('POST', '/api/users/:id/delete', USER_MANAGERS, async ({ user, params, body }) => {
    await db.tx(async (t) => {
      const u = await targetUser(t, params.id);
      guardManagerTarget(user, u);
      if (u.id === user.id) throw conflict('אי אפשר למחוק את החשבון שלך', 'self');
      if (normalizeName(body.confirm_name) !== u.full_name) throw bad('יש להקליד את השם המלא בדיוק כדי לאשר', 'confirm');
      await guardLastAdmin(t, u);
      await t.run(`UPDATE users SET full_name = ?, phone = '', password_hash = '!deleted', kind = 'pending', role_key = NULL, company_key = NULL,
        active = 0, deleted_at = ? WHERE id = ?`, `משתמש שנמחק #${u.id}`, nowIso(), u.id);
      await t.run('DELETE FROM user_roles WHERE user_id = ?', u.id);
      await t.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    });
    changed();
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
    if (rel === '/help' || rel === '/help/') rel = '/help/index.html';
    else if (rel === '/' || !path.extname(rel)) rel = '/index.html';
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
        if (typeof rt.kinds === 'function') { if (!rt.kinds(user)) throw forbidden(); }
        else if (rt.kinds && !rt.kinds.includes(user.kind)) throw forbidden();
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
