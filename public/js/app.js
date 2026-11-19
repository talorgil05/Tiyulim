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
  if (me) await enter(); else await renderLogin();
  hideSplash();
})().catch(() => hideSplash());

/**
 * Opening animation.
 *  - The pen follows the signature exactly: every frame it is placed at the point the signature has reached
 *    (read from the signature's own draw animation), so the two never drift apart, however late it starts.
 *  - It closes when its last step (the pen lifting) has finished AND the app is ready — or at once on a tap.
 */
const splash = document.getElementById('splash');
let splashAnimDone = false, appReady = false;
function closeSplash() {
  if (!splash?.isConnected || splash.classList.contains('out')) return;
  splash.classList.add('out');
  setTimeout(() => splash.remove(), 400);
}
function hideSplash() {
  appReady = true;
  if (!splash) return;
  if (document.documentElement.classList.contains('no-splash') || matchMedia('(prefers-reduced-motion: reduce)').matches) { splash.remove(); return; }
  if (splashAnimDone) setTimeout(closeSplash, 250);
}
if (splash && !document.documentElement.classList.contains('no-splash') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const sig = splash.querySelector('.sp-sig');
  const pen = splash.querySelector('.sp-pen');
  const total = sig.getTotalLength();
  const follow = () => {
    if (!splash.isConnected) return;
    const left = parseFloat(getComputedStyle(sig).strokeDashoffset) || 0;   // 1 → 0 while it draws
    const pt = sig.getPointAtLength(Math.min(1, Math.max(0, 1 - left)) * total);
    pen.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
    requestAnimationFrame(follow);
  };
  follow();
  splash.querySelector('.sp-lift').addEventListener('animationend', () => {
    splashAnimDone = true;
    if (appReady) setTimeout(closeSplash, 250);
  });
  setTimeout(() => { splashAnimDone = true; if (appReady) closeSplash(); }, 6000);   // safety net
  splash.addEventListener('click', closeSplash);
}

// An officer gets one "חתימות <area>" tab per area he holds (e.g. חתימות תקשוב, חתימות הדרכה).
const signTabs = () => (me.kind === 'officer' ? (me.role_keys || []).map((k) => `sign-${k}`) : []);
const TABS = () => (me.kind === 'admin' ? ['round', 'users', 'history', 'profile']
  : me.kind === 'officer' ? [...signTabs(), ...(me.can_manage_users ? ['users'] : []), 'profile'] : ['round', 'profile']);
const homeTab = () => (me.kind === 'officer' && signTabs().length ? signTabs()[0] : 'round');
const isRoundTab = (t) => t === 'round' || t.startsWith('sign-');
let officerWeek = null;   // officer: a past week the מג״ד reopened, chosen above the company list (null = this week)
let editData = null;      // מג״ד: the past week being edited
function tabFromHash() {
  const t = location.hash.replace('#/', '') || homeTab();
  if (me.kind === 'admin' && /^edit-\d+$/.test(t)) return t;
  return TABS().includes(t) ? t : homeTab();
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
  if (tab.startsWith('edit-')) return renderEdit(Number(tab.slice(5)));
  return refresh();
}
const roleLabel = (k) => meta.roles.find((r) => r.key === k)?.label || k;

async function refresh() {
  state = await api.get(`/api/state${me.kind === 'officer' && officerWeek ? `?round=${officerWeek}` : ''}`);
  if (officerWeek && state.round?.id !== officerWeek) officerWeek = null;   // that week was locked again
  render();
}

/**
 * Live updates by polling (works on serverless hosting): every 10 seconds, while the screen is visible, ask
 * the server for its change counter, and reload only when it moved. My own account is re-read too, so a
 * pending user's screen switches soon after the מג״ד gives a permission (and a removed one, back).
 */
// Every 15 s while someone is using the screen; once a minute after 5 minutes without a touch/click/key, so a
// screen left open all day stays well inside the free hosting quota.
const POLL_MS = 15000, IDLE_POLL_MS = 60000, IDLE_AFTER_MS = 5 * 60000;
let lastVersion = null, lastActive = Date.now(), lastPoll = 0;
for (const ev of ['pointerdown', 'keydown', 'scroll']) {
  window.addEventListener(ev, () => {
    const wasIdle = Date.now() - lastActive > IDLE_AFTER_MS;
    lastActive = Date.now();
    if (wasIdle && me) poll(true);   // back from idle: catch up at once
  }, { passive: true, capture: true });
}
async function poll(force = false) {
  if (!me || document.visibilityState !== 'visible') return;
  const idle = Date.now() - lastActive > IDLE_AFTER_MS;
  if (!force && idle && Date.now() - lastPoll < IDLE_POLL_MS) return;
  lastPoll = Date.now();
  let v;
  try { v = (await api.get('/api/version')).version; } catch { return; }
  if (lastVersion === null) { lastVersion = v; return; }
  if (v === lastVersion) return;
  lastVersion = v;
  await onChange();
}
function startEvents() {
  stopEvents();
  lastVersion = null;
  poll(true);
  events = setInterval(() => poll(), POLL_MS);
}
async function onChange() {
  {
    if (!me) return;
    let fresh;
    try { fresh = (await api.get('/api/auth/me')).user; } catch { return; }
    const kindChanged = fresh.kind !== me.kind || (fresh.role_keys || []).join() !== (me.role_keys || []).join() || fresh.company_key !== me.company_key;
    me = fresh;
    if (kindChanged) {
      toast(me.kind === 'pending' ? 'ההרשאה שלך הוסרה' : `קיבלת הרשאה: ${kindText(me)}`, 'ok');
      return enter();
    }
    if (isRoundTab(tab)) return show().catch(() => {});   // also updates the "pending" badge
    if (tab === 'users' && !document.querySelector('dialog[open]')) return renderUsers(ctx);
    if (tab.startsWith('edit-')) return renderEdit(Number(tab.slice(5)));
  }
}
function stopEvents() { if (events) clearInterval(events); events = null; }
// a phone coming back from the background: catch up at once
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && me) { lastActive = Date.now(); poll(true); } });

// ---------- login / register (like תיאומון: full name is the login name) ----------
async function renderLogin(mode = 'login') {
  app.removeAttribute('aria-busy');
  const setupOpen = (await api.get('/api/setup/status').catch(() => ({ open: false }))).open;
  const reg = mode === 'register';
  app.innerHTML = `
    <div class="landing" id="main">
      <img class="landing-logo" src="/icons/logo.png" alt="">
      <h1>טופס טיולים</h1>
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
  const tabList = me.kind === 'admin' ? [['round', 'השבוע'], ['users', 'משתמשים'], ['history', 'היסטוריה']]
    : me.kind === 'officer' ? [...(me.role_keys || []).map((k) => [`sign-${k}`, `חתימות ${roleLabel(k)}`]), ...(me.can_manage_users ? [['users', 'משתמשים']] : [])]
    : null;
  const tabs = tabList ? `
    <nav class="tabs" aria-label="מסכים">
      ${tabList.map(([k, l]) =>
        `<button class="tab" data-tab="${k}" ${tab === k || (k === 'history' && tab.startsWith('edit-')) ? 'aria-current="page"' : ''}>${l}${k === 'users' && pendingCount ? `<span class="badge" aria-label="${pendingCount} ממתינים">${pendingCount}</span>` : ''}</button>`).join('')}
    </nav>` : '';
  const noPhone = !me.phone && tab !== 'profile'
    ? '<div class="notice info">📱 חסר מספר טלפון בחשבון שלך. <a href="#/profile">להוספה בפרופיל</a></div>' : '';
  app.removeAttribute('aria-busy');
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/round" style="color:inherit;text-decoration:none"><img src="/icons/logo.png" alt=""><span>טופס טיולים</span></a>
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

/** "שבוע 47" (or "סבב 3" for forms from before the weekly forms). */
const weekName = (r) => (r?.week ? `שבוע ${r.week}` : `סבב ${r?.number ?? ''}`);
const dm = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)}.${Number(m)}`; };
const weekDates = (r) => (r?.starts_on ? `${dm(r.starts_on)}–${dm(r.ends_on)}.${r.ends_on.slice(0, 4)}` : '');

/** Header of the weekly form. It opens by itself every Monday at 00:00 and closes when the week ends. */
function roundBar(round) {
  if (!round) return '<div class="notice">○ הטופס של השבוע נטען…</div>';
  const open = round.status === 'open';
  const text = open
    ? `<b>טופס ${esc(weekName(round))}</b> <span class="muted">· ${esc(weekDates(round))}</span>
       <div class="muted small">נפתח אוטומטית בכל יום שני ב־00:00 ומתאפס בסוף השבוע</div>`
    : `<b>${esc(weekName(round))} — נסגר 🔒</b> <span class="muted">${esc(weekDates(round))}</span>
       <div class="muted small">החתימות נעולות לצפייה</div>`;
  return `<div class="round-bar"><div class="rb-text">${text}</div></div>`;
}

function render() {
  if (state?.pending || me.kind === 'pending') return renderPending();
  if (me.kind === 'officer') return renderOfficer(tab.startsWith('sign-') ? tab.slice(5) : me.role_keys?.[0]);
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

function renderOfficer(areaKey) {
  const { round } = state;
  const area = state.areas?.find((a) => a.key === areaKey) || state.areas?.[0];
  if (!area) return renderPending();
  const { companies } = area;
  const open = round?.status === 'open' || !!round?.reopened;
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
    body = `<p class="muted">התחום <b>${esc(area.label)}</b> לא רלוונטי ל${esc(coName(cur.company))}. אין כאן מה לחתום.</p>`;
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
      <div class="sign-all">${all}${open ? '' : '<p class="sign-meta">הטופס של השבוע הזה נסגר. טופס חדש ייפתח ביום שני ב־00:00</p>'}</div>`;
  }
  const weeks = state.weeks || [];
  const chooser = weeks.length > 1 ? `<div class="week-pick" role="tablist" aria-label="באיזה שבוע לחתום">${weeks.map((w) => `
      <button type="button" role="tab" class="week-tab ${w.status === 'open' ? '' : 'late'}" data-week="${w.id}" aria-selected="${w.id === round.id}">
        ${w.status === 'open' ? `השבוע · ${esc(weekName(w))}` : `${esc(weekName(w))} · פתוח לחתימה מאוחרת`}</button>`).join('')}</div>` : '';
  const lateNote = round?.reopened ? `<div class="notice">✍️ את/ה חותם/ת עכשיו ב<b>${esc(weekName(round))}</b>${round.starts_on ? ` (${esc(weekDates(round))})` : ''} — שבוע קודם שהמג״ד פתח לחתימה מאוחרת.</div>` : '';
  shell(`
    ${round && open ? '' : roundBar(round)}
    ${chooser}${lateNote}
    <div class="split">
      <nav class="co-list" aria-label="פלוגות"><h2>פלוגות${round ? ` · ${esc(weekName(round))}` : ''}</h2>${list}</nav>
      <section class="panel sign-panel" aria-live="polite">
        <h1 class="sign-co">${esc(coName(cur.company))}</h1>
        <p class="sign-role">חותם/ת בתור: <b>${esc(area.label)}</b></p>
        ${body}
      </section>
    </div>`);
  app.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => {
    selected = b.dataset.co; renderOfficer(area.key);
    if (matchMedia('(max-width: 760px)').matches) app.querySelector('.sign-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  app.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.week);
    officerWeek = weeks.find((w) => w.id === id)?.status === 'open' ? null : id;
    refresh().catch((ex) => toast(ex.message, 'error'));
  }));
  const sign = async (btn, extra, okText) => {
    btn.disabled = true;
    try {
      const r = await api.post('/api/sign', { company: cur.company, ...extra, ...(officerWeek ? { round_id: officerWeek } : {}) });
      showUndo(cur.company, r.items, r.undo_seconds || 10, okText, officerWeek);
      offerInstallBar();
    }
    catch (ex) { toast(ex.message, 'error'); }
    await refresh();
  };
  app.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => sign(b, { item: b.dataset.item }, 'נחתם ✓')));
  app.querySelector('[data-sign-all]')?.addEventListener('click', (e) => sign(e.currentTarget, { role: area.key }, `כל השורות שלך ל${coName(cur.company)} נחתמו ✓`));
}

// ---------- company form (read-only): by area, each row its own signature ----------
const FINAL_TEXT = {
  awaiting_signatures: 'ממתינים לחתימות קציני המטה',
  awaiting_approval: 'כל קציני המטה חתמו — ממתינים לאישור מג״ד',
  approved: 'הטופס אושר על ידי המג״ד',
};
function formView(f, { openRound = false, round = null, edit = false } = {}) {
  const areas = f.areas.map((a) => {
    const st = a.legacy && !a.signed_count
      ? `${yes('נחתם')} <span class="role-by">${esc(a.legacy.signer_name)} · ${esc(fmtStamp(a.legacy.signed_at))} (גרסה קודמת)</span>`
      : a.done ? yes('הושלם') : a.signed_count ? partial(a.signed_count, a.total) : no(`0/${a.total}`);
    const rows = a.items.map((it) => `
      <li class="item-row ${it.signed ? 'signed' : ''}">
        <span class="item-name">${esc(it.label)}</span>
        <span class="item-st">${it.signed
          ? `${yes(it.by_admin ? 'סומן ע״י המג״ד' : 'חתם')}<span class="role-by">${esc(it.signer_name)} · ${esc(fmtStamp(it.signed_at))}</span>`
          : no('טרם חתם')}</span>
        ${edit && !it.signed ? `<button type="button" class="btn btn-sm no-print" data-mark="${esc(it.key)}">סמן כחתום</button>` : ''}
        ${edit && it.by_admin && f.status !== 'approved' ? `<button type="button" class="btn btn-sm btn-ghost no-print" data-unmark="${esc(it.key)}">בטל סימון</button>` : ''}
      </li>`).join('');
    return `<details class="area ${a.done ? 'done' : ''}" data-area="${esc(a.key)}" ${(openRound && !a.done && a.signed_count) || (edit && openAreas.has(a.key)) ? 'open' : ''}>
      <summary><span class="area-name">${esc(a.label)}</span><span class="area-st">${st}</span></summary>
      <ul class="item-list">${rows}</ul></details>`;
  }).join('');
  const markFinal = f.status === 'approved' ? '<span class="mark yes" aria-hidden="true">✓</span>'
    : '<span class="mark wait" aria-hidden="true">…</span>';
  return `
    <div class="print-head">
      <img src="/icons/logo.png" alt="">
      <div><b>טופס טיולים — ${esc(coName(f.company))}</b>
        <span>${round ? `${esc(weekName(round))}${round.starts_on ? ` · ${esc(weekDates(round))}` : ''}` : ''}</span>
        <span>הודפס: ${esc(fmtStamp(new Date().toISOString()))}</span></div>
    </div>
    <div class="form-head"><h1>${esc(coName(f.company))}</h1>
      <button type="button" class="btn btn-sm no-print" data-pdf data-company="${esc(f.company)}" data-name="${esc(`טופס טיולים - ${coName(f.company)}${round ? ` - ${weekName(round)}` : ''}`)}">⬇ הורדת PDF</button>
      <span class="count">${f.areas_done}/${f.areas_total} תחומים · ${f.signed_count}/${f.total} שורות</span></div>
    <p class="small muted" style="margin-top:-.4rem">לחיצה על תחום מציגה את השורות שלו, מי חתם ומתי.</p>
    <div class="areas">${areas}</div>
    <div class="final ${f.status}" role="status">${markFinal}<div>אישור מג״ד: ${FINAL_TEXT[f.status]}
      ${f.approval ? `<small>אושר על ידי ${esc(f.approval.approver_name)} · ${esc(fmtStamp(f.approval.approved_at))}</small>` : ''}</div></div>`;
}

/** "הורדת PDF": draws the form on A4 pages and downloads the file (see /js/pdf.js). */
async function downloadPdf(btn) {
  if (btn.disabled) return;
  const src = tab.startsWith('edit-') && editData ? editData : state;
  const form = src?.form?.company === btn.dataset.company ? src.form : src?.forms?.find((x) => x.company === btn.dataset.company);
  if (!form) return;
  btn.disabled = true;
  const overlay = document.createElement('div');
  overlay.className = 'pdf-overlay';
  overlay.setAttribute('role', 'status');
  overlay.innerHTML = '<div><span class="pdf-spin" aria-hidden="true"></span><b>מכין את קובץ ה־PDF…</b></div>';
  document.body.append(overlay);
  try {
    const { downloadFormPdf } = await import('./pdf.js');
    await downloadFormPdf({ form, round: src.round, title: coName(form.company), filename: btn.dataset.name || 'טופס טיולים' });
    toast('קובץ ה־PDF הורד ✓', 'ok');
  } catch (ex) {
    toast(ex.message || 'יצירת ה־PDF נכשלה. נסו שוב', 'error');
  } finally {
    overlay.remove();
    if (btn.isConnected) btn.disabled = false;
  }
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-pdf]'); if (b) downloadPdf(b); });

function renderCompany() {
  const { round, form } = state;
  shell(`${roundBar(round)}<section class="panel">${round ? formView(form, { openRound: round.status === 'open', round }) : `<div class="form-head"><h1>${esc(coName(me.company_key))}</h1></div><p class="muted">הטופס של השבוע נטען…</p>`}</section>`);
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
  const approve = round ? approveBox(f) : '';
  shell(`
    ${roundBar(round)}
    ${round ? `<div class="split">
      <nav class="co-list" aria-label="פלוגות"><h2>פלוגות · ${forms.filter((x) => x.status === 'approved').length}/${forms.length} אושרו</h2>${list}</nav>
      <section class="panel">${formView(f, { openRound: open, round })}${approve}</section>
    </div>` : ''}`);
  app.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => {
    selected = b.dataset.co; renderAdmin();
    if (matchMedia('(max-width: 760px)').matches) app.querySelector('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  wireApprove(f, null, refresh);
}

/** Final approval, or cancelling it (any week). */
function approveBox(f) {
  if (f.status === 'approved') {
    return `<div class="approve-box"><button type="button" class="btn btn-danger" data-unapprove>ביטול האישור</button></div>`;
  }
  const ready = f.status === 'awaiting_approval';
  return `<div class="approve-box">
    <button class="btn-sign" data-approve ${ready ? '' : 'disabled'}>אישור סופי לטופס</button>
    <span class="muted small">${ready ? 'כל השורות נחתמו' : `${f.total - f.signed_count === 1 ? 'חסרה שורה אחת' : `חסרות ${f.total - f.signed_count} שורות`} — האישור ייפתח כשכל השורות ייחתמו`}</span>
  </div>`;
}
function wireApprove(f, roundId, reload) {
  const extra = roundId ? { round_id: roundId } : {};
  app.querySelector('[data-approve]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try { await api.post('/api/approve', { company: f.company, ...extra }); toast(`הטופס של ${coName(f.company)} אושר ✓`, 'ok'); }
    catch (ex) { toast(ex.message, 'error'); }
    await reload();
  });
  app.querySelector('[data-unapprove]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: 'ביטול האישור', text: `לבטל את האישור הסופי של ${coName(f.company)}? אפשר לאשר שוב אחר כך.`, confirmLabel: 'ביטול האישור' }))) return;
    try { await api.post('/api/approve/cancel', { company: f.company, ...extra }); toast('האישור בוטל', 'ok'); }
    catch (ex) { toast(ex.message, 'error'); }
    await reload();
  });
}

// ---------- מג״ד: editing a past week (history → עריכה) ----------
let openAreas = new Set();   // areas left open while editing, kept across reloads
async function renderEdit(id) {
  let data;
  try { data = await api.get(`/api/rounds/${id}`); } catch (ex) { toast(ex.message, 'error'); location.hash = '#/history'; return; }
  if (tab !== `edit-${id}`) return;
  editData = data;
  const { round, forms } = data;
  if (!selected || !forms.some((x) => x.company === selected)) selected = forms[0].company;
  const f = forms.find((x) => x.company === selected);
  const list = forms.map((x) => `
    <button class="co" data-co="${esc(x.company)}" aria-current="${x.company === selected}">
      <span class="co-name">${esc(coName(x.company))}</span><span class="co-st">${coStatus(x)}</span>
    </button>`).join('');
  const current = round.status === 'open';
  const state_ = current ? '<span class="tag">השבוע הנוכחי</span>' : round.reopened ? '<span class="tag pend">פתוח לחתימה מאוחרת</span>' : '<span class="tag">🔒 נעול לקציני המטה</span>';
  const reopenBtn = current ? '' : round.reopened
    ? '<button type="button" class="btn btn-big" data-lock>🔒 נעילה</button>'
    : '<button type="button" class="btn btn-primary btn-big" data-reopen>פתיחה לקציני המטה</button>';
  shell(`
    <div class="round-bar edit-bar">
      <div class="rb-text"><b>עריכת ${esc(weekName(round))}</b> ${state_} <span class="muted">${esc(weekDates(round))}</span>
        <div class="muted small">סמנו שורות חסרות בשמכם, אשרו או בטלו אישור${current ? '' : ', או פתחו את השבוע כדי שקציני המטה יחתמו בו באיחור'}. חתימות של קציני מטה אי אפשר למחוק.</div></div>
      ${reopenBtn}
      <a class="btn" href="#/history">חזרה להיסטוריה</a>
    </div>
    <div class="split">
      <nav class="co-list" aria-label="פלוגות"><h2>פלוגות · ${forms.filter((x) => x.status === 'approved').length}/${forms.length} אושרו</h2>${list}</nav>
      <section class="panel">${formView(f, { round, edit: true })}${approveBox(f)}</section>
    </div>`);
  const reload = () => renderEdit(id);
  app.querySelectorAll('details.area').forEach((d) => d.addEventListener('toggle', () => { if (d.open) openAreas.add(d.dataset.area); else openAreas.delete(d.dataset.area); }));
  app.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => { selected = b.dataset.co; openAreas = new Set(); reload(); }));
  app.querySelectorAll('[data-mark]').forEach((b) => b.addEventListener('click', () => busyCall(b, () => api.post(`/api/rounds/${id}/mark`, { company: f.company, item: b.dataset.mark }), 'סומן כחתום', reload)));
  app.querySelectorAll('[data-unmark]').forEach((b) => b.addEventListener('click', () => busyCall(b, () => api.post(`/api/rounds/${id}/unmark`, { company: f.company, item: b.dataset.unmark }), 'הסימון בוטל', reload)));
  app.querySelector('[data-reopen]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: `פתיחת ${weekName(round)} לחתימה`, text: 'קציני המטה יוכלו לבחור את השבוע הזה ולחתום בו באיחור, עד שתנעלו אותו שוב.', confirmLabel: 'פתיחה' }))) return;
    busyCall(null, () => api.post(`/api/rounds/${id}/reopen`, { open: true }), 'השבוע נפתח לקציני המטה', reload);
  });
  app.querySelector('[data-lock]')?.addEventListener('click', () => busyCall(null, () => api.post(`/api/rounds/${id}/reopen`, { open: false }), 'השבוע ננעל', reload));
  wireApprove(f, id, reload);
}
async function busyCall(btn, fn, okText, reload) {
  if (btn) btn.disabled = true;
  try { await fn(); toast(okText, 'ok'); } catch (ex) { toast(ex.message, 'error'); }
  await reload();
}


// ---------- undo a signature (10 seconds) ----------
let undoBar = null;
function showUndo(company, items, seconds, okText, roundId = null) {
  undoBar?.close();
  if (!items?.length) return toast(okText, 'ok');
  const el = document.createElement('div');
  el.className = 'undo-bar';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(okText)}</span>
    <button type="button" class="undo-btn">ביטול <b class="undo-n">${seconds}</b></button>
    <i class="undo-timer" style="animation-duration:${seconds}s"></i>`;
  document.body.append(el);
  let left = seconds;
  const tick = setInterval(() => { left -= 1; const n = el.querySelector('.undo-n'); if (n) n.textContent = left; if (left <= 0) close(); }, 1000);
  function close() { clearInterval(tick); el.classList.add('out'); setTimeout(() => el.remove(), 250); if (undoBar?.el === el) undoBar = null; }
  el.querySelector('.undo-btn').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api.post('/api/sign/undo', { company, items, ...(roundId ? { round_id: roundId } : {}) });
      toast(r.removed === 1 ? 'החתימה בוטלה' : `${r.removed} חתימות בוטלו`, 'ok');
    } catch (ex) { toast(ex.message, 'error'); }
    close();
    await refresh();
  });
  undoBar = { el, close };
}
