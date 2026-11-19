import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, dummyVerify, newToken, tokenHash, randomPassword, AttemptLimiter } from './auth.js';
import { ROLES, ROLE_KEYS, ROLE_LABEL, COMPANIES, KINDS, KIND_LABEL, ITEM, rolesFor, roleApplies, canManageUsers, roleKeysOf } from './constants.js';
import { normalizeName, isValidName, NAME_TAKEN_MSG } from './names.js';
import { currentWeek } from './week.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 30;
const COOKIE = 'ty_session';
const CSRF_HEADER = 'tiyulim';
const UNDO_SECONDS = 10;   // the undo button after signing shows this long
const UNDO_GRACE = 5;      // extra seconds the server allows, for a slow network

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
    request: requestOf(u),
  };
};
/** The role a pending user asked for at registration (null once he got a permission). */
function requestOf(u) {
  if (u.kind !== 'pending' || !u.req_kind) return null;
  if (u.req_kind === 'company') return { kind: 'company', company_key: u.req_company, label: u.req_company === 'מפקדה' ? 'מפקדה' : `פלוגה ${u.req_company}` };
  const keys = ROLE_KEYS.filter((k) => String(u.req_roles || '').split(',').includes(k));
  return { kind: 'officer', role_keys: keys, label: keys.map((k) => ROLE_LABEL[k]).join(' + ') };
}
/** Areas in the fixed display order. */
const sortRoles = (keys) => ROLE_KEYS.filter((k) => keys.includes(k));

/**
 * dbUrl: Turso URL (libsql://…) with authToken, or a local file path for development and tests.
 * setupCode: secret one-time code that lets the first מג״ד create an account. Dead once any מג״ד exists.
 */
/**
 * The whole app as one request handler: handle(req, res). Used by the long-running server below and by the
 * Vercel function (api/index.js), which keeps one handler per warm instance.
 */
export async function createHandler({ dbUrl, authToken, setupCode, clock = () => new Date(), secureCookies = false, trustProxy = false, log = console } = {}) {
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

  // ---------- live updates ----------
  // A change counter in the database: every signature / approval / round / user change bumps it, and open
  // screens poll /api/version every few seconds and reload only when it moved. Kept in the database (not in
  // memory) so it works on serverless hosting (Vercel), where every request may hit a different instance.
  async function changed() {
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('version', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`);
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
  /**
   * The form of the current calendar week (Monday 00:00 → Sunday 23:59, Israel time). It is created the first
   * time anyone needs it after the week starts; the previous week's form is closed at the same moment and stays
   * in history, read-only. Nobody opens or closes forms by hand.
   */
  async function ensureCurrentRound() {
    const wk = currentWeek(clock());
    const have = await db.get('SELECT * FROM rounds WHERE iso_year = ? AND iso_week = ?', wk.year, wk.week);
    if (have && have.status === 'open') return have;
    if (have) return have;   // (a week is never reopened)
    try {
      await db.tx(async (t) => {
        await t.run(`UPDATE rounds SET status = 'closed', closed_at = ?, closed_by_name = 'סיום שבוע אוטומטי' WHERE status = 'open'`, nowIso());
        const n = ((await t.get('SELECT MAX(number) AS n FROM rounds')).n || 0) + 1;
        await t.run(`INSERT INTO rounds (number, status, opened_at, opened_by_name, iso_year, iso_week, starts_on, ends_on)
          VALUES (?, 'open', ?, 'אוטומטי', ?, ?, ?, ?)`, n, nowIso(), wk.year, wk.week, wk.starts_on, wk.ends_on);
      });
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;   // another request created it at the same moment
    }
    return db.get('SELECT * FROM rounds WHERE iso_year = ? AND iso_week = ?', wk.year, wk.week);
  }
  /** The open form (always the current week's), inside a transaction. */
  const openRound = (h = db) => h.get(`SELECT * FROM rounds WHERE status = 'open'`);
  const shownRound = () => ensureCurrentRound();
  const roundView = (r) => r && ({
    id: r.id, number: r.number, status: r.status, opened_at: r.opened_at, opened_by_name: r.opened_by_name,
    closed_at: r.closed_at, closed_by_name: r.closed_by_name,
    week: r.iso_week ?? null, year: r.iso_year ?? null, starts_on: r.starts_on ?? null, ends_on: r.ends_on ?? null,
    reopened: !!r.reopened,
  });
  /**
   * The week an officer signs in: this week's form, or a past week the מג״ד reopened for the officers.
   * roundId omitted = this week.
   */
  async function signableRound(t, roundId) {
    if (roundId === undefined || roundId === null || roundId === '') {
      const r = await openRound(t);
      if (!r) throw conflict('הטופס של השבוע עוד לא נפתח. נסו שוב בעוד רגע', 'no_round');
      return r;
    }
    const r = await t.get('SELECT * FROM rounds WHERE id = ?', Number(roundId));
    if (!r) throw notFound('השבוע לא נמצא');
    if (r.status !== 'open' && !r.reopened) throw conflict('השבוע הזה נעול. רק המג״ד יכול לפתוח אותו מחדש', 'week_locked');
    return r;
  }
  /** Weeks an officer can sign in right now: this week, plus past weeks the מג״ד reopened. */
  const signableWeeks = async () => (await db.all(`SELECT * FROM rounds WHERE status = 'open' OR reopened = 1 ORDER BY number DESC`)).map(roundView);

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
          return { key: it.key, label: it.label, signed: !!s, signer_name: s?.signer_name ?? null, signed_at: s?.signed_at ?? null, by_admin: !!s?.by_admin };
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
  /** Screens poll this every few seconds and reload only when the number moved. */
  route('GET', '/api/version', ANY, async () => ({ version: Number((await db.get("SELECT value FROM app_settings WHERE key = 'version'"))?.value || 0) }));
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
    const wantsSetup = typeof body.setup_code === 'string' && body.setup_code.trim() !== '';
    let ask = { kind: null, roles: null, company: null };
    if (!wantsSetup) {
      if (body.request_kind === 'officer') {
        const keys = sortRoles([...new Set((Array.isArray(body.role_keys) ? body.role_keys : []).map(roleKey))]);
        if (!keys.length) throw bad('יש לבחור לפחות תחום אחד', 'request');
        ask = { kind: 'officer', roles: keys.join(','), company: null };
      } else if (body.request_kind === 'company') {
        ask = { kind: 'company', roles: null, company: companyKey(body.company_key) };
      } else {
        throw bad('יש לבחור אם את/ה קצין מטה או משתמש פלוגתי', 'request');
      }
    }
    if (await db.get('SELECT 1 AS x FROM users WHERE full_name = ?', data.full_name)) throw conflict(NAME_TAKEN_MSG, 'name_taken');
    const hash = await hashPassword(data.password);
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
        return (await t.run('INSERT INTO users (full_name, phone, password_hash, kind, created_at, req_kind, req_roles, req_company) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          data.full_name, data.phone, hash, kind, nowIso(), ask.kind, ask.roles, ask.company)).lastInsertRowid;
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw conflict(NAME_TAKEN_MSG, 'name_taken');
      throw e;
    }
    await startSession(res, req, id);
    await changed();   // the מג״ד's users tab shows the new pending account at once
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
    await changed();
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
  route('GET', '/api/state', ANY, async ({ user, query }) => {
    if (user.kind === 'pending') return { pending: true };
    let r = await shownRound();
    let officerWeeks = null;
    if (user.kind === 'officer') {
      const weeks = await signableWeeks();
      if (query.round && weeks.some((w) => w.id === Number(query.round))) r = await db.get('SELECT * FROM rounds WHERE id = ?', Number(query.round));
      officerWeeks = weeks;
    }
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
      return { round, weeks: officerWeeks, areas, companies: areas[0]?.companies ?? [] };
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
    const signedKeys = [];
    await ensureCurrentRound();
    await db.tx(async (t) => {
      const r = await signableRound(t, body.round_id);
      const at = nowIso();
      for (const k of keys) {
        const res = await t.run(`INSERT OR IGNORE INTO signatures (round_id, company_key, item_key, role_key, user_id, signer_name, signed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, r.id, c, k, role, user.id, user.full_name, at);
        if (res.changes) signedKeys.push(k);
      }
      if (!signedKeys.length) throw conflict(keys.length === 1 ? 'השורה הזו כבר נחתמה השבוע' : 'כל השורות שלך לפלוגה זו כבר נחתמו', 'already_signed');
    });
    await changed();
    return { ok: true, signed: signedKeys.length, items: signedKeys, undo_seconds: UNDO_SECONDS };
  });

  /**
   * Undo: an officer may take back what he signed in the last few seconds (the button shows for 10 s; the
   * server allows a small margin for a slow network). Only his own signatures, only this week's form, and
   * never after the מג״ד already approved that company's form.
   */
  route('POST', '/api/sign/undo', ['officer'], async ({ user, body }) => {
    const c = companyKey(body.company);
    const items = Array.isArray(body.items) ? body.items.filter((k) => ITEM[k]) : [];
    if (!items.length) throw bad('אין מה לבטל', 'items');
    const since = new Date(clock().getTime() - (UNDO_SECONDS + UNDO_GRACE) * 1000).toISOString();
    let removed = 0;
    await db.tx(async (t) => {
      const r = await signableRound(t, body.round_id);
      if (await t.get('SELECT 1 AS x FROM approvals WHERE round_id = ? AND company_key = ?', r.id, c)) {
        throw conflict('אי אפשר לבטל: המג״ד כבר אישר את הטופס של הפלוגה', 'already_approved');
      }
      for (const k of items) {
        removed += (await t.run(`DELETE FROM signatures WHERE round_id = ? AND company_key = ? AND item_key = ? AND user_id = ? AND signed_at >= ?`,
          r.id, c, k, user.id, since)).changes;
      }
      if (!removed) throw conflict('עבר הזמן לביטול החתימה', 'undo_expired');
    });
    await changed();
    return { ok: true, removed };
  });

  // --- מג״ד: final approval (the weekly forms open and close by themselves) ---
  route('POST', '/api/approve', ADMIN, async ({ user, body }) => {
    const c = companyKey(body.company);
    await ensureCurrentRound();
    await db.tx(async (t) => {
      const r = await anyRound(t, body.round_id);
      const needed = rolesFor(c).flatMap((ro) => ro.items.map((it) => it.key));
      const have = new Set((await t.all('SELECT item_key FROM signatures WHERE round_id = ? AND company_key = ?', r.id, c)).map((x) => x.item_key));
      const n = needed.filter((k) => have.has(k)).length;
      if (n < needed.length) throw conflict(`חסרות חתימות (${n}/${needed.length}). אי אפשר לאשר עדיין`, 'missing_signatures');
      const res = await t.run('INSERT OR IGNORE INTO approvals (round_id, company_key, user_id, approver_name, approved_at) VALUES (?, ?, ?, ?, ?)',
        r.id, c, user.id, user.full_name, nowIso());
      if (!res.changes) throw conflict('הטופס כבר אושר', 'already_approved');
    });
    await changed();
    return { ok: true };
  });

  /** A week by id (any week, for the מג״ד), or this week's form. */
  async function anyRound(t, roundId) {
    if (roundId === undefined || roundId === null || roundId === '') {
      const r = await openRound(t);
      if (!r) throw conflict('אין טופס פתוח', 'no_round');
      return r;
    }
    const r = await t.get('SELECT * FROM rounds WHERE id = ?', Number(roundId));
    if (!r) throw notFound('השבוע לא נמצא');
    return r;
  }

  route('POST', '/api/approve/cancel', ADMIN, async ({ body }) => {
    const c = companyKey(body.company);
    await db.tx(async (t) => {
      const r = await anyRound(t, body.round_id);
      const res = await t.run('DELETE FROM approvals WHERE round_id = ? AND company_key = ?', r.id, c);
      if (!res.changes) throw conflict('הטופס הזה לא אושר', 'not_approved');
    });
    await changed();
    return { ok: true };
  });

  /**
   * Editing a week (the מג״ד): mark a missing row as signed in his own name. It shows as "סומן ע״י המג״ד".
   * He can take back his own marks, but never an officer's signature.
   */
  route('POST', '/api/rounds/:id/mark', ADMIN, async ({ user, params, body }) => {
    const c = companyKey(body.company);
    const it = ITEM[body.item];
    if (!it) throw bad('שורה לא קיימת', 'item');
    if (!roleApplies(it.role_key, c)) throw conflict('התחום הזה לא רלוונטי לפלוגה הזו', 'not_relevant');
    await db.tx(async (t) => {
      const r = await anyRound(t, params.id);
      const res = await t.run(`INSERT OR IGNORE INTO signatures (round_id, company_key, item_key, role_key, user_id, signer_name, signed_at, by_admin)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, r.id, c, it.key, it.role_key, user.id, user.full_name, nowIso());
      if (!res.changes) throw conflict('השורה הזו כבר חתומה', 'already_signed');
    });
    await changed();
    return { ok: true };
  });

  route('POST', '/api/rounds/:id/unmark', ADMIN, async ({ params, body }) => {
    const c = companyKey(body.company);
    if (!ITEM[body.item]) throw bad('שורה לא קיימת', 'item');
    await db.tx(async (t) => {
      const r = await anyRound(t, params.id);
      const s = await t.get('SELECT * FROM signatures WHERE round_id = ? AND company_key = ? AND item_key = ?', r.id, c, body.item);
      if (!s) throw notFound('השורה לא חתומה');
      if (!s.by_admin) throw new HttpError(403, 'אי אפשר למחוק חתימה של קצין מטה — רק סימון שהמג״ד עשה', 'officer_signature');
      if (await t.get('SELECT 1 AS x FROM approvals WHERE round_id = ? AND company_key = ?', r.id, c)) {
        throw conflict('הטופס כבר אושר. קודם בטלו את האישור', 'already_approved');
      }
      await t.run('DELETE FROM signatures WHERE round_id = ? AND company_key = ? AND item_key = ?', r.id, c, body.item);
    });
    await changed();
    return { ok: true };
  });

  /** Reopen a past week for the officers (they can sign in it late), or lock it again. */
  route('POST', '/api/rounds/:id/reopen', ADMIN, async ({ params, body }) => {
    const r = await db.get('SELECT * FROM rounds WHERE id = ?', Number(params.id));
    if (!r) throw notFound('השבוע לא נמצא');
    if (r.status === 'open') throw conflict('זה הטופס של השבוע הנוכחי — הוא כבר פתוח', 'current_week');
    await db.run('UPDATE rounds SET reopened = ? WHERE id = ?', body.open ? 1 : 0, r.id);
    await changed();
    return { round: roundView(await db.get('SELECT * FROM rounds WHERE id = ?', r.id)) };
  });

  route('GET', '/api/rounds', ADMIN, async () => {
    await ensureCurrentRound();
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
        if (kind !== 'pending') await t.run('UPDATE users SET req_kind = NULL, req_roles = NULL, req_company = NULL WHERE id = ?', u.id);
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
    await changed();
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
    await changed();
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
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
    // On Vercel the body may already be read and parsed by the platform (req.body)
    if (req.body !== undefined && req.body !== null) {
      let v = req.body;
      try { if (typeof v === 'string' || Buffer.isBuffer(v)) v = v.length ? JSON.parse(v.toString('utf8')) : {}; }
      catch { return Promise.reject(bad('גוף הבקשה אינו JSON תקין')); }
      return Promise.resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    }
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
      const query = Object.fromEntries(url.searchParams);
      sendJson(res, 200, await rt.handler({ req, res, user, params, body, query }));
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
      log.error?.(e);
      sendJson(res, 500, { error: 'שגיאת שרת. נסו שוב', code: 'server' });
    }
  }

  return { handle, db };
}

/** Classic long-running server (local development, tests, Render). */
export async function createApp(opts = {}) {
  const { handle, db } = await createHandler(opts);
  const server = http.createServer((req, res) => { handle(req, res); });
  return { server, db };
}
