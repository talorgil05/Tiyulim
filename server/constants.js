// Staff-officer roles, in the order they are shown everywhere. The key is stored in the database.
export const ROLES = [
  { key: 'rechev', label: 'ק. רכב' },
  { key: 'lag', label: 'קל״ג' },
  { key: 'kambatz', label: 'קמב״ץ' },
  { key: 'chinuch', label: 'ק. חינוך' },
  { key: 'klia', label: 'ק. קליעה' },
  { key: 'aga', label: 'קא״גית' },
  { key: 'ramad', label: 'רמ״ד לוחמה' },
  { key: 'hogadat', label: 'חוג״דת' },
  { key: 'kahadit', label: 'קה״דית' },
  { key: 'kahasit', label: 'קה״סית' },
  { key: 'kashrag', label: 'קשר״ג' },
];
export const ROLE_KEYS = ROLES.map((r) => r.key);
export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

// Companies, in the order they are shown everywhere (the name is also the key).
export const COMPANIES = ['א', 'ב', 'ג', 'ד', '601', '603', '605', '607', 'עיט', 'מפקדה'];

export const KINDS = ['admin', 'officer', 'company'];
export const KIND_LABEL = { admin: 'מנהל — מג״ד', officer: 'קצין מטה', company: 'משתמש פלוגתי' };
