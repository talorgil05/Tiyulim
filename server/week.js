// Calendar weeks for the weekly form. A week runs Monday 00:00 → Sunday 23:59, Israel time, so the form
// resets at midnight between Sunday and Monday. Numbering is the ISO week (1–52, sometimes 53), which uses
// exactly those Monday-to-Sunday weeks.
const TZ = 'Asia/Jerusalem';
const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The calendar date in Israel at this instant, as a UTC-midnight Date (only Y-M-D matter). */
function israelDay(now) {
  const p = Object.fromEntries(parts.formatToParts(now).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
}
const iso = (d) => d.toISOString().slice(0, 10);

/** { year, week, starts_on (Monday), ends_on (Sunday) } of the week that contains `now` in Israel. */
export function currentWeek(now = new Date()) {
  const day = israelDay(now);
  const dow = (day.getUTCDay() + 6) % 7;                       // Monday = 0 … Sunday = 6
  const monday = new Date(day); monday.setUTCDate(day.getUTCDate() - dow);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  const thursday = new Date(monday); thursday.setUTCDate(monday.getUTCDate() + 3);   // ISO: the week's Thursday decides the year
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = 1 + Math.floor((thursday - jan1) / 86400000 / 7);
  return { year, week, starts_on: iso(monday), ends_on: iso(sunday) };
}
