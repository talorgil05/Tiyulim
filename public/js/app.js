import { api, setUnauthorizedHandler } from './api.js';
import { esc, fmtStamp, coName, yes, no, toast, confirmSheet, ICONS, addPasswordToggles, busy } from './util.js';
import { renderUsers, renderHistory, renderProfile, kindText } from './views.js';
import { openInstallGuide, offerInstallBar } from './install.js';
import { maybeShowTour } from './onboarding.js';

const app = document.getElementById('app');
let me = null;          // the logged-in user
let meta = null;        // roles + companies + kinds
let state = null;       // /api/state answer
let selected = null;    // chosen company (officer / מג״ד)
let tab = 'round';      // round | profile, and for the מג״ד also users | history
let pendingCount = 0;   // מג״ד: registrations waiting for a permission
let events = null;

setUnauthorizedHandler(() => { me = null; stopEvents(); renderLogin(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- boot ----------
(async function boot() {
  meta = await api.get('/api/meta');
  try { me = (await api.get('/api/auth/me')).user; } catch { me = null; }
  if (me) await enter(); else renderLogin();
})();

const TABS = () => (me.kind === 'admin' ? ['round', 'users', 'history', 'profile']
  : me.can_manage_users ? ['round', 'users', 'profile'] : ['round', 'profile']);
function tabFromHash() {
  const t = location.hash.replace('#/', '') || 'round';
  return TABS().includes(t) ? t : 'round';
}
window.addEventListener('hashchange', () => { if (!me) return; const t = tabFromHash(); if (t !== tab) { tab = t; show(); } });

async function enter() {
  selected = null;
  tab = tabFromHash();
  await show();
  startEvents();
  maybeShowTour(me);
}

const ctx = {
  get user() { return me; },
  get meta() { return meta; },
  setUser(u) { me = u; },
  shell: (html) => shell(html),
  reenter: () => enter(),
};

/** Draw the current tab (fetching what it needs). */
async function show() {
  if (me.can_manage_users) pendingCount = (await api.get('/api/users').catch(() => ({ users: [] }))).users.filter((u) => u.kind === 'pending' && u.active).length;
  if (tab === 'profile') return renderProfile(ctx);
  if (tab === 'users') return renderUsers(ctx);
  if (tab === 'history') return renderHistory(ctx);
  return refresh();
}

async function refresh() {
  state = await api.get('/api/state');
  render();
}

/**
 * Live updates: any signature / approval / round / user change. My own account is re-read too, so a
 * pending user's screen switches the moment the מג״ד gives a permission (and a removed one, back).
 */
function startEvents() {
  stopEvents();
  events = new EventSource('/api/events');
  events.addEventListener('change', async () => {
    if (!me) return;
    let fresh;
    try { fresh = (await api.get('/api/auth/me')).user; } catch { return; }
    const kindChanged = fresh.kind !== me.kind || fresh.role_key !== me.role_key || fresh.company_key !== me.company_key;
    me = fresh;
    if (kindChanged) {
      toast(me.kind === 'pending' ? 'ההרשאה שלך הוסרה' : `קיבלת הרשאה: ${kindText(me)}`, 'ok');
      return enter();
    }
    if (tab === 'round') return show().catch(() => {});   // also updates the מג״ד's "pending" badge
    if (tab === 'users' && !document.querySelector('dialog[open]')) return renderUsers(ctx);
  });
}
function stopEvents() { events?.close(); events = null; }
// a phone coming back from the background: catch up
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me && tab === 'round') refresh().catch(() => {}); });

// ---------- login / register (like תיאומון: full name is the login name) ----------
async function renderLogin(mode = 'login') {
  app.removeAttribute('aria-busy');
  const setupOpen = (await api.get('/api/setup/status').catch(() => ({ open: false }))).open;
  const reg = mode === 'register';
  app.innerHTML = `
    <div class="landing" id="main">
      <img class="landing-logo" src="/icons/logo.svg" alt="">
      <h1>טופס טיולים גדודי</h1>
      <p class="landing-tag">חתימות קציני מטה לפני יציאה הביתה</p>
      <div class="auth-card">
        <div class="auth-tabs" role="tablist">
          <button type="button" role="tab" class="auth-tab" aria-selected="${!reg}" data-go="login">${ICONS.login}<span>כניסה</span></button>
          <button type="button" role="tab" class="auth-tab" aria-selected="${reg}" data-go="register">${ICONS.plus}<span>משתמש חדש</span></button>
        </div>
        <form novalidate>
          <div class="form-error" hidden></div>
          <div class="field"><label for="f-name">שם מלא</label>
            <input id="f-name" name="full_name" type="text" autocomplete="${reg ? 'name' : 'username'}" required>
            ${reg ? '<span class="hint">השם המלא הוא גם שם הכניסה שלך</span>' : ''}</div>
          ${reg ? `<div class="field"><label for="f-phone">טלפון</label>
            <input id="f-phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="12" placeholder="05XXXXXXXX" required>
            <span class="hint">10 ספרות</span></div>` : ''}
          <div class="field"><label for="f-pw">סיסמה</label>
            <input id="f-pw" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
            ${reg ? '<span class="hint">לפחות 8 תווים</span>' : ''}</div>
          ${reg ? `<div class="field"><label for="f-pw2">אימות סיסמה</label>
            <input id="f-pw2" name="password2" type="password" autocomplete="new-password" required></div>` : ''}
          ${reg && setupOpen ? `<details class="field"><summary class="small muted">יש לי קוד הקמה (מג״ד ראשון)</summary>
            <input id="f-code" name="setup_code" type="password" autocomplete="off" aria-label="קוד הקמה" style="margin-top:.5rem"></details>` : ''}
          <button class="btn btn-primary btn-big btn-block" type="submit">${reg ? 'הרשמה' : 'כניסה'}</button>
          ${reg ? '<p class="small muted" style="margin:.7rem 0 0;text-align:center">אחרי ההרשמה המג״ד ישייך אותך לתפקיד או לפלוגה.</p>' : ''}
        </form>
      </div>
      <div class="landing-links">
        <a class="landing-link" href="/help/">${ICONS.help} עזרה</a>
        <button type="button" class="landing-link" data-install-guide>${ICONS.phone} הוספה למסך הבית</button>
      </div>
    </div>`;
  const form = app.querySelector('form');
  const err = form.querySelector('.form-error');
  const showErr = (m) => { err.textContent = m; err.hidden = false; err.setAttribute('role', 'alert'); };
  addPasswordToggles(form);
  app.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => renderLogin(b.dataset.go)));
  app.querySelector('[data-install-guide]').addEventListener('click', openInstallGuide);
  form.querySelector('#f-name').focus();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.hidden = true;
    const fd = Object.fromEntries(new FormData(form));
    if (reg) {
      fd.phone = (fd.phone || '').replace(/[\s-]/g, '');
      if ((fd.full_name || '').trim().length < 2) return showErr('יש למלא שם מלא');
      if (!/^\d{10}$/.test(fd.phone)) return showErr('מספר טלפון חייב להכיל בדיוק 10 ספרות');
      if ((fd.password || '').length < 8) return showErr('סיסמה חייבת להכיל לפחות 8 תווים');
      if (fd.password !== fd.password2) return showErr('הסיסמאות אינן תואמות');
      delete fd.password2;
    }
    return busy(form.querySelector('[type=submit]'), async () => {
      try {
        me = (await api.post(reg ? '/api/auth/register' : '/api/auth/login', fd)).user;
        location.hash = '';
        await enter();
        if (!reg) offerInstallBar();
      } catch (ex) { showErr(ex.message); }
    });
  });
}

// ---------- shell ----------
function shell(content) {
  const sub = kindText(me);
  const tabList = me.kind === 'admin' ? [['round', 'סבב נוכחי'], ['users', 'משתמשים'], ['history', 'היסטוריה']]
    : me.can_manage_users ? [['round', 'חתימות'], ['users', 'משתמשים']] : null;
  const tabs = tabList ? `
    <nav class="tabs" aria-label="מסכים">
      ${tabList.map(([k, l]) =>
        `<button class="tab" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}>${l}${k === 'users' && pendingCount ? `<span class="badge" aria-label="${pendingCount} ממתינים">${pendingCount}</span>` : ''}</button>`).join('')}
    </nav>` : '';
  const noPhone = !me.phone && tab !== 'profile'
    ? '<div class="notice info">📱 חסר מספר טלפון בחשבון שלך. <a href="#/profile">להוספה בפרופיל</a></div>' : '';
  app.removeAttribute('aria-busy');
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/round" style="color:inherit;text-decoration:none"><img src="/icons/logo.svg" alt=""><span>טופס טיולים גדודי</span></a>
        <div class="spacer"></div>
        <a class="top-link" href="/help/" aria-label="עזרה">${ICONS.help}<span>עזרה</span></a>
        <a class="who" href="#/profile" title="הפרופיל שלי"><b>${esc(me.full_name)}</b><span>${esc(sub)}</span></a>
        <a class="top-link" href="#/profile" aria-label="הפרופיל שלי" ${tab === 'profile' ? 'aria-current="page"' : ''}>${ICONS.user}<span>פרופיל</span></a>
        <button class="top-link" data-logout aria-label="יציאה" style="cursor:pointer">${ICONS.logout}<span>יציאה</span></button>
      </header>
      ${tabs}
      <main id="main">${noPhone}${content}</main>
    </div>`;
  app.querySelector('[data-logout]').addEventListener('click', async () => {
    await api.post('/api/auth/logout').catch(() => {});
    me = null; stopEvents(); location.hash = ''; renderLogin();
  });
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/${b.dataset.tab}`; }));
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
  if (state?.pending || me.kind === 'pending') return renderPending();
  if (me.kind === 'officer') return renderOfficer();
  if (me.kind === 'company') return renderCompany();
  return renderAdmin();
}

// ---------- registered, waiting for the מג״ד ----------
function renderPending() {
  shell(`
    <div class="center-card">
      <section class="panel pending-hero">
        <div class="big-mark" aria-hidden="true">⏳</div>
        <h1 style="color:var(--navy)">נרשמת בהצלחה</h1>
        <p><b>ממתין לשיוך על ידי המג״ד.</b><br>ברגע שהמג״ד ישייך אותך לתפקיד או לפלוגה, המסך הזה יתחלף לבד — אין צורך לרענן.</p>
        <dl class="kv" style="text-align:start;max-width:320px;margin:1rem auto 0">
          <dt>שם</dt><dd>${esc(me.full_name)}</dd>
          <dt>טלפון</dt><dd class="ltr">${esc(me.phone || '—')}</dd>
        </dl>
      </section>
      <section class="panel">
        <h2>בינתיים</h2>
        <div class="btn-row">
          <button class="btn" data-install-guide>${ICONS.phone} הוספה למסך הבית</button>
          <a class="btn" href="#/profile">${ICONS.user} עדכון פרטים</a>
          <a class="btn" href="/help/">${ICONS.help} עזרה</a>
        </div>
      </section>
    </div>`);
  app.querySelector('[data-install-guide]').addEventListener('click', openInstallGuide);
}

// ---------- staff officer: pick a company, sign the rows of my area ----------
const partial = (n, total) => `<span class="mark wait" aria-hidden="true">…</span><span class="st-wait">${n}/${total}</span>`;
const officerStatus = (c) => !c.applies ? '<span class="st-no">לא רלוונטי</span>'
  : c.done ? yes('חתמתי') : c.signed_count ? partial(c.signed_count, c.total) : no('טרם חתמתי');

function renderOfficer() {
  const { round, companies } = state;
  const open = round?.status === 'open';
  if (!selected || !companies.some((c) => c.company === selected)) {
    selected = (companies.find((c) => c.applies && !c.done) || companies.find((c) => c.applies) || companies[0]).company;
  }
  const cur = companies.find((c) => c.company === selected);
  const list = companies.map((c) => `
    <button class="co ${c.applies ? '' : 'na'}" data-co="${esc(c.company)}" aria-current="${c.company === selected}">
      <span class="co-name">${esc(coName(c.company))}</span>
      <span class="co-st">${officerStatus(c)}</span>
    </button>`).join('');
  let body;
  if (!cur.applies) {
    body = `<p class="muted">התחום <b>${esc(me.role_label)}</b> לא רלוונטי ל${esc(coName(cur.company))}. אין כאן מה לחתום.</p>`;
  } else {
    const rows = cur.items.map((it) => `
      <li class="item-row ${it.signed ? 'signed' : ''}">
        <span class="item-name">${esc(it.label)}</span>
        ${it.signed
          ? `<span class="item-st">${yes('חתום')}<span class="role-by">${esc(it.signer_name)} · ${esc(fmtStamp(it.signed_at))}</span></span>`
          : `<button class="btn btn-sm btn-primary item-btn" data-item="${esc(it.key)}" ${open ? '' : 'disabled'}>חתום</button>`}
      </li>`).join('');
    const left = cur.total - cur.signed_count;
    const label = left === cur.total ? 'חתימה על כל השורות' : left === 1 ? 'חתימה על השורה שנשארה' : `חתימה על ${left} השורות שנשארו`;
    const all = cur.done
      ? '<button class="btn-sign done" disabled>חתמתי על הכל ✓</button>'
      : `<button class="btn-sign" data-sign-all ${open ? '' : 'disabled'}>${label}</button>`;
    body = `
      <p class="sign-count">${cur.signed_count}/${cur.total} שורות נחתמו</p>
      <ul class="item-list">${rows}</ul>
      <div class="sign-all">${all}${open ? '' : '<p class="sign-meta">אין סבב פתוח. החתימה תתאפשר כשהמג״ד יפתח סבב</p>'}</div>`;
  }
  shell(`
    ${round && open ? '' : roundBar(round)}
    <div class="split">
      <nav class="co-list" aria-label="פלוגות"><h2>פלוגות${round ? ` · סבב ${round.number}` : ''}</h2>${list}</nav>
      <section class="panel sign-panel" aria-live="polite">
        <h1 class="sign-co">${esc(coName(cur.company))}</h1>
        <p class="sign-role">חותם/ת בתור: <b>${esc(me.role_label)}</b></p>
        ${body}
      </section>
    </div>`);
  app.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => {
    selected = b.dataset.co; renderOfficer();
    if (matchMedia('(max-width: 760px)').matches) app.querySelector('.sign-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const sign = async (btn, extra, okText) => {
    btn.disabled = true;
    try { await api.post('/api/sign', { company: cur.company, ...extra }); toast(okText, 'ok'); offerInstallBar(); }
    catch (ex) { toast(ex.message, 'error'); }
    await refresh();
  };
  app.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => sign(b, { item: b.dataset.item }, 'נחתם ✓')));
  app.querySelector('[data-sign-all]')?.addEventListener('click', (e) => sign(e.currentTarget, {}, `כל השורות שלך ל${coName(cur.company)} נחתמו ✓`));
}

// ---------- company form (read-only): by area, each row its own signature ----------
const FINAL_TEXT = {
  awaiting_signatures: 'ממתינים לחתימות קציני המטה',
  awaiting_approval: 'כל קציני המטה חתמו — ממתינים לאישור מג״ד',
  approved: 'הטופס אושר על ידי המג״ד',
};
function formView(f, { openRound = false } = {}) {
  const areas = f.areas.map((a) => {
    const st = a.legacy && !a.signed_count
      ? `${yes('נחתם')} <span class="role-by">${esc(a.legacy.signer_name)} · ${esc(fmtStamp(a.legacy.signed_at))} (גרסה קודמת)</span>`
      : a.done ? yes('הושלם') : a.signed_count ? partial(a.signed_count, a.total) : no(`0/${a.total}`);
    const rows = a.items.map((it) => `
      <li class="item-row ${it.signed ? 'signed' : ''}">
        <span class="item-name">${esc(it.label)}</span>
        <span class="item-st">${it.signed ? `${yes('חתם')}<span class="role-by">${esc(it.signer_name)} · ${esc(fmtStamp(it.signed_at))}</span>` : no('טרם חתם')}</span>
      </li>`).join('');
    return `<details class="area ${a.done ? 'done' : ''}" ${openRound && !a.done && a.signed_count ? 'open' : ''}>
      <summary><span class="area-name">${esc(a.label)}</span><span class="area-st">${st}</span></summary>
      <ul class="item-list">${rows}</ul></details>`;
  }).join('');
  const markFinal = f.status === 'approved' ? '<span class="mark yes" aria-hidden="true">✓</span>'
    : '<span class="mark wait" aria-hidden="true">…</span>';
  return `
    <div class="form-head"><h1>${esc(coName(f.company))}</h1>
      <span class="count">${f.areas_done}/${f.areas_total} תחומים · ${f.signed_count}/${f.total} שורות</span></div>
    <p class="small muted" style="margin-top:-.4rem">לחיצה על תחום מציגה את השורות שלו, מי חתם ומתי.</p>
    <div class="areas">${areas}</div>
    <div class="final ${f.status}" role="status">${markFinal}<div>אישור מג״ד: ${FINAL_TEXT[f.status]}
      ${f.approval ? `<small>אושר על ידי ${esc(f.approval.approver_name)} · ${esc(fmtStamp(f.approval.approved_at))}</small>` : ''}</div></div>`;
}

function renderCompany() {
  const { round, form } = state;
  shell(`${roundBar(round)}<section class="panel">${round ? formView(form, { openRound: round.status === 'open' }) : `<div class="form-head"><h1>${esc(coName(me.company_key))}</h1></div><p class="muted">הטופס יופיע כשהמג״ד יפתח סבב.</p>`}</section>`);
}

// ---------- מג״ד ----------
const coStatus = (f) => f.status === 'approved' ? yes('אושר')
  : f.status === 'awaiting_approval' ? '<span class="mark wait" aria-hidden="true">!</span><span class="st-wait">לאישורך</span>'
  : `<span class="mark no" aria-hidden="true"></span><span class="st-no">${f.areas_done}/${f.areas_total}</span>`;

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
      <span class="muted small">${!open ? 'הסבב נסגר — אין אפשרות לאשר' : ready ? 'כל השורות נחתמו' : `${f.total - f.signed_count === 1 ? 'חסרה שורה אחת' : `חסרות ${f.total - f.signed_count} שורות`} — האישור ייפתח כשכל השורות ייחתמו`}</span>
    </div>`;
  }
  shell(`
    ${roundBar(round, { admin: true })}
    ${round ? `<div class="split">
      <nav class="co-list" aria-label="פלוגות"><h2>פלוגות · ${forms.filter((x) => x.status === 'approved').length}/${forms.length} אושרו</h2>${list}</nav>
      <section class="panel">${formView(f, { openRound: open })}${approve}</section>
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

