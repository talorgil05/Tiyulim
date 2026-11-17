// The Vercel entry (api/index.js), called the way Vercel calls it: the rewrite sends /api/<path> to
// /api/index?__p=<path>, and the platform may hand over an already-parsed JSON body (req.body).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let server, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiyulim-vercel-'));
  process.env.TURSO_DATABASE_URL = ` ${path.join(dir, 'v.db')}\n`;   // with the stray spaces/newline a dashboard adds
  process.env.SETUP_CODE = 'vercel-setup-code-1';
  const { default: handler } = await import('../api/index.js');
  server = http.createServer(async (req, res) => {
    // what Vercel does: rewrite the URL, and parse JSON bodies itself
    const u = new URL(req.url, 'http://x');
    req.url = `/api/index?__p=${encodeURIComponent(u.pathname.replace(/^\/api\//, ''))}${u.search ? '&' + u.search.slice(1) : ''}`;
    if (req.method !== 'GET') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    }
    await handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  delete process.env.TURSO_DATABASE_URL; delete process.env.SETUP_CODE;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows */ }
});

test('Vercel entry: register, log in, sign and see the change counter move', async () => {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { cookie, ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Requested-With': 'tiyulim' } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) { cookie = set.split(';')[0]; assert.match(set, /Secure/); }
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await call('GET', '/api/health')).data.ok, true);
  const reg = await call('POST', '/api/auth/register', { full_name: 'מג״ד ורסל', phone: '0501231234', password: 'password1', setup_code: 'vercel-setup-code-1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.equal(reg.data.user.kind, 'admin');
  const v0 = (await call('GET', '/api/version')).data.version;
  assert.equal((await call('POST', '/api/rounds/open')).status, 200);
  const v1 = (await call('GET', '/api/version')).data.version;
  assert.ok(v1 > v0, `version should move: ${v0} → ${v1}`);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});
