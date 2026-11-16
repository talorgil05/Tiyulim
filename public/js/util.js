const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// ---- icons (same set as תיאומון) ----
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const ICONS = {
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5.5 19 2 12 2 12a19.8 19.8 0 0 1 5.06-5.94M9.9 4.24A9.7 9.7 0 0 1 12 4c6.5 0 10 7 10 7a19.9 19.9 0 0 1-2.16 3.19M14.12 14.12A3 3 0 1 1 9.88 9.88M1 1l22 22"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4M12 2v13"/>'),
  dots: svg('<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>'),
  phone: svg('<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  login: svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>'),
};

/** Adds a show/hide (eye) button to every password field inside root. Safe to call more than once. */
export function addPasswordToggles(root) {
  root.querySelectorAll('input[type=password]:not([data-eye])').forEach((input) => {
    input.dataset.eye = '1';
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.replaceWith(wrap);
    wrap.append(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'הצגת הסיסמה');
    btn.innerHTML = ICONS.eye;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'הסתרת הסיסמה' : 'הצגת הסיסמה');
      btn.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
      input.focus({ preventScroll: true });
    });
    wrap.append(btn);
  });
}

/** Disable a button while an async action runs (prevents double submits). */
export async function busy(btn, fn) {
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn && btn.isConnected) btn.disabled = false; }
}

export const phoneLink = (p) => (p
  ? `<a class="ltr" href="tel:${esc(p)}">${esc(p.replace(/^(\d{3})(\d{7})$/, '$1-$2'))}</a>`
  : '<span class="muted">אין טלפון</span>');
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = () => /Android/i.test(navigator.userAgent);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

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
