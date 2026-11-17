// Full flow from the spec, over real HTTP against a temporary database file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { ROLES, COMPANIES, rolesFor } from '../server/constants.js';

const SETUP = 'setup-code-123456';
let server, db, base, dir;
let now = new Date('2026-11-17T10:00:00Z');
const at = (iso) => { now = new Date(iso); };
const later = (sec) => { now = new Date(now.getTime() + sec * 1000); };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiyulim-'));
  ({ server, db } = await createApp({ dbUrl: path.join(dir, 't.db'), setupCode: SETUP, clock: () => now, log: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close(); db.close();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may still hold the file */ }
});

/** A tiny client that keeps its own session cookie. */
function client() {
  let cookie = '';
  const call = async (method, url, body, { csrf = true } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (csrf) headers['X-Requested-With'] = 'tiyulim'; }
    const res = await fetch(base + url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { get: (u) => call('GET', u), post: (u, b, o) => call('POST', u, b, o), patch: (u, b) => call('PATCH', u, b) };
}

const admin = client();
const officers = {};   // role key → client
const companies = {};  // company → client

const PW = 'password1';
let phoneN = 0;
const nextPhone = () => `05${String(10000000 + phoneN++).padStart(8, '0')}`;
const users = async () => (await admin.get('/api/users')).data.users;
const idOf = async (name) => (await users()).find((u) => u.full_name === name).id;

test('registration: full name + phone; validation; the new account is pending', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/register', { full_name: 'א', phone: nextPhone(), password: PW })).status, 400);          // name too short
  assert.equal((await c.post('/api/auth/register', { full_name: 'דני לוי', phone: '123', password: PW })).status, 400);          // phone
  assert.equal((await c.post('/api/auth/register', { full_name: 'דני לוי', phone: nextPhone(), password: 'short' })).status, 400); // password
  const ok = await c.post('/api/auth/register', { full_name: '  דני   לוי ', phone: '050-123 4567', password: PW });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.full_name, 'דני לוי');
  assert.equal(ok.data.user.phone, '0501234567');
  assert.equal(ok.data.user.kind, 'pending');
  // a kind sent in the request is ignored
  const sneaky = await client().post('/api/auth/register', { full_name: 'מנסה להיות מגד', phone: nextPhone(), password: PW, kind: 'admin' });
  assert.equal(sneaky.data.user.kind, 'pending');
  // the name is the login name, so it is unique (case/space-insensitive)
  assert.equal((await client().post('/api/auth/register', { full_name: 'דני לוי', phone: nextPhone(), password: PW })).data.code, 'name_taken');
  // pending: no forms, no signing
  assert.deepEqual((await c.get('/api/state')).data, { pending: true });
  assert.equal((await c.post('/api/sign', { company: 'א' })).status, 403);
  assert.equal((await c.get('/api/users')).status, 403);
});

test('first מג״ד: register with the one-time setup code', async () => {
  const bad = await admin.post('/api/auth/register', { full_name: 'סא״ל ישראל', phone: nextPhone(), password: PW, setup_code: 'wrong-code-xxxx' });
  assert.equal(bad.status, 403);
  const ok = await admin.post('/api/auth/register', { full_name: 'סא״ל ישראל', phone: nextPhone(), password: PW, setup_code: SETUP });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.kind, 'admin');
  const again = await client().post('/api/auth/register', { full_name: 'עוד מגד', phone: nextPhone(), password: PW, setup_code: SETUP });
  assert.equal(again.data.code, 'setup_closed');
  // login is by full name
  assert.equal((await client().post('/api/auth/login', { full_name: 'סא״ל ישראל', password: PW })).status, 200);
  assert.equal((await client().post('/api/auth/login', { full_name: 'סא״ל ישראל', password: 'wrong-pass' })).status, 401);
});

test('everyone registers; the מג״ד assigns each a role or company; others cannot', async () => {
  for (const r of ROLES) {
    officers[r.key] = client();
    assert.equal((await officers[r.key].post('/api/auth/register', { full_name: `קצין ${r.label}`, phone: nextPhone(), password: PW })).status, 200);
  }
  for (const c of COMPANIES) {
    companies[c] = client();
    assert.equal((await companies[c].post('/api/auth/register', { full_name: `רס״פ ${c}`, phone: nextPhone(), password: PW })).status, 200);
  }
  const list = await users();
  assert.equal(list[0].kind, 'pending');   // pending first
  for (const r of ROLES) {
    const res = await admin.patch(`/api/users/${list.find((u) => u.full_name === `קצין ${r.label}`).id}`, { kind: 'officer', role_key: r.key });
    assert.equal(res.status, 200, res.data?.error);
    assert.equal(res.data.user.role_key, r.key);
  }
  for (const c of COMPANIES) {
    assert.equal((await admin.patch(`/api/users/${list.find((u) => u.full_name === `רס״פ ${c}`).id}`, { kind: 'company', company_key: c })).status, 200);
  }
  // bad values
  const someone = list.find((u) => u.full_name === 'דני לוי').id;
  assert.equal((await admin.patch(`/api/users/${someone}`, { kind: 'officer' })).status, 400);
  assert.equal((await admin.patch(`/api/users/${someone}`, { kind: 'company', company_key: 'לא קיימת' })).status, 400);
  // nobody else can change permissions
  assert.equal((await officers.rechev.patch(`/api/users/${someone}`, { kind: 'admin' })).status, 403);
  assert.equal((await companies['א'].get('/api/users')).status, 403);
  // the officer's own session now sees the officer screen
  assert.ok(Array.isArray((await officers.rechev.get('/api/state')).data.companies));
});

test('תקשוב assigns every permission except מג״ד', async () => {
  const k = officers.tikshuv;
  assert.equal((await k.get('/api/auth/me')).data.user.can_manage_users, true);
  assert.equal((await officers.rechev.get('/api/auth/me')).data.user.can_manage_users, false);
  assert.equal((await k.get('/api/users')).status, 200);
  const newbie = client();
  await newbie.post('/api/auth/register', { full_name: 'חייל חדש', phone: nextPhone(), password: PW });
  const id = await idOf('חייל חדש');
  // allowed: officer, company, back to pending
  assert.equal((await k.patch(`/api/users/${id}`, { kind: 'company', company_key: 'ב' })).status, 200);
  assert.equal((await k.patch(`/api/users/${id}`, { kind: 'officer', role_key: 'chinuch' })).status, 200);
  assert.equal((await newbie.get('/api/auth/me')).data.user.role_key, 'chinuch');
  assert.equal((await k.patch(`/api/users/${id}`, { kind: 'pending' })).status, 200);
  // not allowed: granting מג״ד, touching a מג״ד, changing himself, on/off
  const magad = await idOf('סא״ל ישראל');
  assert.equal((await k.patch(`/api/users/${id}`, { kind: 'admin' })).data.code, 'admin_only');
  assert.equal((await k.patch(`/api/users/${magad}`, { kind: 'pending' })).data.code, 'admin_only');
  assert.equal((await k.patch(`/api/users/${await idOf('קצין תקשוב')}`, { kind: 'officer', role_key: 'rechev' })).data.code, 'self');
  assert.equal((await k.patch(`/api/users/${id}`, { active: false })).status, 403);
  // a מג״ד's password and account are off limits
  assert.equal((await k.post(`/api/users/${magad}/reset-password`)).data.code, 'admin_only');
  assert.equal((await k.post(`/api/users/${magad}/delete`, { confirm_name: 'סא״ל ישראל' })).data.code, 'admin_only');
  assert.equal((await k.post(`/api/users/${await idOf('קצין תקשוב')}/delete`, { confirm_name: 'קצין תקשוב' })).data.code, 'self');
  // allowed: password reset and delete of anyone else
  const { password } = (await k.post(`/api/users/${id}/reset-password`)).data;
  assert.equal((await newbie.get('/api/auth/me')).status, 401);
  assert.equal((await client().post('/api/auth/login', { full_name: 'חייל חדש', password })).status, 200);
  assert.equal((await k.post(`/api/users/${id}/delete`, { confirm_name: 'חייל חדש' })).status, 200);
  assert.equal((await users()).some((u) => u.id === id), false);
  // and nothing else of the מג״ד's
  assert.equal((await k.post('/api/approve', { company: 'א' })).status, 403);
  assert.equal((await k.get('/api/rounds')).status, 403);
});

test('the מג״ד can give מג״ד to anyone; the last מג״ד is protected', async () => {
  const me = await idOf('סא״ל ישראל');
  // only one מג״ד: can't lose the role, be deactivated or be deleted
  assert.equal((await admin.patch(`/api/users/${me}`, { kind: 'pending' })).data.code, 'last_admin');
  const dani = client();
  await dani.post('/api/auth/login', { full_name: 'דני לוי', password: PW });
  const daniId = await idOf('דני לוי');
  assert.equal((await admin.patch(`/api/users/${daniId}`, { kind: 'admin' })).status, 200);
  assert.equal((await dani.get('/api/users')).status, 200);   // דני is now a מג״ד
  // דני may now remove the first מג״ד's role, but not his own when he is the last
  assert.equal((await dani.patch(`/api/users/${me}`, { kind: 'pending' })).status, 200);
  assert.equal((await dani.patch(`/api/users/${daniId}`, { kind: 'pending' })).data.code, 'last_admin');
  assert.equal((await dani.patch(`/api/users/${me}`, { kind: 'admin' })).status, 200);   // and back
  // demote דני again
  assert.equal((await admin.patch(`/api/users/${daniId}`, { kind: 'pending' })).status, 200);
  assert.equal((await dani.get('/api/users')).status, 403);
});

test('the form of the current calendar week opens by itself', async () => {
  const st = (await admin.get('/api/state')).data;
  assert.equal(st.round.status, 'open');
  assert.equal(st.round.week, 47);
  assert.equal(st.round.year, 2026);
  assert.equal(st.round.starts_on, '2026-11-16');   // Monday
  assert.equal(st.round.ends_on, '2026-11-22');     // Sunday
  // nobody opens or closes forms by hand any more
  assert.equal((await admin.post('/api/rounds/open')).status, 404);
  assert.equal((await admin.post('/api/rounds/close')).status, 404);
});

test('CSRF header is required on writes', async () => {
  assert.equal((await admin.post('/api/approve', { company: 'א' }, { csrf: false })).status, 403);
});

test('officer signs row by row, or all his rows at once — only in the name of his own area', async () => {
  const rechev = ROLES.find((r) => r.key === 'rechev');
  // one row
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א', item: rechev.items[0].key })).status, 200);
  const again = await officers.rechev.post('/api/sign', { company: 'א', item: rechev.items[0].key });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'already_signed');
  let a = (await officers.rechev.get('/api/state')).data.companies.find((c) => c.company === 'א');
  assert.equal(a.signed_count, 1);
  assert.equal(a.total, rechev.items.length);
  assert.equal(a.done, false);
  assert.equal(a.items[0].signer_name, 'קצין רכב');
  assert.ok(a.items[0].signed_at);
  // another area's row, or another role: refused
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א', item: 'lag.1' })).data.code, 'wrong_role');
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א', role: 'lag' })).status, 403);
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א', item: 'nope.1' })).status, 400);
  // "sign all" signs only what is left
  const all = await officers.rechev.post('/api/sign', { company: 'א' });
  assert.equal(all.status, 200);
  assert.equal(all.data.signed, rechev.items.length - 1);
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א' })).data.code, 'already_signed');
  a = (await officers.rechev.get('/api/state')).data.companies.find((c) => c.company === 'א');
  assert.equal(a.done, true);
  // company users and the מג״ד cannot sign at all
  assert.equal((await companies['א'].post('/api/sign', { company: 'א' })).status, 403);
  assert.equal((await admin.post('/api/sign', { company: 'א' })).status, 403);
  assert.equal((await officers.rechev.post('/api/sign', { company: 'לא קיימת' })).status, 400);
  const st = (await officers.rechev.get('/api/state')).data;
  assert.equal(st.companies.find((c) => c.company === 'ב').signed_count, 0);
  assert.equal(st.forms, undefined);   // an officer never gets other areas' data
});

test('הכש״י / הכש״מ areas sign only for their own companies', async () => {
  assert.equal((await officers.kambatz_hachsham.post('/api/sign', { company: 'א' })).data.code, 'not_relevant');
  assert.equal((await officers.kambatz_hachshi.post('/api/sign', { company: '601' })).data.code, 'not_relevant');
  assert.equal((await officers.kambatz_hachshi.post('/api/sign', { company: 'מפקדה' })).data.code, 'not_relevant');
  const view = (await officers.kambatz_hachshi.get('/api/state')).data.companies;
  assert.equal(view.find((c) => c.company === 'א').applies, true);
  assert.equal(view.find((c) => c.company === 'עיט').applies, true);   // עיט goes through קמב״ץ הכש״י
  assert.equal(view.find((c) => c.company === '601').applies, false);
  assert.ok((await admin.get('/api/state')).data.forms.find((f) => f.company === 'עיט').areas.some((x) => x.key === 'kambatz_hachshi'));
  const keysOf = async (co) => (await admin.get('/api/state')).data.forms.find((f) => f.company === co).areas.map((x) => x.key);
  assert.ok((await keysOf('א')).includes('kambatz_hachshi') && !(await keysOf('א')).includes('kambatz_hachsham'));
  assert.ok((await keysOf('601')).includes('kambatz_hachsham') && !(await keysOf('601')).includes('kambatz_hachshi'));
  assert.ok(!(await keysOf('מפקדה')).includes('kambatz_hachshi') && !(await keysOf('מפקדה')).includes('kambatz_hachsham'));
});

test('one person can hold several areas; each signs only in its own name', async () => {
  const multi = client();
  await multi.post('/api/auth/register', { full_name: 'רב תפקידים', phone: nextPhone(), password: PW });
  const id = await idOf('רב תפקידים');
  assert.equal((await admin.patch(`/api/users/${id}`, { kind: 'officer', role_keys: [] })).status, 400);
  const res = await admin.patch(`/api/users/${id}`, { kind: 'officer', role_keys: ['hadracha', 'tikshuv'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.user.role_keys, ['hadracha', 'tikshuv']);   // display order
  assert.equal(res.data.user.role_label, 'הדרכה + תקשוב');
  assert.equal(res.data.user.can_manage_users, true);                  // תקשוב is one of them
  const st = (await multi.get('/api/state')).data;
  assert.deepEqual(st.areas.map((a) => a.key), ['hadracha', 'tikshuv']);
  // "sign all" must say which area; a row says it by itself
  assert.equal((await multi.post('/api/sign', { company: 'מפקדה' })).data.code, 'role');
  assert.equal((await multi.post('/api/sign', { company: 'מפקדה', role: 'tikshuv' })).status, 200);
  assert.equal((await multi.post('/api/sign', { company: 'מפקדה', item: 'hadracha.1' })).status, 200);
  assert.equal((await multi.post('/api/sign', { company: 'מפקדה', role: 'rechev' })).data.code, 'wrong_role');
  assert.equal((await multi.post('/api/sign', { company: 'מפקדה', item: 'rechev.1' })).data.code, 'wrong_role');
  const b = (await admin.get('/api/state')).data.forms.find((f) => f.company === 'מפקדה');
  assert.equal(b.areas.find((a) => a.key === 'tikshuv').done, true);
  assert.equal(b.areas.find((a) => a.key === 'hadracha').signed_count, 1);
  assert.equal(b.areas.find((a) => a.key === 'hadracha').items[0].signer_name, 'רב תפקידים');
  // narrowing to one area
  assert.deepEqual((await admin.patch(`/api/users/${id}`, { kind: 'officer', role_keys: ['hadracha'] })).data.user.role_keys, ['hadracha']);
  assert.equal((await multi.post('/api/sign', { company: 'ג', role: 'tikshuv' })).data.code, 'wrong_role');
  assert.equal((await admin.patch(`/api/users/${id}`, { kind: 'pending' })).data.user.role_keys.length, 0);
});

test('company user sees only its own form, by area and row', async () => {
  const st = (await companies['א'].get('/api/state')).data;
  assert.equal(st.form.company, 'א');
  assert.equal(st.forms, undefined);
  assert.equal(st.form.signed_count, ROLES.find((r) => r.key === 'rechev').items.length);
  assert.equal(st.form.status, 'awaiting_signatures');
  const area = st.form.areas.find((r) => r.key === 'rechev');
  assert.equal(area.done, true);
  assert.equal(area.items[0].signer_name, 'קצין רכב');
  // another company's form shows nothing of א
  const b = (await companies['ב'].get('/api/state')).data;
  assert.equal(b.form.company, 'ב');
  assert.equal(b.form.signed_count, 0);
  // history (all companies) is the מג״ד's only
  assert.equal((await companies['א'].get('/api/rounds')).status, 403);
  assert.equal((await companies['א'].get('/api/rounds/1')).status, 403);
  assert.equal((await companies['א'].post('/api/approve', { company: 'א' })).status, 403);
});

test('final approval is blocked while one row is missing', async () => {
  const areasA = rolesFor('א');
  for (const r of areasA) if (r.key !== 'rechev' && r.key !== 'samgad') assert.equal((await officers[r.key].post('/api/sign', { company: 'א' })).status, 200, r.key);
  const samgad = ROLES.find((r) => r.key === 'samgad');
  for (const it of samgad.items.slice(0, -1)) assert.equal((await officers.samgad.post('/api/sign', { company: 'א', item: it.key })).status, 200);
  const f = (await admin.get('/api/state')).data.forms.find((x) => x.company === 'א');
  assert.equal(f.signed_count, f.total - 1);
  const r = await admin.post('/api/approve', { company: 'א' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'missing_signatures');
});

test('all rows signed → waiting for the מג״ד (no automatic approval) → מג״ד approves', async () => {
  const samgad = ROLES.find((r) => r.key === 'samgad');
  assert.equal((await officers.samgad.post('/api/sign', { company: 'א', item: samgad.items.at(-1).key })).status, 200);
  let form = (await companies['א'].get('/api/state')).data.form;
  assert.equal(form.signed_count, form.total);
  assert.equal(form.areas_done, form.areas_total);
  assert.equal(form.status, 'awaiting_approval');
  assert.equal(form.approval, null);

  assert.equal((await officers.rechev.post('/api/approve', { company: 'א' })).status, 403);
  assert.equal((await admin.post('/api/approve', { company: 'א' })).status, 200);
  assert.equal((await admin.post('/api/approve', { company: 'א' })).status, 409);

  form = (await companies['א'].get('/api/state')).data.form;
  assert.equal(form.status, 'approved');
  assert.equal(form.approval.approver_name, 'סא״ל ישראל');
  assert.ok(form.approval.approved_at);
  assert.equal((await admin.get('/api/state')).data.forms.find((f) => f.company === 'ב').status, 'awaiting_signatures');
});

test('undo: own signature, within 10 seconds, not after the מג״ד approved', async () => {
  const first = await officers.lag.post('/api/sign', { company: 'ב' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.items, ['lag.1']);
  assert.equal(first.data.undo_seconds, 10);
  // someone else can't undo it
  assert.equal((await officers.rechev.post('/api/sign/undo', { company: 'ב', items: ['lag.1'] })).data.code, 'undo_expired');
  later(8);
  const u = await officers.lag.post('/api/sign/undo', { company: 'ב', items: ['lag.1'] });
  assert.equal(u.status, 200);
  assert.equal(u.data.removed, 1);
  const b = (await admin.get('/api/state')).data.forms.find((x) => x.company === 'ב');
  assert.equal(b.areas.find((a) => a.key === 'lag').signed_count, 0);
  // too late
  assert.equal((await officers.lag.post('/api/sign', { company: 'ב' })).status, 200);
  later(20);
  assert.equal((await officers.lag.post('/api/sign/undo', { company: 'ב', items: ['lag.1'] })).data.code, 'undo_expired');
  // after approval: no undo (א was approved above; sign a fresh row there is impossible, so check the rule directly)
  assert.equal((await officers.rechev.post('/api/sign/undo', { company: 'א', items: ['rechev.1'] })).data.code, 'already_approved');
  assert.equal((await companies['ב'].post('/api/sign/undo', { company: 'ב', items: ['lag.1'] })).status, 403);
});

test('Monday 00:00 (Israel) starts a new clean week; last week is closed and kept', async () => {
  at('2026-11-22T21:59:00Z');   // Sunday 23:59 in Israel: still week 47
  assert.equal((await admin.get('/api/state')).data.round.week, 47);
  at('2026-11-22T22:00:00Z');   // Monday 00:00 in Israel
  const st = (await admin.get('/api/state')).data;
  assert.equal(st.round.week, 48);
  assert.equal(st.round.status, 'open');
  for (const f of st.forms) {
    assert.equal(f.signed_count, 0, f.company);
    assert.equal(f.approval, null);
  }
  assert.equal((await officers.rechev.get('/api/state')).data.companies.every((c) => c.signed_count === 0), true);
  assert.equal((await companies['א'].get('/api/state')).data.form.status, 'awaiting_signatures');
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א' })).status, 200);

  const hist = (await admin.get('/api/rounds')).data.rounds;
  assert.deepEqual(hist.map((h) => [h.week, h.status, h.approved]), [[48, 'open', 0], [47, 'closed', 1]]);
  const old = (await admin.get(`/api/rounds/${hist[1].id}`)).data;
  const a = old.forms.find((x) => x.company === 'א');
  assert.equal(a.signed_count, a.total);
  assert.equal(a.approval.approver_name, 'סא״ל ישראל');
  // last week's form is locked: undo / approve go to the new week only
  assert.equal((await admin.post('/api/approve', { company: 'ב' })).data.code, 'missing_signatures');
});

test('profile: name and phone; password change logs out other sessions', async () => {
  const other = client();
  await other.post('/api/auth/login', { full_name: 'קצין קל״ג', password: PW });
  const lag = officers.lag;
  assert.equal((await lag.patch('/api/profile', { full_name: 'קצין קל״ג', phone: '12' })).status, 400);
  assert.equal((await lag.patch('/api/profile', { full_name: 'קצין רכב', phone: nextPhone() })).data.code, 'name_taken');
  const ok = await lag.patch('/api/profile', { full_name: 'קצין קל״ג', phone: '0549998877' });
  assert.equal(ok.data.user.phone, '0549998877');
  assert.equal((await lag.post('/api/profile/password', { current_password: 'nope-nope', new_password: 'newpass12' })).data.code, 'bad_password');
  assert.equal((await lag.post('/api/profile/password', { current_password: PW, new_password: 'newpass12' })).status, 200);
  assert.equal((await lag.get('/api/state')).status, 200);     // this session stays
  assert.equal((await other.get('/api/state')).status, 401);   // the other one is logged out
  assert.equal((await client().post('/api/auth/login', { full_name: 'קצין קל״ג', password: PW })).status, 401);
  assert.equal((await client().post('/api/auth/login', { full_name: 'קצין קל״ג', password: 'newpass12' })).status, 200);
});

test('tour is remembered on the account', async () => {
  assert.equal((await officers.klia.get('/api/auth/me')).data.user.onboarded, false);
  await officers.klia.post('/api/onboarding/done');
  assert.equal((await officers.klia.get('/api/auth/me')).data.user.onboarded, true);
});

test('deactivate, reset password, delete (history keeps the name)', async () => {
  const klia = await idOf('קצין קליעה');
  assert.equal((await admin.patch(`/api/users/${klia}`, { active: false })).status, 200);
  assert.equal((await officers.klia.get('/api/state')).status, 401);
  assert.equal((await client().post('/api/auth/login', { full_name: 'קצין קליעה', password: PW })).status, 403);
  assert.equal((await admin.patch(`/api/users/${await idOf('סא״ל ישראל')}`, { active: false })).status, 409);   // not yourself

  const { password } = (await admin.post(`/api/users/${await idOf('קצין תקשוב')}/reset-password`)).data;
  assert.equal((await officers.tikshuv.get('/api/state')).status, 401);
  assert.equal((await client().post('/api/auth/login', { full_name: 'קצין תקשוב', password })).status, 200);

  // ק. רכב signed in round 1 and round 2; delete him
  const rechev = await idOf('קצין רכב');
  assert.equal((await admin.post(`/api/users/${rechev}/delete`, { confirm_name: 'שם אחר' })).status, 400);
  assert.equal((await admin.post(`/api/users/${rechev}/delete`, { confirm_name: 'קצין רכב' })).status, 200);
  assert.equal((await officers.rechev.get('/api/state')).status, 401);
  assert.equal((await users()).some((u) => u.id === rechev), false);
  const hist = (await admin.get('/api/rounds')).data.rounds;
  const old = (await admin.get(`/api/rounds/${hist[hist.length - 1].id}`)).data;
  assert.equal(old.forms.find((f) => f.company === 'א').areas.find((r) => r.key === 'rechev').items[0].signer_name, 'קצין רכב');
  // the name is free again
  assert.equal((await client().post('/api/auth/register', { full_name: 'קצין רכב', phone: nextPhone(), password: PW })).status, 200);
});
