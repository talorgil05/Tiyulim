// Vercel entry: every /api/* request comes here (see vercel.json). The static files (public/) are served by
// Vercel itself. One handler is kept per warm instance, so the database is opened once, not on every request.
import { createHandler } from '../server/app.js';

const env = (k) => (process.env[k] ?? '').trim();   // values pasted into a dashboard often end with a newline
let ready = null;

function init() {
  if (!env('TURSO_DATABASE_URL')) throw new Error('TURSO_DATABASE_URL חסר בהגדרות של Vercel');
  return createHandler({
    dbUrl: env('TURSO_DATABASE_URL'),
    authToken: env('TURSO_AUTH_TOKEN'),
    setupCode: env('SETUP_CODE') || undefined,
    secureCookies: true,
    trustProxy: true,
  });
}

export default async function handler(req, res) {
  try {
    ready ??= init();
    const { handle } = await ready;
    // the rewrite passes the original path as ?__p=…; put it back so the router sees /api/<path>
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams.get('__p');
    if (p !== null) {
      url.searchParams.delete('__p');
      req.url = `/api/${p}${url.search}`;
    }
    await handle(req, res);
  } catch (e) {
    ready = null;   // try again on the next request (e.g. after fixing a setting)
    console.error(e);
    // a short reason helps fix a setting from the outside; secrets are cut out of it
    let reason = `${e?.code || e?.name || 'Error'}: ${String(e?.message || '').slice(0, 160)}`;
    for (const k of ['TURSO_AUTH_TOKEN', 'TURSO_DATABASE_URL']) if (env(k)) reason = reason.split(env(k)).join(`<${k}>`);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'שגיאת שרת. נסו שוב', code: 'server_init', reason }));
  }
}
