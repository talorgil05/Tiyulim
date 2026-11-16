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
  return { get: (u) => call('GET', u), post: (u, b, o) => call('POST', u, b, o) };
}

const admin = client();
const officers = {};   // role key → client
const companies = {};  // company → client

test('first מג״ד only with the setup code, then setup is closed', async () => {
  assert.equal((await admin.post('/api/setup', { setup_code: 'wrong-code-xxxx', full_name: 'מג״ד', username: 'magad', password: 'password1' })).status, 403);
  const ok = await admin.post('/api/setup', { setup_code: SETUP, full_name: 'סא״ל ישראל', username: 'magad', password: 'password1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.kind, 'admin');
  assert.equal((await client().post('/api/setup', { setup_code: SETUP, full_name: 'x y', username: 'x2', password: 'password1' })).status, 409);
});

test('מג״ד creates an account for every role and company; others cannot', async () => {
  for (const r of ROLES) {
    const res = await admin.post('/api/users', { kind: 'officer', role_key: r.key, full_name: `קצין ${r.label}`, username: `o-${r.key}`, password: 'password1' });
    assert.equal(res.status, 200, res.data?.error);
    officers[r.key] = client();
    assert.equal((await officers[r.key].post('/api/auth/login', { username: `o-${r.key}`, password: 'password1' })).status, 200);
  }
  for (const [i, c] of COMPANIES.entries()) {
    assert.equal((await admin.post('/api/users', { kind: 'company', company_key: c, full_name: `פלוגה ${c}`, username: `c${i}`, password: 'password1' })).status, 200);
    companies[c] = client();
    assert.equal((await companies[c].post('/api/auth/login', { username: `c${i}`, password: 'password1' })).status, 200);
  }
  assert.equal((await admin.post('/api/users', { kind: 'officer', role_key: 'lag', full_name: 'כפול', username: 'o-lag', password: 'password1' })).status, 409);
  // a regular user cannot create users or give themselves another role
  assert.equal((await officers.rechev.post('/api/users', { kind: 'admin', full_name: 'האקר', username: 'h', password: 'password1' })).status, 403);
  assert.equal((await companies['א'].get('/api/users')).status, 403);
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

test('deactivated user is logged out; password reset works', async () => {
  const users = (await admin.get('/api/users')).data.users;
  const u = users.find((x) => x.username === 'o-klia');
  assert.equal((await admin.post(`/api/users/${u.id}/active`, { active: false })).status, 200);
  assert.equal((await officers.klia.get('/api/state')).status, 401);
  assert.equal((await client().post('/api/auth/login', { username: 'o-klia', password: 'password1' })).status, 403);
  const me = users.find((x) => x.username === 'magad');
  assert.equal((await admin.post(`/api/users/${me.id}/active`, { active: false })).status, 409);

  const k = users.find((x) => x.username === 'o-lag');
  const { password } = (await admin.post(`/api/users/${k.id}/reset-password`)).data;
  assert.equal((await officers.lag.get('/api/state')).status, 401);
  assert.equal((await client().post('/api/auth/login', { username: 'o-lag', password })).status, 200);
});
