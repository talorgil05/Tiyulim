// First-login tour: a few short slides for the user's role, then "add to home screen".
// Shown once per account (stored on the server, so not again on another phone).
import { api } from './api.js';
import { esc, openSheet } from './util.js';
import { iphoneSteps, androidSteps, computerSteps, wireInstallButtons, installed } from './install.js';
import { isIOS, isAndroid } from './util.js';

const SLIDES = {
  officer: (u) => [
    ['👋', `שלום ${u.full_name}`, `את/ה רשום/ה כ<b>${esc(u.role_label)}</b>. כל החתימות שלך יהיו בשם התפקיד הזה בלבד.`],
    ['🏷️', 'בוחרים פלוגה', 'ברשימת הפלוגות רואים ליד כל פלוגה: <b>✓ חתמתי</b> או <b>○ טרם חתמתי</b>.'],
    ['✍️', 'לוחצים "אישור חתימה"', 'לחיצה אחת — וזהו. החתימה נשמרת מיד ומופיעה אצל המג״ד ואצל הפלוגה. אפשר לחתום רק כשהמג״ד פתח סבב.'],
  ],
  company: (u) => [
    ['👋', `שלום ${u.full_name}`, `כאן רואים את טופס הטיולים של <b>${esc(u.company_key === 'מפקדה' ? 'מפקדה' : `פלוגה ${u.company_key}`)}</b> בסבב הנוכחי.`],
    ['📋', 'מי חתם ומי עוד לא', 'ליד כל קצין מטה: <b>✓ חתם</b> (עם שם ושעה) או <b>○ טרם חתם</b>. המסך מתעדכן לבד.'],
    ['✅', 'אישור המג״ד בתחתית', 'כשכל קציני המטה חתמו, הטופס ממתין לאישור המג״ד. כשהוא מאשר — רואים "הטופס אושר על ידי המג״ד".'],
  ],
  admin: () => [
    ['🎖️', 'שלום מג״ד', 'מכאן מנהלים את טופסי הטיולים של כל הגדוד.'],
    ['1️⃣', 'פותחים סבב', 'לוחצים <b>"פתיחת סבב חדש"</b>. רק בסבב פתוח קציני המטה יכולים לחתום.'],
    ['2️⃣', 'מאשרים כל פלוגה', 'בוחרים פלוגה ורואים מי חתם. <b>"אישור סופי לטופס"</b> נפתח רק אחרי שכל 11 קציני המטה חתמו.'],
    ['3️⃣', 'מסיימים סבב', '<b>"סיום סבב"</b> נועל את החתימות לצפייה ושומר אותן בהיסטוריה. הסבב הבא מתחיל נקי.'],
    ['👥', 'משתמשים והרשאות', 'כל מי שנרשם מחכה לך בלשונית <b>"משתמשים"</b>. שם נותנים לו תפקיד, פלוגה — או הרשאת מג״ד.'],
  ],
};

function installSlide() {
  const body = isIOS() ? iphoneSteps() : isAndroid() ? androidSteps() : computerSteps();
  return `<div class="tour-icon" aria-hidden="true">📲</div><h3>הוספה למסך הבית</h3>
    <p>כך פותחים את האפליקציה מהאייקון, כמו כל אפליקציה אחרת.</p>${body}`;
}

export function maybeShowTour(user) {
  const make = SLIDES[user.kind];
  if (!make || user.onboarded) return;
  const slides = make(user).map(([icon, title, text]) =>
    `<div class="tour-icon" aria-hidden="true">${icon}</div><h3>${esc(title)}</h3><p>${text}</p>`);
  if (!installed()) slides.push(installSlide());
  let i = 0;
  const done = () => api.post('/api/onboarding/done').catch(() => {});
  const s = openSheet({
    title: 'איך זה עובד',
    body: '<div class="tour" data-slide></div><div class="tour-dots" aria-hidden="true"></div>',
    foot: '<button type="button" class="btn" data-skip>דלג</button><button type="button" class="btn btn-primary" data-next>הבא</button>',
    onClose: done,
  });
  const draw = () => {
    const slide = s.$('[data-slide]');
    slide.innerHTML = slides[i];
    wireInstallButtons(slide, () => s.close());
    s.$('.tour-dots').innerHTML = slides.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('');
    s.$('[data-next]').textContent = i === slides.length - 1 ? 'סיום' : 'הבא';
  };
  s.$('[data-next]').addEventListener('click', () => { if (i === slides.length - 1) s.close(); else { i++; draw(); } });
  s.$('[data-skip]').addEventListener('click', () => s.close());
  draw();
}
