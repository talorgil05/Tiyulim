// Weekly uploads: each company uploads photos / PDF files for a few fixed items every week (UPLOADS in
// constants.js) — e.g. נוהל דרך המלך, צילומי רכבים. For tracking only: they don't block the final approval.
// Who sees them: the company (its own), the מג״ד (all), and the officer of the item's area (e.g. רכב → צילומי רכבים).
// The file data is removed after KEEP_DAYS; the record stays, showing that the file was removed.
import { COMPANIES, UPLOADS, UPLOAD, roleKeysOf } from './constants.js';

export const KEEP_DAYS = 60;
const MAX_FILES = 10;                   // per item, company and week
const MAX_IMAGE = 1.5 * 1024 * 1024;   // photos are shrunk in the browser first; this is a safety limit
const MAX_PDF = 3 * 1024 * 1024;        // keeps one request under the hosting limit (base64 adds a third)
const IMAGE_SIG = { 'image/jpeg': [0xff, 0xd8], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

/** The upload items this user may see for a company. */
export function visibleUploads(user, company) {
  if (user.kind === 'admin') return UPLOADS;
  if (user.kind === 'company') return user.company_key === company ? UPLOADS : [];
  if (user.kind === 'officer') { const mine = roleKeysOf(user); return UPLOADS.filter((u) => mine.includes(u.owner)); }
  return [];
}

export function registerUploads({ route, db, HttpError, bad, conflict, notFound, nowIso, clock, changed, companyKey }) {
  const ANY = null;

  let lastPurge = 0;   // old files are removed now and then (at most every 10 minutes per server instance)
  async function purgeOldFiles() {
    if (Date.now() - lastPurge < 10 * 60 * 1000) return;
    lastPurge = Date.now();
    const cutoff = new Date(clock().getTime() - KEEP_DAYS * 864e5).toISOString();
    await db.run('UPDATE week_files SET data = NULL, purged_at = ? WHERE data IS NOT NULL AND created_at < ?', nowIso(), cutoff);
  }

  /**
   * The upload status of companies in a week, limited to what this user may see:
   * { [company]: [{ key, label, count, files: [{ id, kind, name, size, uploader_name, created_at, gone, mine }] }] }
   */
  async function uploadsOf(user, roundId, companies) {
    await purgeOldFiles();
    const rows = roundId ? await db.all(`SELECT id, company_key, item_key, user_id, uploader_name, kind, name, size, created_at, purged_at
      FROM week_files WHERE round_id = ? AND deleted_at IS NULL ORDER BY id`, roundId) : [];
    const out = {};
    for (const c of companies) {
      const items = visibleUploads(user, c);
      if (!items.length) continue;
      out[c] = items.map((u) => {
        const files = rows.filter((r) => r.company_key === c && r.item_key === u.key).map((r) => ({
          id: r.id, kind: r.kind, name: r.name, size: r.size, uploader_name: r.uploader_name, created_at: r.created_at,
          gone: !!r.purged_at, mine: r.user_id === user.id,
        }));
        return { key: u.key, label: u.label, count: files.length, files };
      });
    }
    return out;
  }

  /** The week a company uploads to: this week, or a past week the מג״ד reopened. The מג״ד may use any week. */
  async function uploadRound(user, roundId) {
    if (roundId === undefined || roundId === null || roundId === '') {
      const r = await db.get(`SELECT * FROM rounds WHERE status = 'open'`);
      if (!r) throw conflict('הטופס של השבוע עוד לא נפתח. נסו שוב בעוד רגע', 'no_round');
      return r;
    }
    const r = await db.get('SELECT * FROM rounds WHERE id = ?', Number(roundId));
    if (!r) throw notFound('השבוע לא נמצא');
    if (user.kind !== 'admin' && r.status !== 'open' && !r.reopened) throw conflict('השבוע הזה נעול', 'week_locked');
    return r;
  }

  /** Upload one file: { company, item, file: { name, mime, data (base64) }, round_id? } — the company itself or the מג״ד. */
  route('POST', '/api/uploads', ANY, async ({ user, body }) => {
    const c = companyKey(body.company);
    const u = UPLOAD[body.item];
    if (!u) throw bad('פריט לא קיים', 'item');
    if (!(user.kind === 'admin' || (user.kind === 'company' && user.company_key === c))) throw new HttpError(403, 'רק הפלוגה יכולה להעלות קבצים לטופס שלה', 'forbidden');
    const { name, mime, data } = body.file || {};
    if (typeof data !== 'string' || typeof mime !== 'string') throw bad('לא נבחר קובץ', 'file');
    const buf = Buffer.from(data, 'base64');
    let kind;
    if (IMAGE_SIG[mime]) {
      if (!IMAGE_SIG[mime].every((b, i) => buf[i] === b)) throw bad('הקובץ אינו תמונה תקינה', 'file');
      if (buf.length > MAX_IMAGE) throw bad('התמונה גדולה מדי', 'too_large');
      kind = 'image';
    } else if (mime === 'application/pdf') {
      if (buf.subarray(0, 4).toString('latin1') !== '%PDF') throw bad('הקובץ אינו PDF תקין', 'file');
      if (buf.length > MAX_PDF) throw bad('קובץ ה־PDF גדול מדי (עד 3MB)', 'too_large');
      kind = 'pdf';
    } else {
      throw bad('אפשר להעלות רק תמונות או קבצי PDF', 'file_type');
    }
    const safe = String(name || (kind === 'pdf' ? 'קובץ.pdf' : 'תמונה.jpg')).replace(/[\\/\0-\x1f"<>|:*?]/g, '_').slice(0, 80);
    const r = await uploadRound(user, body.round_id);
    const id = await db.tx(async (t) => {
      const { n } = await t.get('SELECT COUNT(*) AS n FROM week_files WHERE round_id = ? AND company_key = ? AND item_key = ? AND deleted_at IS NULL', r.id, c, u.key);
      if (n >= MAX_FILES) throw conflict(`אפשר עד ${MAX_FILES} קבצים לכל פריט בשבוע`, 'too_many');
      return (await t.run(`INSERT INTO week_files (round_id, company_key, item_key, user_id, uploader_name, kind, mime, name, size, data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.id, c, u.key, user.id, user.full_name, kind, mime, safe, buf.length, buf, nowIso())).lastInsertRowid;
    });
    await changed();
    return { id };
  }, { maxBody: 5 * 1024 * 1024 });

  /** Remove a file: the company (while the week is open or reopened) or the מג״ד. */
  route('POST', '/api/uploads/:id/delete', ANY, async ({ user, params }) => {
    const f = await db.get('SELECT * FROM week_files WHERE id = ? AND deleted_at IS NULL', Number(params.id));
    if (!f) throw notFound('הקובץ לא נמצא');
    if (user.kind !== 'admin') {
      if (!(user.kind === 'company' && user.company_key === f.company_key)) throw new HttpError(403, 'אין לך הרשאה למחוק את הקובץ', 'forbidden');
      await uploadRound(user, f.round_id);   // only while that week is open
    }
    await db.run('UPDATE week_files SET deleted_at = ?, data = NULL WHERE id = ?', nowIso(), f.id);
    await changed();
    return { ok: true };
  });

  /** A file — only for someone allowed to see that item of that company. */
  route('GET', '/api/files/:id', ANY, async ({ user, params }) => {
    const f = await db.get('SELECT * FROM week_files WHERE id = ? AND deleted_at IS NULL', Number(params.id));
    if (!f || !COMPANIES.includes(f.company_key) || !visibleUploads(user, f.company_key).some((u) => u.key === f.item_key)) throw notFound('הקובץ לא נמצא');
    if (!f.data) throw new HttpError(410, `הקובץ נמחק (קבצים נשמרים ${KEEP_DAYS} יום)`, 'gone');
    return { __binary: true, type: f.mime, buffer: Buffer.from(f.data), filename: f.name };
  });

  return { uploadsOf };
}
