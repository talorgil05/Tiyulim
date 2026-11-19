// Staff areas ("תחום אחריות"), in the order they are shown everywhere. Every row of an area is its own
// signature, per company and round. The keys are stored in the database: never change an existing key.
// `only`: the area applies only to these companies (the two קמב״ץ areas of הכש״י / הכש״מ).
export const HACHSHI = ['א', 'ב', 'ג', 'ד', 'עיט'];
export const HACHSHAM = ['601', '603', '605', '607'];

const area = (key, label, rows, only = null) => ({
  key, label, only, items: rows.map((r, i) => ({ key: `${key}.${i + 1}`, label: r })),
});

export const ROLES = [
  area('mashan_ka', 'משא״ן כ״א', ['שליחת סוגרי שבת', 'ביקורי בית חובה', 'ביקורי כלואים', 'סגירת טפסי טיולים – תנועות כ״א', 'הגשת חוזים וסיכומי ראיונות', 'הגשת תחקירי כ״א']),
  area('mashan_pakarit', 'משא״ן פק״רית', ['ביקורי בית חובה', 'ביקורי כלואים', 'סגירת טפסי טיולים – תנועות כ״א', 'הגשת חוזים וסיכומי ראיונות', 'הגשת תחקירי כ״א']),
  area('tash', 'ת״ש', ['ראיונות אנ״מ', 'ביקורי בית ואום']),
  area('machane', 'מחנה', ['ניקיון מרחב אחריות', 'מסדר הופעה ולבוש חיילים', 'מסדר הופעה ולבוש מפקדים', 'תדריך מרותקי שבת', 'ביצוע מסדרי דגל', 'דוח תקלות בינוי']),
  area('rechev', 'רכב', ['מסדר שבועי רכבים', 'וידוא תכנית רכב לשבוע הבא']),
  area('haspaka', 'הספקה', ['תיאום הובלות שבועיים קדימה', 'רישום שאטלים הלוך וחזור', 'שליחת איש קשר למפקד נסיעה']),
  area('refua', 'רפואה', ['הגשת דוחות שבועיים', 'הזנת מעקבי רפואה', 'זיכוי אקטיק']),
  area('hadracha', 'הדרכה', ['זיכוי כיתות', 'העלאת דרישת כיתות לשבוע הבא', 'וידוא הזנה דוחות מטריציוניים', 'זיכוי ציוד כחול']),
  area('klia', 'קליעה', ['זיכוי ערכת תאורה', 'הגשת מעקבים שבועיים', 'זיכוי עזרי אימון']),
  area('chinuch', 'חינוך', ['הגשת מעקבי חינוך', 'איסוף תמונות שבועיות', 'הגשת תחקירי אירוע ערכי', 'הגעה לימי למידה / שיעורי פרטני']),
  area('lochama', 'לוחמה', ['הזנת מעקבים', 'זיכוי עזרי אימון']),
  area('aga', 'א״ג', ['מילוי מעקבים', 'קביעת אימוני השלמה', 'ביצוע אימוני בולטים', 'ביצוע אימוני כסופים']),
  area('kamag', 'קמ״ג', ['מילוי מעקבים', 'קביעת אימוני השמה']),
  area('lag', 'קל״ג', ['וידוא תכנית מזון שבועיים קדימה']),
  area('mapam', 'מפ״מ', ['וידוא מוכנות לוגי לסופ״ש', 'וידוא חלונות בלאי']),
  area('tikshuv', 'תקשוב', ['ירוק בעיניים צופן וקשר', 'תיאום ציוד קשר שבועיים קדימה']),
  area('kambatz', 'קמב״ץ', ['שצ״ל', 'שליחת אימונים חריגים', 'צירי מסע', 'שליחת שעמ מייל']),
  area('kambatz_hachshi', 'קמב״ץ הכש״י', ['וידוא פק״ש חתום', 'וידוא שטחי אש שבוע קדימה', 'זיכוי שטחי אש'], HACHSHI),
  area('kambatz_hachsham', 'קמב״ץ הכש״מ', ['וידוא טפ״ש', 'וידוא משטח רק״מ', 'וידוא פק״ש חתום', 'וידוא שטחי אש שבוע קדימה'], HACHSHAM),
  area('madrit', 'מדר״ית', ['בנ״מ מג״ד', 'סיכומי הפעלות', 'שליחת שמות לקורסים', 'שליחת תמונות מהשבוע']),
  area('samgad', 'סמג״ד', ['הגשת דרך המלך שבוע נוכחי', 'הגשת תחקירי בטיחות', 'ירוק בעיניים צלם']),
];
export const ROLE_KEYS = ROLES.map((r) => r.key);
export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));
export const ITEM = Object.fromEntries(ROLES.flatMap((r) => r.items.map((it) => [it.key, { ...it, role_key: r.key }])));

// Companies, in the order they are shown everywhere (the name is also the key).
export const COMPANIES = ['א', 'ב', 'ג', 'ד', '601', '603', '605', '607', 'עיט', 'מפקדה'];

/** The areas that sign for this company (the הכש״י / הכש״מ areas only for their own companies). */
export const rolesFor = (company) => ROLES.filter((r) => !r.only || r.only.includes(company));
export const roleApplies = (roleKey, company) => rolesFor(company).some((r) => r.key === roleKey);

// Old role keys (first version, 11 roles) → the area that replaced them. Roles with no matching area
// (חוג״דת, קה״סית) become "pending" so the מג״ד assigns them again.
export const LEGACY_ROLE_MAP = { rechev: 'rechev', lag: 'lag', kambatz: 'kambatz', chinuch: 'chinuch', klia: 'klia', aga: 'aga', ramad: 'lochama', kahadit: 'hadracha', kashrag: 'tikshuv' };

// This area may also manage users: permissions (everything except מג״ד), password reset, delete.
export const USER_MANAGER_ROLE = 'tikshuv';
/** An officer may hold several areas (u.role_keys); role_key is the first of them. */
export const roleKeysOf = (u) => (u?.kind === 'officer' ? (u.role_keys?.length ? u.role_keys : [u.role_key].filter(Boolean)) : []);
export const canManageUsers = (u) => !!u && (u.kind === 'admin' || roleKeysOf(u).includes(USER_MANAGER_ROLE));

export const KINDS = ['admin', 'officer', 'company', 'pending'];
export const KIND_LABEL = { admin: 'מנהל — מג״ד', officer: 'קצין מטה', company: 'משתמש פלוגתי', pending: 'ממתין לשיוך' };

// Weekly uploads: besides the signatures, every company uploads photos / PDF files for these items each week.
// owner = the area whose officer sees them (the מג״ד sees all; the company sees its own).
export const UPLOADS = [
  { key: 'derech', label: 'נוהל דרך המלך', owner: 'samgad' },
  { key: 'safety', label: 'מעקבי בטיחות', owner: 'samgad' },
  { key: 'klia', label: 'מעקבי קליעה', owner: 'klia' },
  { key: 'hadracha', label: 'מעקבי הדרכה', owner: 'hadracha' },
  { key: 'cars', label: 'צילומי רכבים', owner: 'rechev' },
];
export const UPLOAD = Object.fromEntries(UPLOADS.map((u) => [u.key, u]));
