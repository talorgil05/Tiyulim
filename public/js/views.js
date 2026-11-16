// מג״ד screens (users & permissions, history) and everyone's profile — patterned on תיאומון.
import { api } from './api.js';
import { esc, fmtStamp, coName, toast, openSheet, confirmSheet, addPasswordToggles, busy, phoneLink, ICONS } from './util.js';
import { openInstallGuide, installed } from './install.js';

export const kindText = (u) => u.kind === 'officer' ? u.role_label
  : u.kind === 'company' ? coName(u.company_key)
  : u.kind === 'admin' ? 'מג״ד' : 'ממתין לשיוך';

const formError = (f, m) => { const b = f.querySelector('.form-error'); b.textContent = m; b.hidden = !m; if (m) b.setAttribute('role', 'alert'); };

// =====================================================================
// Users and permissions (מג״ד)
// =====================================================================
let query = '';

export async function renderUsers(ctx) {
  const { users } = await api.get('/api/users');
  const { meta } = ctx;
  const me = ctx.user;
  // the קשר״ג manages permissions too — everything except מג״ד, and not the מג״ד's accounts or his own
  const isAdmin = me.kind === 'admin';
  const canEdit = (u) => isAdmin || (u.kind !== 'admin' && u.id !== me.id);
  const active = users.filter((u) => u.active);
  const pending = active.filter((u) => u.kind === 'pending');
  const missRoles = meta.roles.filter((r) => !active.some((u) => u.role_key === r.key)).map((r) => r.label);
  const missCos = meta.companies.filter((c) => !active.some((u) => u.company_key === c)).map(coName);
  const miss = [...missRoles, ...missCos];

  ctx.shell(`
    <div class="users-head">
      <h1>משתמשים והרשאות</h1>
      <span class="muted">${active.length} פעילים${pending.length ? ` · <b style="color:var(--orange-ink)">${pending.length} ממתינים לשיוך</b>` : ''}</span>
    </div>
    <p class="small muted" style="margin-top:-.4rem">כל מי שנרשם מופיע כאן כ״ממתין לשיוך״. לוחצים <b>שינוי הרשאה</b> ומשייכים לתפקיד או לפלוגה${isAdmin
      ? ' — או נותנים הרשאת מג״ד.' : '. הרשאת מג״ד, השבתה, איפוס סיסמה ומחיקה — רק אצל המג״ד.'}</p>
    ${miss.length ? `<div class="missing"><b>עדיין בלי חשבון פעיל:</b> ${miss.map(esc).join(' · ')}</div>` : ''}
    <div class="field"><label class="sr-only" for="u-q">חיפוש</label>
      <input type="search" id="u-q" placeholder="חיפוש לפי שם, טלפון, תפקיד או פלוגה" value="${esc(query)}"></div>
    <div class="user-list" id="user-list"></div>`);

  const list = document.getElementById('user-list');
  const draw = () => {
    const q = query.trim().toLowerCase();
    const shown = users.filter((u) => !q || `${u.full_name} ${u.phone} ${kindText(u)}`.toLowerCase().includes(q));
    list.innerHTML = shown.length ? shown.map((u) => `
      <article class="user-card ${u.kind === 'pending' && u.active ? 'is-pending' : ''} ${u.active ? '' : 'off'}" data-user="${u.id}">
        <div class="user-top"><b>${esc(u.full_name)}</b>${u.id === me.id ? ' <span class="tag">את/ה</span>' : ''}
          <span class="tag ${u.kind === 'pending' ? 'pend' : ''}">${esc(kindText(u))}</span>
          ${u.active ? '' : '<span class="tag off">מושבת</span>'}</div>
        <div class="user-meta"><span>📱 ${phoneLink(u.phone)}</span><span>נרשם ${esc(fmtStamp(u.created_at))}</span></div>
        <div class="btn-row">
          ${canEdit(u) ? '<button type="button" class="btn btn-sm btn-primary" data-perm>שינוי הרשאה</button>' : ''}
          ${!isAdmin ? '' : `
          ${u.id === me.id ? '' : `<button type="button" class="btn btn-sm ${u.active ? 'btn-danger' : ''}" data-toggle>${u.active ? 'השבתה' : 'הפעלה'}</button>`}
          <button type="button" class="btn btn-sm" data-reset>איפוס סיסמה</button>
          ${u.id === me.id ? '' : '<button type="button" class="btn btn-sm btn-danger" data-delete>מחיקה</button>'}`}
        </div>
      </article>`).join('') : '<p class="muted">לא נמצאו משתמשים</p>';
  };
  document.getElementById('u-q').addEventListener('input', (e) => { query = e.target.value; draw(); });
  draw();

  const reload = () => renderUsers(ctx);
  const afterSelfChange = (user) => {
    if (user.id !== me.id) return false;
    ctx.setUser(user);
    if (!user.can_manage_users) { location.hash = ''; ctx.reenter(); return true; }
    return false;
  };

  // Any מג״ד can give anyone any permission, including מג״ד. The server only blocks removing the last one.
  function openPermissions(u) {
    const opt = (k, title, note, extra = '') => `<label class="perm-opt"><input type="radio" name="kind" value="${k}" ${u.kind === k ? 'checked' : ''}>
      <span><b>${title}</b>${u.kind === k ? ' <span class="small muted">(נוכחי)</span>' : ''}<small>${note}</small>${extra}</span></label>`;
    const sel = (id, list, cur, ph) => `<select id="${id}" style="margin-top:.4rem"><option value="">${ph}</option>${list.map(([v, l]) =>
      `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const s = openSheet({
      title: `הרשאה עבור ${u.full_name}`,
      body: `<form id="perm-form" novalidate><div class="form-error" hidden></div>
        <fieldset class="perm-pick"><legend class="sr-only">בחירת הרשאה</legend>
          ${opt('officer', 'קצין מטה', 'חותם לפלוגות בשם התפקיד', sel('p-role', meta.roles.map((r) => [r.key, r.label]), u.role_key, 'בחרו תפקיד…'))}
          ${opt('company', 'משתמש פלוגתי', 'צופה בטופס של הפלוגה שלו בלבד', sel('p-co', meta.companies.map((c) => [c, coName(c)]), u.company_key, 'בחרו פלוגה…'))}
          ${isAdmin ? opt('admin', 'מג״ד', 'כל ההרשאות: סבבים, אישור סופי, משתמשים') : ''}
          ${opt('pending', 'ללא הרשאה', 'ממתין לשיוך — לא רואה ולא חותם')}
        </fieldset></form>`,
      foot: '<button type="button" class="btn" data-close>ביטול</button><button type="submit" form="perm-form" class="btn btn-primary">שמירה</button>',
    });
    const form = s.$('#perm-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const kind = form.kind.value;
      const body = { kind, role_key: s.$('#p-role').value, company_key: s.$('#p-co').value };
      if (!kind) return formError(form, 'יש לבחור הרשאה');
      if (kind === 'officer' && !body.role_key) return formError(form, 'יש לבחור תפקיד');
      if (kind === 'company' && !body.company_key) return formError(form, 'יש לבחור פלוגה');
      return busy(s.$('[form=perm-form]'), async () => {
        try {
          const { user } = await api.patch(`/api/users/${u.id}`, body);
          s.close();
          toast(`${user.full_name}: ${kindText(user)}`, 'ok');
          if (!afterSelfChange(user)) reload();
        } catch (ex) { formError(form, ex.message); }
      });
    });
    // picking a role or company selects its option
    s.$('#p-role').addEventListener('change', () => { form.kind.value = 'officer'; });
    s.$('#p-co').addEventListener('change', () => { form.kind.value = 'company'; });
  }

  /** Permanent: the name, phone and password are erased. Past signatures keep the name. */
  function deleteUser(u) {
    const s = openSheet({
      title: `מחיקת ${u.full_name}`,
      body: `<div class="form-error" hidden></div>
        <div class="danger-note">הפעולה סופית ואי אפשר לבטל אותה.</div>
        <ul style="margin:0 0 .8rem;padding-inline-start:1.2rem">
          <li>השם, הטלפון והסיסמה יימחקו, והמשתמש לא יוכל להתחבר.</li>
          <li>חתימות ואישורים מסבבים קודמים נשמרים עם השם שלו.</li>
          <li>השם יתפנה — אפשר יהיה להירשם בו מחדש.</li>
        </ul>
        <div class="field"><label for="del-name">כדי לאשר, הקלידו את השם המלא: <b>${esc(u.full_name)}</b></label>
          <input type="text" id="del-name" autocomplete="off"></div>`,
      foot: '<button type="button" class="btn" data-close>ביטול</button><button type="button" class="btn btn-danger" data-go disabled>מחיקה סופית</button>',
    });
    const input = s.$('#del-name'), go = s.$('[data-go]');
    const norm = (x) => x.replace(/\s+/g, ' ').trim();
    input.addEventListener('input', () => { go.disabled = norm(input.value) !== u.full_name; });
    input.focus();
    go.addEventListener('click', () => busy(go, async () => {
      try { await api.post(`/api/users/${u.id}/delete`, { confirm_name: norm(input.value) }); s.close(); toast(`${u.full_name} נמחק/ה`, 'ok'); reload(); }
      catch (ex) { formError(s.dlg, ex.message); }
    }));
  }

  list.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-user]');
    if (!card) return;
    const u = users.find((x) => x.id === Number(card.dataset.user));
    if (e.target.closest('[data-perm]')) return openPermissions(u);
    if (e.target.closest('[data-delete]')) return deleteUser(u);
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      if (u.active && !(await confirmSheet({ title: 'השבתת חשבון', text: `להשבית את ${u.full_name}? הוא לא יוכל להיכנס עד שתפעילו אותו שוב.`, confirmLabel: 'השבתה' }))) return;
      return busy(tog, async () => {
        try { await api.patch(`/api/users/${u.id}`, { active: !u.active }); reload(); } catch (ex) { toast(ex.message, 'error'); }
      });
    }
    if (e.target.closest('[data-reset]')) {
      if (!(await confirmSheet({ title: 'איפוס סיסמה', text: `ליצור סיסמה זמנית חדשה ל${u.full_name}? הסיסמה הקודמת תפסיק לעבוד.`, confirmLabel: 'איפוס' }))) return;
      try {
        const { password } = await api.post(`/api/users/${u.id}/reset-password`);
        openSheet({
          title: `סיסמה זמנית ל${u.full_name}`,
          body: `<p>מסרו אותה באופן אישי. היא מוצגת פעם אחת בלבד:</p><p class="temp-pw ltr">${esc(password)}</p>
            <p class="small muted">נכנסים עם השם המלא <b>${esc(u.full_name)}</b>, ואפשר להחליף אותה במסך הפרופיל.</p>`,
          foot: '<button class="btn btn-primary" data-close>סגירה</button>',
        });
      } catch (ex) { toast(ex.message, 'error'); }
    }
  });
}

// =====================================================================
// History (מג״ד)
// =====================================================================
export async function renderHistory(ctx) {
  const { rounds } = await api.get('/api/rounds');
  ctx.shell(`
    <h2>סבבים קודמים</h2>
    ${rounds.length ? rounds.map((r) => `
      <button class="hist-row" data-round="${r.id}">
        <span class="h-main"><b>סבב ${r.number}</b> ${r.status === 'open' ? '<span class="tag">פתוח</span>' : '<span class="tag">🔒 נסגר</span>'}
          <span class="muted small" style="display:block">${esc(fmtStamp(r.opened_at))}${r.closed_at ? ` עד ${esc(fmtStamp(r.closed_at))}` : ''}</span></span>
        <span class="count">${r.approved}/${r.total} אושרו</span>
      </button>`).join('') : '<p class="muted">אין עדיין סבבים.</p>'}`);
  document.querySelectorAll('[data-round]').forEach((b) => b.addEventListener('click', async () => {
    const { round, forms } = await api.get(`/api/rounds/${b.dataset.round}`);
    const head = ctx.meta.roles.map((r) => `<th scope="col">${esc(r.label)}</th>`).join('');
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

// =====================================================================
// Profile (everyone)
// =====================================================================
export function renderProfile(ctx) {
  const u = ctx.user;
  const theme = window.tmTheme?.get?.() || 'auto';
  ctx.shell(`
    <div class="center-card">
      <form class="panel" id="profile-form" novalidate>
        <h2>הפרטים שלי</h2>
        <div class="form-error" hidden></div>
        <div class="field"><span class="label" style="font-weight:600">הרשאה</span>
          <span><span class="tag">${esc(kindText(u))}</span> <span class="small muted">(רק המג״ד משנה הרשאות)</span></span></div>
        <div class="field"><label for="p-name">שם מלא</label><input id="p-name" name="full_name" type="text" value="${esc(u.full_name)}" required>
          <span class="hint">השם המלא משמש גם לכניסה, ומופיע כשם החותם</span></div>
        <div class="field"><label for="p-phone">טלפון</label><input id="p-phone" name="phone" type="tel" inputmode="numeric" maxlength="12" value="${esc(u.phone)}" required>
          <span class="hint">10 ספרות</span></div>
        <button type="submit" class="btn btn-primary">שמירת פרטים</button>
      </form>
      <form class="panel" id="pw-form" novalidate>
        <h2>החלפת סיסמה</h2>
        <div class="form-error" hidden></div>
        <input type="text" name="login_hint" value="${esc(u.full_name)}" autocomplete="username" hidden>
        <div class="field"><label for="pw-cur">סיסמה נוכחית</label><input id="pw-cur" name="current_password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="pw-new">סיסמה חדשה</label><input id="pw-new" name="new_password" type="password" autocomplete="new-password" required><span class="hint">לפחות 8 תווים</span></div>
        <div class="field"><label for="pw-new2">אימות סיסמה חדשה</label><input id="pw-new2" name="new_password2" type="password" autocomplete="new-password" required></div>
        <button type="submit" class="btn">עדכון סיסמה</button>
      </form>
      <section class="panel">
        <h2>תצוגה</h2>
        <div class="theme-pick" role="radiogroup" aria-label="מצב תצוגה">
          ${[['auto', 'אוטומטי', 'לפי הטלפון'], ['light', 'בהיר', ''], ['dark', 'כהה', '']].map(([v, l, h]) => `<label class="theme-opt">
            <input type="radio" name="theme" value="${v}" ${theme === v ? 'checked' : ''}><span>${l}${h ? `<small>${h}</small>` : ''}</span></label>`).join('')}
        </div>
      </section>
      <section class="panel">
        <h2>הוספה למסך הבית</h2>
        <p class="muted" style="margin-top:0">${installed() ? '✓ האפליקציה כבר מותקנת במכשיר הזה.' : 'כך פותחים את טופס טיולים מאייקון במסך הבית, כמו כל אפליקציה.'}</p>
        <div class="btn-row"><button type="button" class="btn" data-install-guide>${ICONS.phone} איך מוסיפים</button>
          <a class="btn" href="/help/">${ICONS.help} עזרה ושאלות נפוצות</a></div>
      </section>
    </div>`);
  const pf = document.getElementById('profile-form');
  const pw = document.getElementById('pw-form');
  addPasswordToggles(pw);
  document.querySelector('[data-install-guide]').addEventListener('click', openInstallGuide);
  document.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener('change', () => window.tmTheme?.set(r.value)));
  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(pf));
    fd.phone = fd.phone.replace(/[\s-]/g, '');
    if (fd.full_name.trim().length < 2) return formError(pf, 'יש למלא שם מלא');
    if (!/^\d{10}$/.test(fd.phone)) return formError(pf, 'מספר טלפון חייב להכיל בדיוק 10 ספרות');
    return busy(pf.querySelector('[type=submit]'), async () => {
      try { const { user } = await api.patch('/api/profile', fd); ctx.setUser(user); toast('הפרטים נשמרו', 'ok'); renderProfile(ctx); }
      catch (ex) { formError(pf, ex.message); }
    });
  });
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(pw));
    if (fd.new_password.length < 8) return formError(pw, 'סיסמה חייבת להכיל לפחות 8 תווים');
    if (fd.new_password !== fd.new_password2) return formError(pw, 'הסיסמאות אינן תואמות');
    return busy(pw.querySelector('[type=submit]'), async () => {
      try {
        await api.post('/api/profile/password', { current_password: fd.current_password, new_password: fd.new_password });
        pw.reset(); formError(pw, ''); toast('הסיסמה עודכנה', 'ok');
      } catch (ex) { formError(pw, ex.message); }
    });
  });
}
