const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const fStamp = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** ISO timestamp → Israel local date and time */
export const fmtStamp = (iso) => (iso ? fStamp.format(new Date(iso)) : '');

export const coName = (c) => (c === 'מפקדה' ? 'מפקדה' : `פלוגה ${c}`);

/** Status shown with a symbol and words, never by color alone. */
export const yes = (label) => `<span class="mark yes" aria-hidden="true">✓</span><span class="st-yes">${esc(label)}</span>`;
export const no = (label) => `<span class="mark no" aria-hidden="true"></span><span class="st-no">${esc(label)}</span>`;

export function toast(msg, type = '') {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  if (type === 'error') t.setAttribute('role', 'alert');
  box.append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
}

/** Modal sheet (native <dialog>: focus trapping, Esc to close) — same as תיאומון. */
export function openSheet({ title, body, foot = '', wide = false, onClose } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = `sheet${wide ? ' wide' : ''}`;
  const id = `dlg-${Math.random().toString(36).slice(2)}`;
  dlg.setAttribute('aria-labelledby', id);
  dlg.innerHTML = `
    <div class="sheet-head"><h2 id="${id}">${esc(title)}</h2>
      <button type="button" class="btn btn-sm btn-ghost" data-close aria-label="סגירה">✕</button></div>
    <div class="sheet-body">${body}</div>
    ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
  document.body.append(dlg);
  const prevFocus = document.activeElement;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (dlg.open) dlg.close();
    dlg.remove();
    onClose?.();
    prevFocus?.focus?.();
  };
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === dlg) finish(); });
  dlg.addEventListener('close', finish);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(); });
  dlg.showModal();
  return { dlg, close: finish, $: (s) => dlg.querySelector(s) };
}

export function confirmSheet({ title, text, confirmLabel = 'אישור' }) {
  return new Promise((resolve) => {
    let result = false;
    const s = openSheet({
      title, body: `<p>${esc(text)}</p>`,
      foot: `<button type="button" class="btn" data-close>ביטול</button><button type="button" class="btn btn-primary" data-ok>${esc(confirmLabel)}</button>`,
      onClose: () => resolve(result),
    });
    s.$('[data-ok]').addEventListener('click', () => { result = true; s.close(); });
  });
}
