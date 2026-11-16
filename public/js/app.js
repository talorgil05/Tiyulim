import { api, setUnauthorizedHandler } from './api.js';
import { esc, fmtStamp, coName, yes, no, toast, openSheet, confirmSheet } from './util.js';

const app = document.getElementById('app');
let me = null;          // the logged-in user
let meta = null;        // roles + companies + kinds
let state = null;       // /api/state answer
let selected = null;    // chosen company (officer / מג״ד)
let tab = 'round';      // מג״ד tab: round | users | history
let events = null;

setUnauthorizedHandler(() => { me = null; stopEvents(); renderLogin(); });

// ---------- boot ----------
(async function boot() {
  meta = await api.get('/api/meta');
  try { me = (await api.get('/api/auth/me')).user; } catch { me = null; }
  if (me) await enter(); else renderLogin();
})();

async function enter() {
  selected = null;
  tab = (location.hash.replace('#/', '') || 'round');
  if (me.kind !== 'admin' || !['round', 'users', 'history'].includes(tab)) tab = 'round';
  await refresh();
  startEvents();
}

async function refresh() {
  state = await api.get('/api/state');
  render();
}

/** Live updates: any signature / approval / round change reloads the state on every open screen. */
function startEvents() {
  stopEvents();
  events = new EventSource('/api/events');
  events.addEventListener('change', () => { if (me && tab === 'round') refresh().catch(() => {}); });
}
function stopEvents() { events?.close(); events = null; }
// a phone coming back from the background: catch up
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me && tab === 'round') refresh().catch(() => {}); });

// ---------- login ----------
async function renderLogin(mode = 'login') {
  app.removeAttribute('aria-busy');
  const setup = mode === 'login' ? (await api.get('/api/setup/status').catch(() => ({ open: false }))).open : true;
  app.innerHTML = `
    <div class="landing" id="main">
      <img class="landing-logo" src="/icons/logo.svg" alt="">
      <h1>טופס טיולים גדודי</h1>
      <p class="landing-tag">חתימות קציני מטה לפני יציאה הביתה</p>
      <form class="auth-card" novalidate>
        <h2>${mode === 'setup' ? 'הקמת מג״ד ראשון' : 'התחברות'}</h2>
        <div class="form-error" hidden></div>
        ${mode === 'setup' ? `
          <div class="field"><label for="f-code">קוד הקמה</label><input id="f-code" type="password" autocomplete="off" required></div>
          <div class="field"><label for="f-name">שם מלא</label><input id="f-name" type="text" required></div>` : ''}
        <div class="field"><label for="f-user">שם משתמש</label><input id="f-user" type="text" autocomplete="username" autocapitalize="off" required></div>
        <div class="field"><label for="f-pw">סיסמה</label><input id="f-pw" type="password" autocomplete="${mode === 'setup' ? 'new-password' : 'current-password'}" required>
          ${mode === 'setup' ? '<span class="hint">לפחות 8 תווים</span>' : ''}</div>
        <button class="btn btn-primary btn-big btn-block" type="submit">${mode === 'setup' ? 'יצירת חשבון מג״ד' : 'כניסה'}</button>
        ${mode === 'setup' ? '<div class="auth-switch"><button type="button" class="btn btn-ghost" data-back>חזרה להתחברות</button></div>'
          : setup ? '<div class="auth-switch"><button type="button" class="btn btn-orange btn-block" data-setup>הקמת מג״ד ראשון (קוד הקמה)</button></div>' : ''}
      </form>
    </div>`;
  const form = app.querySelector('form');
  const err = form.querySelector('.form-error');
  form.querySelector('[data-setup]')?.addEventListener('click', () => renderLogin('setup'));
  form.querySelector('[data-back]')?.addEventListener('click', () => renderLogin('login'));
  form.querySelector('input').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const body = { username: form.querySelector('#f-user').value, password: form.querySelector('#f-pw').value };
      if (mode === 'setup') Object.assign(body, { setup_code: form.querySelector('#f-code').value, full_name: form.querySelector('#f-name').value });
      me = (await api.post(mode === 'setup' ? '/api/setup' : '/api/auth/login', body)).user;
      await enter();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false;
    }
  });
}

// ---------- shell ----------
function shell(content) {
  const sub = me.kind === 'officer' ? me.role_label : me.kind === 'company' ? coName(me.company_key) : 'מג״ד';
  const tabs = me.kind === 'admin' ? `
    <nav class="tabs" aria-label="מסכי מג״ד">
      ${[['round', 'סבב נוכחי'], ['users', 'משתמשים'], ['history', 'היסטוריה']].map(([k, l]) =>
        `<button class="tab" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('')}
    </nav>` : '';
  app.removeAttribute('aria-busy');
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><img src="/icons/logo.svg" alt=""><span>טופס טיולים גדודי</span></div>
        <div class="spacer"></div>
        <div class="who"><b>${esc(me.full_name)}</b><span>${esc(sub)}</span></div>
        <button class="btn btn-sm" data-logout>יציאה</button>
      </header>
      ${tabs}
      <main id="main">${content}</main>
    </div>`;
  app.querySelector('[data-logout]').addEventListener('click', async () => {
    await api.post('/api/auth/logout').catch(() => {});
    me = null; stopEvents(); location.hash = ''; renderLogin();
  });
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', async () => {
    tab = b.dataset.tab; location.hash = `#/${tab}`;
    if (tab === 'round') await refresh(); else render();
  }));
}

function roundBar(round, { admin = false } = {}) {
  if (!round) {
    return admin
      ? `<div class="round-bar"><div class="rb-text"><b>עדיין לא נפתח סבב</b><div class="muted small">פתחו סבב כדי שקציני המטה יוכלו לחתום</div></div>
          <button class="btn btn-primary btn-big" data-open-round>פתיחת סבב חדש</button></div>`
      : '<div class="notice">○ עדיין לא נפתח סבב. אי אפשר לחתום כרגע</div>';
  }
  const open = round.status === 'open';
  const text = open
    ? `<b>סבב ${round.number} — פתוח</b><div class="muted small">נפתח ${esc(fmtStamp(round.opened_at))} על ידי ${esc(round.opened_by_name)}</div>`
    : `<b>סבב ${round.number} — נסגר 🔒</b><div class="muted small">נסגר ${esc(fmtStamp(round.closed_at))} על ידי ${esc(round.closed_by_name)}. החתימות נעולות לצפייה</div>`;
  const action = !admin ? '' : open
    ? '<button class="btn btn-danger btn-big" data-close-round>סיום סבב</button>'
    : '<button class="btn btn-primary btn-big" data-open-round>פתיחת סבב חדש</button>';
  return `<div class="round-bar"><div class="rb-text">${text}</div>${action}</div>`;
}

function render() {
  if (me.kind === 'officer') return renderOfficer();
  if (me.kind === 'company') return renderCompany();
  if (tab === 'users') return renderUsers();
  if (tab === 'history') return renderHistory();
  return renderAdmin();
}

// ---------- staff officer ----------
function renderOfficer() {
  const { round, companies } = state;
  const open = round?.status === 'open';
  if (!selected || !companies.some((c) => c.company === selected)) {
    selected = (companies.find((c) => !c.signed) || companies[0]).company;
  }
  const cur = companies.find((c) => c.company === selected);
  const list = companies.map((c) => `
    <button class="co" data-co="${esc(c.company)}" aria-current="${c.company === selected}">
      <span class="co-name">${esc(coName(c.company))}</span>
      <span class="co-st">${c.signed ? yes('חתמתי') : no('טרם חתמתי')}</span>
    </button>`).join('');
  const button = cur.signed
    ? `<button class="btn-sign done" disabled>חתמתי ✓</button>
       <p class="sign-meta">נחתם על ידי <b>${esc(cur.signer_name)}</b><br>${esc(fmtStamp(cur.signed_at))}</p>`
    : `<button class="btn-sign" data-sign ${open ? '' : 'disabled'}>אישור חתימה</button>
       ${open ? '' : '<p class="sign-meta">אין סבב פתוח. החתימה תתאפשר כשהמג״ד יפתח סבב</p>'}`;
  shell(`
    ${round && open ? '' : roundBar(round)}
    <div class="split">
      <nav class="co-list" aria-label="פלוגות"><h2>פלוגות${round ? ` · סבב ${round.number}` : ''}</h2>${list}</nav>
      <section class="panel sign-panel" aria-live="polite">
        <h1 class="sign-co">${esc(coName(cur.company))}</h1>
        <p class="sign-role">חותם/ת בתור: <b>${esc(me.role_label)}</b></p>
        ${button}
      </section>
    </div>`);
  app.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => {
    selected = b.dataset.co; renderOfficer();
    if (matchMedia('(max-width: 760px)').matches) app.querySelector('.sign-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  app.querySelector('[data-sign]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api.post('/api/sign', { company: cur.company });
      toast(`נחתם ל${coName(cur.company)} ✓`, 'ok');
    } catch (ex) { toast(ex.message, 'error'); }
    await refresh();
  });
}

// ---------- company form (read-only) ----------
const FINAL_TEXT = {
  awaiting_signatures: 'ממתינים לחתימות קציני המטה',
  awaiting_approval: 'כל קציני המטה חתמו — ממתינים לאישור מג״ד',
  approved: 'הטופס אושר על ידי המג״ד',
};
function formView(f) {
  const rows = f.roles.map((r) => `
    <li class="role-row ${r.signed ? 'signed' : ''}">
      <span class="role-name">${esc(r.label)}</span>
      <span class="role-st">${r.signed
        ? `${yes('חתם')} <span class="role-by">${esc(r.signer_name)} · ${esc(fmtStamp(r.signed_at))}</span>`
        : no('טרם חתם')}</span>
    </li>`).join('');
  const markFinal = f.status === 'approved' ? '<span class="mark yes" aria-hidden="true">✓</span>'
    : '<span class="mark wait" aria-hidden="true">…</span>';
  return `
    <div class="form-head"><h1>${esc(coName(f.company))}</h1><span class="count">${f.signed_count}/${f.total} חתמו</span></div>
    <ul class="roles">${rows}</ul>
    <div class="final ${f.status}" role="status">${markFinal}<div>אישור מג״ד: ${FINAL_TEXT[f.status]}
      ${f.approval ? `<small>אושר על ידי ${esc(f.approval.approver_name)} · ${esc(fmtStamp(f.approval.approved_at))}</small>` : ''}</div></div>`;
}

function renderCompany() {
  const { round, form } = state;
  shell(`${roundBar(round)}<section class="panel">${round ? formView(form) : `<div class="form-head"><h1>${esc(coName(me.company_key))}</h1></div><p class="muted">הטופס יופיע כשהמג״ד יפתח סבב.</p>`}</section>`);
}

// ---------- מג״ד ----------
const coStatus = (f) => f.status === 'approved' ? yes('אושר')
  : f.status === 'awaiting_approval' ? `<span class="mark wait" aria-hidden="true">!</span><span class="st-wait">לאישורך</span>`
  : `<span class="mark no" aria-hidden="true"></span><span class="st-no">${f.signed_count}/${f.total}</span>`;

function renderAdmin() {
  const { round, forms } = state;
  const open = round?.status === 'open';
  if (!selected || !forms.some((f) => f.company === selected)) {
    selected = (forms.find((f) => f.status === 'awaiting_approval') || forms[0]).company;
  }
  const f = forms.find((x) => x.company === selected);
  const list = forms.map((x) => `
    <button class="co" data-co="${esc(x.company)}" aria-current="${x.company === selected}">
      <span class="co-name">${esc(coName(x.company))}</span><span class="co-st">${coStatus(x)}</span>
    </button>`).join('');
  let approve = '';
  if (round && f.status !== 'approved') {
    const ready = f.status === 'awaiting_approval';
    approve = `<div class="approve-box">
      <button class="btn-sign" data-approve ${ready && open ? '' : 'disabled'}>אישור סופי לטופס</button>
      <span class="muted small">${!open ? 'הסבב נסגר — אין אפשרות לאשר' : ready ? 'כל קציני המטה חתמו' : `${f.total - f.signed_count === 1 ? 'חסרה חתימה אחת' : `חסרות ${f.total - f.signed_count} חתימות`} — האישור ייפתח כשכולם יחתמו`}</span>
    </div>`;
  }
  shell(`
    ${roundBar(round, { admin: true })}
    ${round ? `<div class="split">
      <nav class="co-list" aria-label="פלוגות"><h2>פלוגות · ${forms.filter((x) => x.status === 'approved').length}/${forms.length} אושרו</h2>${list}</nav>
      <section class="panel">${formView(f)}${approve}</section>
    </div>` : ''}`);
  app.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => {
    selected = b.dataset.co; renderAdmin();
    if (matchMedia('(max-width: 760px)').matches) app.querySelector('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  app.querySelector('[data-approve]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api.post('/api/approve', { company: f.company }); toast(`הטופס של ${coName(f.company)} אושר ✓`, 'ok'); }
    catch (ex) { toast(ex.message, 'error'); }
    await refresh();
  });
  app.querySelector('[data-open-round]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'פתיחת סבב חדש', text: 'כל הפלוגות יתחילו ללא חתימות וללא אישור. הסבבים הקודמים נשמרים בהיסטוריה.', confirmLabel: 'פתיחת סבב' }))) return;
    try { await api.post('/api/rounds/open'); toast('נפתח סבב חדש', 'ok'); } catch (ex) { toast(ex.message, 'error'); }
    selected = null; await refresh();
  });
  app.querySelector('[data-close-round]')?.addEventListener('click', async () => {
    const approved = forms.filter((x) => x.status === 'approved').length;
    if (!(await confirmSheet({ title: 'סיום סבב', text: `${approved} מתוך ${forms.length} פלוגות אושרו. לאחר הסיום לא יהיה אפשר לחתום או לאשר בסבב הזה, והוא יישמר לצפייה בהיסטוריה.`, confirmLabel: 'סיום סבב' }))) return;
    try { await api.post('/api/rounds/close'); toast('הסבב נסגר', 'ok'); } catch (ex) { toast(ex.message, 'error'); }
    await refresh();
  });
}

// --- users ---
const kindText = (u) => u.kind === 'officer' ? u.role_label : u.kind === 'company' ? coName(u.company_key) : 'מג״ד';

async function renderUsers() {
  shell('<p class="muted">טוען…</p>');
  const { users } = await api.get('/api/users');
  if (tab !== 'users') return;
  const active = users.filter((u) => u.active);
  const missRoles = meta.roles.filter((r) => !active.some((u) => u.role_key === r.key)).map((r) => r.label);
  const missCos = meta.companies.filter((c) => !active.some((u) => u.company_key === c)).map(coName);
  const miss = [...missRoles, ...missCos];
  const opt = (list, ph) => `<option value="">${ph}</option>` + list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  shell(`
    <div class="cards">
      <form class="panel" novalidate>
        <h2>משתמש חדש</h2>
        <div class="form-error" hidden></div>
        <div class="field"><label for="u-kind">סוג משתמש</label>
          <select id="u-kind" required>${opt(meta.kinds.map((k) => [k.key, k.label]), 'בחרו…')}</select></div>
        <div class="field" data-for="officer" hidden><label for="u-role">תפקיד</label>
          <select id="u-role">${opt(meta.roles.map((r) => [r.key, r.label]), 'בחרו תפקיד…')}</select></div>
        <div class="field" data-for="company" hidden><label for="u-co">פלוגה</label>
          <select id="u-co">${opt(meta.companies.map((c) => [c, coName(c)]), 'בחרו פלוגה…')}</select></div>
        <div class="field"><label for="u-name">שם מלא</label><input id="u-name" type="text" required>
          <span class="hint">מופיע כשם החותם</span></div>
        <div class="grid-2">
          <div class="field"><label for="u-user">שם משתמש</label><input id="u-user" type="text" autocapitalize="off" autocomplete="off" required></div>
          <div class="field"><label for="u-pw">סיסמה</label><input id="u-pw" type="text" autocomplete="off" required><span class="hint">לפחות 8 תווים</span></div>
        </div>
        <button class="btn btn-primary btn-big btn-block" type="submit">יצירת משתמש</button>
      </form>
      <section class="panel">
        <h2>משתמשים (${active.length})</h2>
        ${miss.length ? `<div class="missing"><b>עדיין בלי חשבון:</b> ${miss.map(esc).join(' · ')}</div>` : ''}
        ${users.map((u) => `
          <div class="user-row ${u.active ? '' : 'off'}">
            <div class="u-main"><b>${esc(u.full_name)}</b> <span class="tag">${esc(kindText(u))}</span>
              <div class="muted small"><span class="ltr">${esc(u.username)}</span>${u.active ? '' : ' · מושבת'}</div></div>
            <button class="btn btn-sm" data-reset="${u.id}">איפוס סיסמה</button>
            ${u.id === me.id ? '' : `<button class="btn btn-sm ${u.active ? 'btn-danger' : ''}" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'השבתה' : 'הפעלה'}</button>`}
          </div>`).join('')}
      </section>
    </div>`);
  const form = app.querySelector('form');
  const kindSel = form.querySelector('#u-kind');
  kindSel.addEventListener('change', () => form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== kindSel.value; }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.form-error'); err.hidden = true;
    try {
      const u = (await api.post('/api/users', {
        kind: kindSel.value, role_key: form.querySelector('#u-role').value, company_key: form.querySelector('#u-co').value,
        full_name: form.querySelector('#u-name').value, username: form.querySelector('#u-user').value, password: form.querySelector('#u-pw').value,
      })).user;
      toast(`נוצר משתמש: ${u.full_name} (${kindText(u)})`, 'ok');
      renderUsers();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  app.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const u = users.find((x) => x.id === Number(b.dataset.reset));
    if (!(await confirmSheet({ title: 'איפוס סיסמה', text: `ליצור סיסמה זמנית חדשה ל${u.full_name}? הסיסמה הקודמת תפסיק לעבוד.`, confirmLabel: 'איפוס' }))) return;
    try {
      const { password } = await api.post(`/api/users/${u.id}/reset-password`);
      openSheet({ title: `סיסמה חדשה ל${u.full_name}`, body: `<p>שם משתמש: <b class="ltr">${esc(u.username)}</b></p><p>הסיסמה מוצגת פעם אחת בלבד:</p><p class="temp-pw ltr">${esc(password)}</p>`,
        foot: '<button class="btn btn-primary" data-close>סגירה</button>' });
    } catch (ex) { toast(ex.message, 'error'); }
  }));
  app.querySelectorAll('[data-active]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/api/users/${b.dataset.active}/active`, { active: b.dataset.to === '1' }); renderUsers(); }
    catch (ex) { toast(ex.message, 'error'); }
  }));
}

// --- history ---
async function renderHistory() {
  shell('<p class="muted">טוען…</p>');
  const { rounds } = await api.get('/api/rounds');
  if (tab !== 'history') return;
  shell(`
    <h2>סבבים קודמים</h2>
    ${rounds.length ? rounds.map((r) => `
      <button class="hist-row" data-round="${r.id}">
        <span class="h-main"><b>סבב ${r.number}</b> ${r.status === 'open' ? '<span class="tag">פתוח</span>' : '<span class="tag">🔒 נסגר</span>'}
          <span class="muted small" style="display:block">${esc(fmtStamp(r.opened_at))}${r.closed_at ? ` עד ${esc(fmtStamp(r.closed_at))}` : ''}</span></span>
        <span class="count">${r.approved}/${r.total} אושרו</span>
      </button>`).join('') : '<p class="muted">אין עדיין סבבים.</p>'}`);
  app.querySelectorAll('[data-round]').forEach((b) => b.addEventListener('click', async () => {
    const { round, forms } = await api.get(`/api/rounds/${b.dataset.round}`);
    const head = meta.roles.map((r) => `<th scope="col">${esc(r.label)}</th>`).join('');
    const rows = forms.map((f) => `<tr><th scope="row">${esc(coName(f.company))}</th>
      ${f.roles.map((r) => `<td title="${esc(r.signed ? `${r.signer_name} · ${fmtStamp(r.signed_at)}` : 'טרם חתם')}">${r.signed ? '✓' : '○'}<span class="sr-only">${r.signed ? 'חתם' : 'טרם חתם'}</span></td>`).join('')}
      <td>${f.approval ? `✓ ${esc(f.approval.approver_name)}<div class="muted small">${esc(fmtStamp(f.approval.approved_at))}</div>` : '○ לא אושר'}</td></tr>`).join('');
    openSheet({
      wide: true, title: `סבב ${round.number}${round.status === 'closed' ? ' — נעול לצפייה' : ''}`,
      body: `<p class="muted small">✓ = חתם · ○ = טרם חתם. במחשב, ריחוף על תא מציג את שם החותם והמועד.</p>
        <div class="matrix-wrap"><table class="matrix"><thead><tr><th scope="col">פלוגה</th>${head}<th scope="col">אישור מג״ד</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    });
  }));
}
