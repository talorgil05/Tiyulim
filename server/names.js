// The full name is also the login name, so it is normalised the same way everywhere.
export function normalizeName(v) {
  return typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

// Letters (any language), digits (e.g. a company number), spaces, geresh/gershayim, hyphen, period. 2–40 chars,
// starting with a letter.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} '׳"״.\-]{1,39}$/u;
export const isValidName = (s) => NAME_RE.test(s) && /\p{L}.*\s.*\p{L}|\p{L}{2,}/u.test(s);

export const NAME_TAKEN_MSG =
  'השם הזה כבר רשום במערכת. אם יש לכם שם זהה למישהו אחר, הוסיפו שם אמצעי או אות להבדלה (למשל: יוסי כהן ב׳)';
