// PDF of a company's weekly form. Every A4 page is drawn on a canvas with the browser's own text engine
// (so Hebrew, spaces and numbers come out exactly right), then jsPDF (a local copy in /vendor, loaded on the
// first click only) puts the pages into one file that is downloaded.

const W = 1240, H = 1754;          // A4 at 150 dpi
const M = 70;                       // page margin
const C = { navy: '#0B2559', blue: '#2F6DB4', orange: '#C25E00', ink: '#1B2433', ink2: '#3D4656', muted: '#667085',
  line: '#D5DBE6', soft: '#F3F6FB', ok: '#157F3D', okSoft: '#E9F6EE', pend: '#8A5A00' };
const FONT = '"Segoe UI", "Rubik", "Assistant", "Heebo", Arial, sans-serif';

let lib = null;
function loadJsPdf() {
  lib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jspdf.umd.min.js';
    s.onload = () => resolve(window.jspdf.jsPDF);
    s.onerror = () => { lib = null; reject(new Error('לא הצלחנו לטעון את יוצר ה־PDF. בדקו את החיבור ונסו שוב')); };
    document.head.append(s);
  });
  return lib;
}
const loadImg = (src) => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });

const stamp = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmt = (iso) => (iso ? stamp.format(new Date(iso)) : '');
const dmy = (iso) => { const [y, m, d] = iso.split('-'); return `${Number(d)}.${Number(m)}.${y}`; };

/**
 * form: one company's form ({ company, areas[{label, items[{label, signed, signer_name, signed_at}], signed_count, total, done, legacy}],
 *       signed_count, total, areas_done, areas_total, status, approval }); round: the week; title: e.g. "פלוגה ד".
 */
export async function downloadFormPdf({ form, round, title, filename }) {
  const [JsPDF, logo] = await Promise.all([loadJsPdf(), loadImg('/icons/logo.png')]);
  const pages = [];
  let cv, ctx, y;

  const font = (size, weight = 400) => { ctx.font = `${weight} ${size}px ${FONT}`; };
  const text = (s, x, yy, { size = 26, weight = 400, color = C.ink, align = 'right', max } = {}) => {
    font(size, weight);
    ctx.fillStyle = color; ctx.textAlign = align;
    let t = String(s);
    if (max && ctx.measureText(t).width > max) {
      while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
      t = `${t}…`;
    }
    ctx.fillText(t, x, yy);
    return ctx.measureText(t).width;
  };
  const rect = (x, yy, w, h, fill, stroke, r = 10) => {
    ctx.beginPath(); ctx.roundRect(x, yy, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  };
  const mark = (x, yy, ok) => {   // ✓ in a green circle, or an empty ring
    ctx.beginPath(); ctx.arc(x, yy, 13, 0, Math.PI * 2);
    if (ok) {
      ctx.fillStyle = C.ok; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(x - 6, yy); ctx.lineTo(x - 1.5, yy + 5); ctx.lineTo(x + 7, yy - 5); ctx.stroke();
    } else { ctx.strokeStyle = C.muted; ctx.lineWidth = 2.5; ctx.stroke(); }
  };

  const newPage = () => {
    cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    ctx = cv.getContext('2d'); ctx.direction = 'rtl'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    pages.push(cv);
    // header on every page
    if (logo) ctx.drawImage(logo, W - M - 96, M - 6, 96, 96);
    text(`טופס טיולים — ${title}`, W - M - 116, M + 22, { size: 40, weight: 800, color: C.navy });
    const week = round?.week ? `שבוע ${round.week} · ${dmy(round.starts_on)} – ${dmy(round.ends_on)}` : '';
    text(week, W - M - 116, M + 66, { size: 24, color: C.ink2 });
    text(`הופק: ${fmt(new Date().toISOString())}`, M, M + 66, { size: 20, color: C.muted, align: 'left' });
    ctx.fillStyle = C.navy; ctx.fillRect(M, M + 104, W - 2 * M, 4);
    y = M + 136;
  };
  const room = (h) => { if (y + h > H - M - 40) newPage(); };

  newPage();
  // summary line
  text(`${form.areas_done}/${form.areas_total} תחומים הושלמו · ${form.signed_count}/${form.total} שורות נחתמו`, W - M, y + 14, { size: 26, weight: 700, color: C.ink2 });
  y += 52;

  const ROW = 50, HEAD = 56;
  for (const a of form.areas) {
    const rows = a.items.length;
    room(HEAD + Math.min(rows, 3) * ROW + 16);   // never leave an area's title alone at the bottom
    // area title
    const done = a.done || (a.legacy && !a.signed_count);
    rect(M, y, W - 2 * M, HEAD, done ? C.okSoft : C.soft, null, 12);
    text(a.label, W - M - 20, y + HEAD / 2, { size: 28, weight: 800, color: C.navy });
    const st = a.legacy && !a.signed_count ? `נחתם (גרסה קודמת) · ${a.legacy.signer_name}` : done ? 'הושלם' : `${a.signed_count}/${a.total}`;
    if (done) mark(M + 30, y + HEAD / 2, true);
    text(st, M + (done ? 54 : 20), y + HEAD / 2, { size: 24, weight: 700, color: done ? C.ok : C.ink2, align: 'left' });
    y += HEAD + 6;
    for (const it of a.items) {
      room(ROW);
      ctx.fillStyle = C.line; ctx.fillRect(M + 10, y + ROW - 1, W - 2 * M - 20, 1);
      text(it.label, W - M - 24, y + ROW / 2, { size: 24, color: C.ink, max: 560 });
      if (it.signed) {
        mark(M + 30, y + ROW / 2, true);
        text(`חתם · ${it.signer_name} · ${fmt(it.signed_at)}`, M + 54, y + ROW / 2, { size: 21, color: C.ok, align: 'left', max: 470 });
      } else {
        mark(M + 30, y + ROW / 2, false);
        text('טרם חתם', M + 54, y + ROW / 2, { size: 21, color: C.muted, align: 'left' });
      }
      y += ROW;
    }
    y += 18;
  }

  // the מג״ד's approval
  room(110);
  const FINAL = {
    awaiting_signatures: ['ממתינים לחתימות קציני המטה', C.pend, '#FFF7D6'],
    awaiting_approval: ['כל קציני המטה חתמו — ממתינים לאישור מג״ד', C.orange, '#FFF1E3'],
    approved: ['הטופס אושר על ידי המג״ד', C.ok, C.okSoft],
  }[form.status];
  rect(M, y, W - 2 * M, form.approval ? 96 : 70, FINAL[2], FINAL[1], 14);
  text(`אישור מג״ד: ${FINAL[0]}`, W - M - 24, y + 35, { size: 28, weight: 800, color: FINAL[1] });
  if (form.approval) text(`אושר על ידי ${form.approval.approver_name} · ${fmt(form.approval.approved_at)}`, W - M - 24, y + 72, { size: 22, color: C.ink2 });

  // page numbers, then the file
  pages.forEach((p, i) => {
    const c = p.getContext('2d'); c.direction = 'rtl'; c.textBaseline = 'middle'; c.textAlign = 'center';
    c.font = `400 20px ${FONT}`; c.fillStyle = C.muted;
    c.fillText(`עמוד ${i + 1} מתוך ${pages.length}`, W / 2, H - M / 2);
  });
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  doc.setProperties({ title: filename });
  pages.forEach((p, i) => {
    if (i) doc.addPage();
    doc.addImage(p.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297);
  });
  doc.save(`${filename}.pdf`);
}
