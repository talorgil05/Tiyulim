// Full flow from the spec, over real HTTP against a temporary database file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { ROLES, COMPANIES } from '../server/constants.js';

const SETUP = 'setup-code-123456';
let server, db, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiyulim-'));
  ({ server, db } = await createApp({ dbUrl: path.join(dir, 't.db'), setupCode: SETUP, log: { error() {} } }));
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

test('no signing before the first round is opened', async () => {
  const r = await officers.rechev.post('/api/sign', { company: 'א' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'no_round');
});

test('CSRF header is required on writes', async () => {
  assert.equal((await admin.post('/api/rounds/open', {}, { csrf: false })).status, 403);
});

test('only the מג״ד opens a round', async () => {
  assert.equal((await officers.rechev.post('/api/rounds/open')).status, 403);
  assert.equal((await companies['א'].post('/api/rounds/open')).status, 403);
  const r = await admin.post('/api/rounds/open');
  assert.equal(r.status, 200);
  assert.equal(r.data.round.number, 1);
  assert.equal((await admin.post('/api/rounds/open')).status, 409);   // already open
});

test('officer signs once, only in the name of their own role', async () => {
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א' })).status, 200);
  const again = await officers.rechev.post('/api/sign', { company: 'א' });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'already_signed');
  // trying to sign as another role is refused
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א', role: 'lag' })).status, 403);
  // company users and the מג״ד cannot sign at all
  assert.equal((await companies['א'].post('/api/sign', { company: 'א' })).status, 403);
  assert.equal((await admin.post('/api/sign', { company: 'א' })).status, 403);
  assert.equal((await officers.rechev.post('/api/sign', { company: 'לא קיימת' })).status, 400);

  const st = (await officers.rechev.get('/api/state')).data;
  const a = st.companies.find((c) => c.company === 'א');
  assert.equal(a.signed, true);
  assert.equal(a.signer_name, 'קצין ק. רכב');
  assert.ok(a.signed_at);
  assert.equal(st.companies.find((c) => c.company === 'ב').signed, false);
  assert.equal(st.forms, undefined);   // an officer never gets other roles' data
});

test('company user sees only its own form', async () => {
  const st = (await companies['א'].get('/api/state')).data;
  assert.equal(st.form.company, 'א');
  assert.equal(st.forms, undefined);
  assert.equal(st.form.signed_count, 1);
  assert.equal(st.form.status, 'awaiting_signatures');
  const rechev = st.form.roles.find((r) => r.key === 'rechev');
  assert.equal(rechev.signed, true);
  assert.equal(rechev.signer_name, 'קצין ק. רכב');
  // another company's form shows nothing of א
  const b = (await companies['ב'].get('/api/state')).data;
  assert.equal(b.form.company, 'ב');
  assert.equal(b.form.signed_count, 0);
  // history (all companies) is the מג״ד's only
  assert.equal((await companies['א'].get('/api/rounds')).status, 403);
  assert.equal((await companies['א'].get('/api/rounds/1')).status, 403);
  // and it cannot approve
  assert.equal((await companies['א'].post('/api/approve', { company: 'א' })).status, 403);
});

test('final approval is blocked while a signature is missing', async () => {
  for (const r of ROLES.slice(1, -1)) assert.equal((await officers[r.key].post('/api/sign', { company: 'א' })).status, 200);
  const st = (await admin.get('/api/state')).data.forms.find((f) => f.company === 'א');
  assert.equal(st.signed_count, ROLES.length - 1);
  const r = await admin.post('/api/approve', { company: 'א' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'missing_signatures');
});

test('all signed → waiting for the מג״ד (no automatic approval) → מג״ד approves', async () => {
  const last = ROLES[ROLES.length - 1].key;
  assert.equal((await officers[last].post('/api/sign', { company: 'א' })).status, 200);
  let form = (await companies['א'].get('/api/state')).data.form;
  assert.equal(form.signed_count, ROLES.length);
  assert.equal(form.status, 'awaiting_approval');
  assert.equal(form.approval, null);

  assert.equal((await officers.rechev.post('/api/approve', { company: 'א' })).status, 403);
  assert.equal((await admin.post('/api/approve', { company: 'א' })).status, 200);
  assert.equal((await admin.post('/api/approve', { company: 'א' })).status, 409);

  form = (await companies['א'].get('/api/state')).data.form;
  assert.equal(form.status, 'approved');
  assert.equal(form.approval.approver_name, 'סא״ל ישראל');
  assert.ok(form.approval.approved_at);
  // ב is untouched
  assert.equal((await admin.get('/api/state')).data.forms.find((f) => f.company === 'ב').status, 'awaiting_signatures');
});

test('closing the round locks it', async () => {
  assert.equal((await officers.lag.post('/api/rounds/close')).status, 403);
  assert.equal((await admin.post('/api/rounds/close')).status, 200);
  const s = await officers.lag.post('/api/sign', { company: 'ב' });
  assert.equal(s.status, 409);
  assert.equal(s.data.code, 'no_round');
  assert.equal((await admin.post('/api/approve', { company: 'ב' })).status, 409);
  // still visible, read-only
  const st = (await companies['א'].get('/api/state')).data;
  assert.equal(st.round.status, 'closed');
  assert.equal(st.form.status, 'approved');
});

test('a new round starts clean; the previous one stays in history', async () => {
  const r = await admin.post('/api/rounds/open');
  assert.equal(r.data.round.number, 2);
  const st = (await admin.get('/api/state')).data;
  assert.equal(st.round.number, 2);
  for (const f of st.forms) {
    assert.equal(f.signed_count, 0, f.company);
    assert.equal(f.approval, null);
  }
  assert.equal((await officers.rechev.get('/api/state')).data.companies.every((c) => !c.signed), true);
  assert.equal((await companies['א'].get('/api/state')).data.form.status, 'awaiting_signatures');

  // officer can sign again in the new round
  assert.equal((await officers.rechev.post('/api/sign', { company: 'א' })).status, 200);

  const hist = (await admin.get('/api/rounds')).data.rounds;
  assert.deepEqual(hist.map((h) => [h.number, h.status, h.approved]), [[2, 'open', 0], [1, 'closed', 1]]);
  const old = (await admin.get(`/api/rounds/${hist[1].id}`)).data;
  const a = old.forms.find((f) => f.company === 'א');
  assert.equal(a.signed_count, ROLES.length);
  assert.equal(a.approval.approver_name, 'סא״ל ישראל');
});

test('profile: name and phone; password change logs out other sessions', async () => {
  const other = client();
  await other.post('/api/auth/login', { full_name: 'קצין קל״ג', password: PW });
  const lag = officers.lag;
  assert.equal((await lag.patch('/api/profile', { full_name: 'קצין קל״ג', phone: '12' })).status, 400);
  assert.equal((await lag.patch('/api/profile', { full_name: 'קצין ק. רכב', phone: nextPhone() })).data.code, 'name_taken');
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
  const klia = await idOf('קצין ק. קליעה');
  assert.equal((await admin.patch(`/api/users/${klia}`, { active: false })).status, 200);
  assert.equal((await officers.klia.get('/api/state')).status, 401);
  assert.equal((await client().post('/api/auth/login', { full_name: 'קצין ק. קליעה', password: PW })).status, 403);
  assert.equal((await admin.patch(`/api/users/${await idOf('סא״ל ישראל')}`, { active: false })).status, 409);   // not yourself

  const { password } = (await admin.post(`/api/users/${await idOf('קצין קשר״ג')}/reset-password`)).data;
  assert.equal((await officers.kashrag.get('/api/state')).status, 401);
  assert.equal((await client().post('/api/auth/login', { full_name: 'קצין קשר״ג', password })).status, 200);

  // ק. רכב signed in round 1 and round 2; delete him
  const rechev = await idOf('קצין ק. רכב');
  assert.equal((await admin.post(`/api/users/${rechev}/delete`, { confirm_name: 'שם אחר' })).status, 400);
  assert.equal((await admin.post(`/api/users/${rechev}/delete`, { confirm_name: 'קצין ק. רכב' })).status, 200);
  assert.equal((await officers.rechev.get('/api/state')).status, 401);
  assert.equal((await users()).some((u) => u.id === rechev), false);
  const hist = (await admin.get('/api/rounds')).data.rounds;
  const old = (await admin.get(`/api/rounds/${hist[hist.length - 1].id}`)).data;
  assert.equal(old.forms.find((f) => f.company === 'א').roles.find((r) => r.key === 'rechev').signer_name, 'קצין ק. רכב');
  // the name is free again
  assert.equal((await client().post('/api/auth/register', { full_name: 'קצין ק. רכב', phone: nextPhone(), password: PW })).status, 200);
});
