// "Add to home screen", as in תיאומון:
//   - Android / Chrome  → the browser's own install window (beforeinstallprompt), plus manual steps
//   - iPhone            → Share → "הוספה למסך הבית" (Safari has no install window)
//   - computer          → the install icon in Chrome / Edge address bar
//   - already installed → nothing is offered
// A small bar is offered once after the first signature or first login; closed with X → hidden for 30 days.
import { esc, ICONS, openSheet, store, isIOS, isAndroid, isStandalone } from './util.js';

const DISMISS_KEY = 'ty_install_bar_closed';
const DAYS_30 = 30 * 24 * 60 * 60 * 1000;
let deferred = null;

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
window.addEventListener('appinstalled', () => { deferred = null; store.set('ty_installed', '1'); hideBar(); });

export const installed = () => isStandalone() || store.get('ty_installed') === '1';

const step = (n, html) => `<li class="ob-step"><span class="ob-n" aria-hidden="true">${n}</span><div>${html}</div></li>`;
const key = (icon, label) => `<span class="ob-key">${icon}${esc(label)}</span>`;
const iosNonSafari = () => isIOS() && /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);

export function iphoneSteps() {
  return `
    ${iosNonSafari() ? '<div class="notice info small">הכי פשוט בספארי: העתיקו את הכתובת ופתחו אותה ב־Safari.</div>' : ''}
    <ol class="ob-steps">
      ${step(1, `לחצו על כפתור <b>השיתוף</b> ${key(ICONS.share, 'שיתוף')} בתחתית המסך (באייפד — למעלה).`)}
      ${step(2, 'גללו מטה ובחרו <b>״הוספה למסך הבית״</b> (Add to Home Screen).')}
      ${step(3, 'לחצו <b>״הוסף״</b> בפינה העליונה.')}
      ${step(4, 'מעכשיו פותחים את <b>טופס טיולים</b> מהאייקון במסך הבית — בלי לחפש קישור.')}
    </ol>`;
}
export function androidSteps() {
  return `
    ${deferred ? `<button type="button" class="btn btn-primary btn-big btn-block" data-install>${ICONS.phone} התקנה בלחיצה אחת</button>
      <p class="small muted" style="text-align:center;margin:.4rem 0 .6rem">או ידנית:</p>` : ''}
    <ol class="ob-steps">
      ${step(1, `בכרום, לחצו על ${key(ICONS.dots, 'תפריט')} בפינה העליונה.`)}
      ${step(2, 'בחרו <b>״התקנת אפליקציה״</b> או <b>״הוספה למסך הבית״</b>.')}
      ${step(3, 'אשרו <b>״התקנה״</b>. האייקון יופיע במסך הבית.')}
    </ol>`;
}
export function computerSteps() {
  return `
    ${deferred ? `<button type="button" class="btn btn-primary btn-big btn-block" data-install>${ICONS.plus} התקנה בלחיצה אחת</button>
      <p class="small muted" style="text-align:center;margin:.4rem 0 .6rem">או ידנית:</p>` : ''}
    <ol class="ob-steps">
      ${step(1, 'בכרום או ב־Edge, לחצו על סמל ההתקנה בקצה שורת הכתובת (מסך עם חץ).')}
      ${step(2, 'אשרו <b>״התקנה״</b>. האפליקציה תיפתח בחלון משלה ותופיע בתפריט ההתחלה.')}
      ${step(3, 'אפשר גם פשוט לשמור את הכתובת במועדפים.')}
    </ol>`;
}

/** Ask the browser to install (Android / desktop Chrome). Returns true when the window was shown. */
async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  try { e.prompt(); await e.userChoice; } catch { /* closed */ }
  return true;
}

/** Wire the one-tap buttons inside some html that came from the step functions. */
export function wireInstallButtons(root, after) {
  root.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', async () => { await promptInstall(); after?.(); }));
}

/** The full guide: tabs for iPhone / Android / computer, the right one opened for this device. */
export function openInstallGuide() {
  const tabs = [['iphone', 'אייפון', iphoneSteps], ['android', 'אנדרואיד', androidSteps], ['computer', 'מחשב', computerSteps]];
  let cur = isIOS() ? 'iphone' : isAndroid() ? 'android' : 'computer';
  const s = openSheet({
    title: 'הוספה למסך הבית',
    body: `${installed() ? '<div class="notice info">✓ האפליקציה כבר מותקנת במכשיר הזה.</div>' : ''}
      <div class="os-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" class="os-tab" role="tab" data-os="${k}">${l}</button>`).join('')}</div>
      <div data-os-body></div>`,
    foot: '<button type="button" class="btn btn-primary" data-close>הבנתי</button>',
  });
  const draw = () => {
    s.dlg.querySelectorAll('[data-os]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.os === cur)));
    const body = s.$('[data-os-body]');
    body.innerHTML = tabs.find(([k]) => k === cur)[2]();
    wireInstallButtons(body, () => s.close());
  };
  s.dlg.querySelectorAll('[data-os]').forEach((b) => b.addEventListener('click', () => { cur = b.dataset.os; draw(); }));
  draw();
}

// ---------- the small bar, offered once ----------
let bar = null;
function hideBar() {
  if (!bar) return;
  bar.classList.remove('show');
  const b = bar;
  bar = null;
  setTimeout(() => b.remove(), 250);
}
export function offerInstallBar() {
  if (installed() || bar) return;
  if (!deferred && !isIOS() && !isAndroid()) return;   // a desktop browser that can't install: nothing to offer
  const closed = Number(store.get(DISMISS_KEY) || 0);
  if (closed && Date.now() - closed < DAYS_30) return;
  bar = document.createElement('div');
  bar.className = 'install-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'הוספה למסך הבית');
  bar.innerHTML = `<span>הוסיפו את טופס טיולים למסך הבית — ותמיד יהיה בהישג יד</span>
    <button type="button" class="go">איך?</button><button type="button" class="x" aria-label="סגירה">✕</button>`;
  document.body.append(bar);
  bar.querySelector('.go').addEventListener('click', async () => {
    hideBar();
    if (!(await promptInstall())) openInstallGuide();
  });
  bar.querySelector('.x').addEventListener('click', () => { store.set(DISMISS_KEY, String(Date.now())); hideBar(); });
  requestAnimationFrame(() => requestAnimationFrame(() => bar?.classList.add('show')));
}
