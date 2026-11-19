// Weekly uploads (photos / PDF) shown inside a company's form: נוהל דרך המלך, מעקבי בטיחות, מעקבי קליעה,
// מעקבי הדרכה, צילומי רכבים. The company uploads; the מג״ד and the officer of each item see them.
import { api } from './api.js';
import { esc, toast, confirmSheet } from './util.js';

const MAX_SIDE = 1600;   // photos are shrunk to this before upload (keeps the free database small)
const MAX_PDF = 3 * 1024 * 1024;
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** The uploads block: one card per item, with its files. */
export function uploadsView(items, { canUpload = false, canDelete = false, title = 'קבצים לשבוע' } = {}) {
  if (!items?.length) return '';
  const done = items.filter((u) => u.count).length;
  const cards = items.map((u) => {
    const files = u.files.map((f) => {
      const del = canDelete && !f.gone ? `<button type="button" class="up-del no-print" data-up-del="${f.id}" aria-label="מחיקת ${esc(f.name)}" title="מחיקה">✕</button>` : '';
      if (f.gone) return `<span class="up-file gone" title="${esc(f.name)}">🗑 הקובץ נמחק (נשמר 60 יום)</span>`;
      if (f.kind === 'image') {
        return `<span class="up-file"><a class="up-thumb" href="/api/files/${f.id}" target="_blank" rel="noopener" title="${esc(`${f.name} · ${f.uploader_name}`)}">
          <img src="/api/files/${f.id}" alt="${esc(f.name)}" loading="lazy"></a>${del}</span>`;
      }
      return `<span class="up-file"><a class="up-pdf" href="/api/files/${f.id}" target="_blank" rel="noopener" title="${esc(f.uploader_name)}">📄 ${esc(f.name)} <small>${kb(f.size)}</small></a>${del}</span>`;
    }).join('');
    return `<div class="up-card ${u.count ? 'ok' : ''}">
      <div class="up-head"><b>${esc(u.label)}</b>
        <span class="up-st">${u.count ? `<span class="mark yes" aria-hidden="true">✓</span><span class="st-yes">${u.count === 1 ? 'קובץ אחד' : `${u.count} קבצים`}</span>`
          : '<span class="mark no" aria-hidden="true"></span><span class="st-no">חסר</span>'}</span></div>
      ${files ? `<div class="up-files">${files}</div>` : ''}
      ${canUpload ? `<label class="btn btn-sm up-add no-print">➕ העלאת תמונה / PDF
        <input type="file" accept="image/*,application/pdf" multiple data-upload="${esc(u.key)}" hidden></label>` : ''}
    </div>`;
  }).join('');
  return `<section class="uploads">
    <h2 class="up-title">📎 ${esc(title)} <span class="count">${done}/${items.length} הועלו</span></h2>
    <div class="up-grid">${cards}</div>
  </section>`;
}

/** Shrink a photo in the browser (longest side MAX_SIDE, JPEG). */
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error(`לא הצלחנו לקרוא את התמונה ${file.name}`)); i.src = url; });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.82));
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg' };
  } finally { URL.revokeObjectURL(url); }
}
const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('קריאת הקובץ נכשלה'));
  r.readAsDataURL(blob);
});

/** Wire the upload inputs and delete buttons inside root. reload() redraws the screen afterwards. */
export function wireUploads(root, { company, roundId = null, reload }) {
  root.querySelectorAll('[data-upload]').forEach((input) => input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    let ok = 0;
    for (const [i, file] of files.entries()) {
      try {
        let blob = file, name = file.name, mime = file.type;
        if (mime === 'application/pdf') {
          if (file.size > MAX_PDF) throw new Error(`${file.name}: קובץ PDF עד 3MB`);
        } else if (mime.startsWith('image/')) {
          ({ blob, name, mime } = await shrinkImage(file));
        } else {
          throw new Error(`${file.name}: אפשר להעלות רק תמונות או PDF`);
        }
        toast(files.length > 1 ? `מעלה ${i + 1}/${files.length}…` : 'מעלה…');
        await api.post('/api/uploads', { company, item: input.dataset.upload, ...(roundId ? { round_id: roundId } : {}), file: { name, mime, data: await toBase64(blob) } });
        ok++;
      } catch (ex) { toast(ex.message, 'error'); }
    }
    if (ok) toast(ok === 1 ? 'הקובץ הועלה ✓' : `${ok} קבצים הועלו ✓`, 'ok');
    await reload();
  }));
  root.querySelectorAll('[data-up-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'מחיקת קובץ', text: 'למחוק את הקובץ? אי אפשר לשחזר אותו.', confirmLabel: 'מחיקה' }))) return;
    try { await api.post(`/api/uploads/${b.dataset.upDel}/delete`); toast('הקובץ נמחק', 'ok'); } catch (ex) { toast(ex.message, 'error'); }
    await reload();
  }));
}
