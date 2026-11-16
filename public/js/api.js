export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['X-Requested-With'] = 'tiyulim';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new ApiError(0, 'אין חיבור לשרת. בדקו את החיבור לרשת ונסו שוב', 'network'); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/login')) onUnauthorized();
    throw new ApiError(res.status, data?.error || 'שגיאה לא צפויה', data?.code);
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b),
};
