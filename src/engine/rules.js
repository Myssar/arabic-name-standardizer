/**
 * Letter-level romanization tables.
 *
 * TWO SEPARATE SYSTEMS ARE IMPLEMENTED, AND THEY ARE NOT INTERCHANGEABLE:
 *
 * 1. PASSPORT (default) — the convention actually used in the visual inspection
 *    zone of Arab passports and therefore on Canadian application forms, IRCC
 *    submissions and credential evaluations. ASCII only, no diacritics, emphatic
 *    consonants collapsed onto their plain counterparts, ain and hamza generally
 *    unwritten. This is a *convention*, not a bijection: it cannot be reversed.
 *
 * 2. ICAO_MRZ — ICAO Doc 9303 Part 3, Section 6.C, "Transliteration of Arabic
 *    Script". This is the encoding used in the two machine-readable lines at the
 *    bottom of a passport. It is lossless and reversible, and it is NOT a
 *    human-readable name: عبد encodes as XEBD. It is included so a user can
 *    verify what their own MRZ should contain, never as a name suggestion.
 *
 * Confusing (1) and (2) is the single most common error in tools of this kind.
 */

/** ICAO Doc 9303 Part 3 §6.C — MRZ transliteration of Arabic script. */
export const ICAO_MRZ = new Map([
  ['ء', 'XE'],  // ء  hamza
  ['آ', 'XAA'], // آ  alef with madda
  ['أ', 'XAE'], // أ  alef with hamza above
  ['ؤ', 'U'],   // ؤ  waw with hamza
  ['إ', 'I'],   // إ  alef with hamza below
  ['ئ', 'XI'],  // ئ  yeh with hamza
  ['ا', 'A'],   // ا
  ['ب', 'B'],   // ب
  ['ة', 'XTA'], // ة  taa marbuta (XAH when name-component-final)
  ['ت', 'T'],   // ت
  ['ث', 'XTH'], // ث
  ['ج', 'J'],   // ج
  ['ح', 'XH'],  // ح
  ['خ', 'XKH'], // خ
  ['د', 'D'],   // د
  ['ذ', 'XDH'], // ذ
  ['ر', 'R'],   // ر
  ['ز', 'Z'],   // ز
  ['س', 'S'],   // س
  ['ش', 'XSH'], // ش
  ['ص', 'XSE'], // ص
  ['ض', 'XDE'], // ض
  ['ط', 'XTE'], // ط
  ['ظ', 'XZE'], // ظ
  ['ع', 'E'],   // ع  ain
  ['غ', 'G'],   // غ  ghain
  ['ف', 'F'],   // ف
  ['ق', 'Q'],   // ق
  ['ك', 'K'],   // ك
  ['ل', 'L'],   // ل
  ['م', 'M'],   // م
  ['ن', 'N'],   // ن
  ['ه', 'H'],   // ه
  ['و', 'W'],   // و
  ['ى', 'XAY'], // ى  alef maqsura
  ['ي', 'Y'],   // ي
]);

/**
 * Passport-convention consonant map.
 * Empty string means the letter is conventionally unwritten in Latin script.
 */
export const PASSPORT_CONSONANTS = new Map([
  ['ء', ''],    // ء  hamza — unwritten
  ['ب', 'b'],
  ['ت', 't'],
  ['ث', 'th'],
  ['ج', 'j'],
  ['ح', 'h'],   // ح  collapses onto plain h
  ['خ', 'kh'],
  ['د', 'd'],
  ['ذ', 'th'],  // ذ  conventionally th (Thu al-Fiqar -> Thulfiqar)
  ['ر', 'r'],
  ['ز', 'z'],
  ['س', 's'],
  ['ش', 'sh'],
  ['ص', 's'],   // ص
  ['ض', 'd'],   // ض
  ['ط', 't'],   // ط
  ['ظ', 'z'],   // ظ
  ['ع', ''],    // ع  ain — unwritten, vowel carries it
  ['غ', 'gh'],
  ['ف', 'f'],
  ['ق', 'q'],
  ['ك', 'k'],
  ['ل', 'l'],
  ['م', 'm'],
  ['ن', 'n'],
  ['ه', 'h'],
  ['ک', 'k'],
  ['گ', 'g'],
  ['پ', 'p'],
  ['چ', 'ch'],
  ['ژ', 'zh'],
]);

/** Letters that behave as long vowels or semivowels depending on position. */
export const VOWEL_LETTERS = new Set([
  'ا', // ا
  'و', // و
  'ي', // ي
  'ى', // ى
  'آ', // آ
  'أ', // أ
  'إ', // إ
  'ؤ', // ؤ
  'ئ', // ئ
  'ة', // ة
]);

/** Word-initial renderings for the hamza-carrying alef forms. */
export const INITIAL_VOWELS = new Map([
  ['ا', 'a'],
  ['آ', 'a'],
  ['أ', 'a'],
  ['إ', 'i'],
  ['و', 'w'],
  ['ي', 'y'],
]);

/** The default short vowel inserted between consonant clusters by the fallback. */
export const EPENTHETIC_VOWEL = 'a';

/** Arabic definite article. */
export const AL = 'ال';

/**
 * Sun letters: the lam of the definite article assimilates to the following
 * consonant. عبد الرحمن is written Abdulrahman or Abdurrahman, never Abdalrahman
 * with an audible l.
 */
export const SUN_LETTERS = new Set([
  'ت', 'ث', 'د', 'ذ', 'ر', 'ز',
  'س', 'ش', 'ص', 'ض', 'ط', 'ظ',
  'ل', 'ن',
]);

/** Particles that are name components rather than names. */
export const PARTICLES = new Map([
  ['ابن', 'Ibn'],
  ['بن', 'Bin'],
  ['بنت', 'Bint'],
  ['أبو', 'Abu'],
  ['ابو', 'Abu'],
  ['أبي', 'Abi'],
  ['أم', 'Umm'],
  ['ام', 'Umm'],
  ['آل', 'Al'],
  ['ذو', 'Thu'],
]);


/**
 * Titles and honorifics.
 *
 * Without this table, دكتور is transliterated as though it were a given name
 * and comes out "Dakatur" — a person who does not exist. Titles are rendered
 * rather than dropped, so nothing the user typed disappears; a caller that
 * wants the bare name can filter on the `title` segment source.
 */
/**
 * Honorifics that are NOT part of a legal name.
 *
 * These are recognised so they can be REMOVED, not translated. The output of
 * this tool goes into a passport or application name field, where "Dr." is
 * wrong twice over: it is not part of the person's legal name, and the period
 * is a character such fields reject.
 *
 * What is deliberately NOT in this table:
 *
 *   أمير / أميرة / ملك / ملكة / سيد / سيدة — every one of them is a common
 *   given name. Iraq is full of men named Ameer and women named Malak and
 *   Ameera. Treating them as honorifics rendered "أمير محمد" as "Prince
 *   Muhammad" and "ملك حسين" as "King Hussein": the tool was handing back a
 *   different person's name, which is worse than handing back nothing.
 *
 *   رائد / مقدم — Raed is a common given name; the military ranks are not worth
 *   the collision.
 *
 * What remains are titles that are not also given names, and they are matched
 * only in FIRST position, because that is the only place an honorific appears.
 */
export const TITLES = new Map([
  ['دكتور', 'Dr.'], ['الدكتور', 'Dr.'], ['دكتوره', 'Dr.'], ['الدكتوره', 'Dr.'],
  ['استاذ', 'Prof.'], ['الاستاذ', 'Prof.'], ['استاذه', 'Prof.'], ['الاستاذه', 'Prof.'],
  ['مهندس', 'Eng.'], ['المهندس', 'Eng.'], ['مهندسه', 'Eng.'], ['المهندسه', 'Eng.'],
  ['شيخ', 'Sheikh'], ['الشيخ', 'Sheikh'],
  ['حاج', 'Hajj'], ['الحاج', 'Hajj'], ['حاجه', 'Hajja'], ['الحاجه', 'Hajja'],
  ['قاضي', 'Judge'], ['القاضي', 'Judge'],
  ['عميد', 'Brig.'], ['العميد', 'Brig.'],
  ['عقيد', 'Col.'], ['العقيد', 'Col.'],
  ['نقيب', 'Capt.'], ['النقيب', 'Capt.'],
  ['ملازم', 'Lt.'], ['الملازم', 'Lt.'],
]);
