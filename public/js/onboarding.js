// First-login tour: a few short slides for the user's role, then "add to home screen".
// Shown once per account (stored on the server, so not again on another phone).
import { api } from './api.js';
import { esc, openSheet } from './util.js';
import { iphoneSteps, androidSteps, computerSteps, wireInstallButtons, installed } from './install.js';
import { isIOS, isAndroid } from './util.js';

const SLIDES = {
  officer: (u) => [
    ['👋', `שלום ${u.full_name}`, `את/ה רשום/ה כ<b>${esc(u.role_label)}</b>. כל החתימות שלך יהיו בשם התפקיד הזה בלבד.`],
    ['🏷️', 'בוחרים פלוגה', 'ברשימת הפלוגות רואים ליד כל פלוגה: <b>✓ חתמתי</b>, כמה שורות נחתמו (למשל 2/4), או <b>○ טרם חתמתי</b>.'],
    ['✍️', 'חותמים על השורות', 'לכל פלוגה מופיעות השורות של התחום שלך. לוחצים <b>"חתום"</b> ליד כל שורה שבוצעה, או <b>"חתימה על כל השורות"</b>. החתימה נשמרת מיד ומופיעה אצל המג״ד ואצל הפלוגה. חתמת בטעות? יש כפתור "ביטול" למשך 10 שניות.'],
    ...(u.can_manage_users ? [['👥', 'גם הרשאות', 'כתקשוב יש לך לשונית <b>"משתמשים"</b>: משייכים כל מי שנרשם לתפקיד או לפלוגה, ואפשר גם לאפס סיסמה ולמחוק משתמש. הרשאת מג״ד נותן רק המג״ד.']] : []),
  ],
  company: (u) => [
    ['👋', `שלום ${u.full_name}`, `כאן רואים את טופס הטיולים של <b>${esc(u.company_key === 'מפקדה' ? 'מפקדה' : `פלוגה ${u.company_key}`)}</b> בשבוע הנוכחי. אפשר גם להדפיס או לשמור כ־PDF.`],
    ['📋', 'מי חתם ומי עוד לא', 'הטופס מחולק לתחומים. ליד כל תחום רואים כמה שורות נחתמו, ולחיצה עליו מציגה כל שורה: <b>✓ חתם</b> (עם שם ושעה) או <b>○ טרם חתם</b>. המסך מתעדכן לבד.'],
    ['✅', 'אישור המג״ד בתחתית', 'כשכל קציני המטה חתמו, הטופס ממתין לאישור המג״ד. כשהוא מאשר — רואים "הטופס אושר על ידי המג״ד".'],
  ],
  admin: () => [
    ['🎖️', 'שלום מג״ד', 'מכאן מנהלים את טופסי הטיולים של כל הגדוד.'],
    ['1️⃣', 'טופס לכל שבוע', 'בכל יום שני ב־00:00 נפתח לבד טופס חדש לשבוע. אין צורך לפתוח או לסגור כלום.'],
    ['2️⃣', 'מאשרים כל פלוגה', 'בוחרים פלוגה ורואים מי חתם. <b>"אישור סופי לטופס"</b> נפתח רק אחרי שכל השורות של הפלוגה נחתמו.'],
    ['3️⃣', 'היסטוריה', 'בסוף השבוע הטופס ננעל ונשמר בלשונית <b>"היסטוריה"</b>, לפי מספר השבוע.'],
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
