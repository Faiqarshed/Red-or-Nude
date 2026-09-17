// Checks for the admin forms, run before anything is sent.
//
// The server actions still validate — they are the authority — but all they can
// say back is "invalid", which told the salon nothing about which box was
// wrong. These mirror the limits in each action's zod schema and name the
// field in the message, in the panel's own language.
//
// Usage: build `errors` from `rules(t.validation)` on every render once a save
// has been tried, so a message disappears the moment the field is fixed.

import { latinDigits, validateSaudiMobile } from "@/lib/phone";
import type { ValidationMessages } from "@/lib/validation-messages";
import type { AdminStrings } from "./strings";

export type Errors = Record<string, string>;

/**
 * name@example.com, spelled out rather than borrowed from zod, whose pattern
 * lets "a@x-.com" through. Stricter than zod everywhere, never looser, so an
 * address saved here is always one the public sign-in API accepts too (which
 * is why "%" isn't allowed: zod refuses it there).
 *
 *   local   letters/digits at both ends, . _ + - between, no ".."  (≤ 64)
 *   domain  labels of letters/digits/hyphens, never starting or ending in "-"
 *   ending  letters only, 2 to 24 of them: .sa, .com, .museum
 */
export const EMAIL_RE =
  /^(?!.*\.\.)[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9_])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

/**
 * The part of a well-formed address that is plainly keyboard mash, or undefined.
 * EMAIL_RE only knows shape; "uygt76t879708770979678687@gmail.com" has a fine one.
 *
 * ponytail: heuristics, like the name checks. "asdf@gmail.com" still passes;
 * only a code sent to the inbox proves an address is real.
 */
export function fakeEmailPart(local: string, domain: string): string | undefined {
  // Handles are chosen, not official, so anything a person would pick on
  // purpose passes: "nouraaa", "noura2k24", "noura19951995". Only what no one
  // picks is stopped.
  //
  // A mobile used as the name (0555123456@, 966555123456@) is common here and
  // real, so it is taken out before digits are judged.
  const withoutMobile = local.replace(/(?:00966|966|0)?5\d{8}/g, "");
  const looksMashed = (part: string) =>
    // A run of digits longer than any date or year pair.
    /\d{10,}/.test(part) ||
    mashed(part) ||
    part.split(/[._+-]/).some((seg) => {
      // Letters and digits swapping back and forth: "a1b2c3", or a few swaps
      // dragging a long tail of digits, "uygt76t879708770979678687".
      const swaps = seg.match(/[a-z](?=\d)|\d(?=[a-z])/gi)?.length ?? 0;
      const digits = seg.replace(/\D/g, "").length;
      return swaps >= 5 || (swaps >= 3 && digits >= 6);
    });

  if (looksMashed(withoutMobile)) return local;
  // Every domain label but the ending: "sdfghj" in noura@sdfghj.com.
  const labels = domain.split(".").slice(0, -1);
  if (labels.some(mashed)) return domain;
}

/** Five Latin consonants in a row: "sdfghjk". No name or word does that. */
const MASH = /[bcdfghjklmnpqrstvwxz]{5,}/i;
/** One short group hammered out three times over: "asdasdasd", "abcabcabc". */
const DRUMMED = /([a-z]{2,4})\1{2,}/i;
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"].flatMap((row) => [
  row,
  [...row].reverse().join(""),
]);
/**
 * The word is nothing but a run along one row: "asdf", "qwer", "lkjh".
 *
 * The whole word, not a piece of it: "trew" sits inside the surname Trewin, and
 * a rule that refuses a real name is a rule the salon learns to work around.
 * Mash longer than this is caught by walked() below anyway.
 */
const isRowRun = (w: string) => w.length >= 4 && ROWS.some((row) => row.includes(w));

/** Where each key sits, rows staggered half a key like a real keyboard. */
const KEYS = new Map<string, [number, number]>(
  ["qwertyuiop", "asdfghjkl", "zxcvbnm"].flatMap((row, r) =>
    [...row].map((k): [string, [number, number]] => [k, [r, i(row, k) + r * 0.5]]),
  ),
);
function i(row: string, k: string) {
  return row.indexOf(k);
}
const touching = (a: string, b: string) => {
  const [p, q] = [KEYS.get(a), KEYS.get(b)];
  return !!p && !!q && Math.abs(p[0] - q[0]) <= 1 && Math.abs(p[1] - q[1]) <= 1;
};

/**
 * Six keys walked across the keyboard, each next to the last: "ftgyhujh". Six,
 * not five, because five catches real names — "Sawsan" walks s-a-w-s-a.
 */
function walked(w: string) {
  const s = w.toLowerCase();
  let run = 1;
  for (let n = 1; n < s.length; n++) {
    run = touching(s[n - 1], s[n]) ? run + 1 : 1;
    if (run >= 6) return true;
  }
  return false;
}

/**
 * Latin keyboard mash, by the shapes it actually arrives in. Latin-only on
 * purpose, so it never fires on an Arabic word.
 *
 * ponytail: heuristics, not a dictionary — "asdf" is four keys and caught,
 * "qwe" is three and passes. No regex tells a made-up word from a brand name.
 */
const mashed = (w: string) =>
  MASH.test(w) || DRUMMED.test(w) || walked(w) || isRowRun(w.toLowerCase());
const ARABIC = /[؀-ۿ]/;
const LETTER = /\p{L}/u;

type Script = "ar" | "en" | "any";

export function rules(v: ValidationMessages) {
  return {
    /**
     * `script: "ar"` asks for Arabic letters; `"en"` refuses them; `"any"`
     * takes either (a closure reason). All three also refuse a value with no
     * letters at all ("123", "---") and obvious keyboard mash.
     */
    text(
      label: string,
      value: string,
      o: { required?: boolean; min?: number; max?: number; script?: Script } = {},
    ) {
      const s = value.trim();
      if (!s) return o.required === false ? undefined : v.required(label);
      if (o.script && !LETTER.test(s)) return v.letters(label);
      if (o.script === "ar" && !ARABIC.test(s)) return v.arabic(label);
      if (o.script === "en" && ARABIC.test(s)) return v.notArabic(label);
      // The whole word is quoted, so she can find it in a long name.
      const word = (bad: (w: string) => boolean) => s.split(/\s+/).find(bad);
      const repeated = o.script && word((w) => /(\p{L})\1\1/u.test(w));
      if (repeated) return v.repeated(label, repeated);
      const mash = o.script && o.script !== "ar" && word(mashed);
      if (mash) return v.gibberish(label, mash);
      if (o.min && s.length < o.min) return v.tooShort(label, o.min);
      if (o.max && s.length > o.max) return v.tooLong(label, o.max);
    },

    number(
      label: string,
      raw: string | number | null | undefined,
      o: {
        required?: boolean;
        min?: number;
        max?: number;
        int?: boolean;
        positive?: boolean;
        decimals?: number;
      } = {},
    ) {
      const s = String(raw ?? "").trim();
      if (!s) return o.required === false ? undefined : v.required(label);
      const n = Number(s);
      if (!Number.isFinite(n)) return v.number(label);
      if (o.int && !Number.isInteger(n)) return v.whole(label);
      if (o.decimals !== undefined && (s.split(".")[1] ?? "").length > o.decimals)
        return v.decimals(label, o.decimals);
      if (o.positive && n <= 0) return v.positive(label);
      if (o.min !== undefined && n < o.min) return v.min(label, o.min);
      if (o.max !== undefined && n > o.max) return v.max(label, o.max);
    },

    /**
     * EMAIL_RE decides; the checks before it only exist to say *what* is wrong,
     * so she isn't left staring at "not a valid email" hunting for a typo.
     */
    email(label: string, value: string, o: { required?: boolean; max?: number } = {}) {
      const s = value.trim();
      if (!s) return o.required ? v.required(label) : undefined;
      const at = s.indexOf("@");
      if (at < 0) return v.emailNoAt(label);
      const local = s.slice(0, at);
      const domain = s.slice(at + 1);
      if (!local) return v.emailNoLocal(label);
      if (local.length > 64) return v.tooLong(label, 64);
      if (/^\.|\.$|\.\./.test(local)) return v.emailDots(label);
      if (!domain.includes(".")) return v.emailNoDomain(label);
      if (!/\.[A-Za-z]{2,24}$/.test(domain)) return v.emailTld(label);
      if (!EMAIL_RE.test(s)) return v.email(label);
      if (o.max && s.length > o.max) return v.tooLong(label, o.max);
      const fake = fakeEmailPart(local, domain);
      if (fake) return v.emailGibberish(label, fake);
    },
  };
}

/**
 * Filter a number box as it is typed: digits only (Arabic-Indic ٠-٩ become
 * 0-9), no leading zeros, at most `maxDigits` before the point and `decimals`
 * after it. Out-of-range values still type fine and get a message — this only
 * stops what can never be a valid number.
 */
export function numeric(
  raw: string,
  o: { maxDigits: number; decimals?: number; signed?: boolean },
): string {
  const latin = latinDigits(raw);
  // `signed`: one minus, and only in front.
  const sign = o.signed && /^\s*-/.test(latin) ? "-" : "";
  const [whole = "", ...frac] = latin.replace(/[^\d.]/g, "").split(".");
  const int = whole.replace(/^0+(?=\d)/, "").slice(0, o.maxDigits);
  if (!o.decimals || frac.length === 0) return sign + int;
  return `${sign}${int || "0"}.${frac.join("").slice(0, o.decimals)}`;
}

// ------------------------------------------------------------- gift cards ---

/** Same ceiling as issuing a card: one adjustment can't move more than this. */
export const ADJUST_MAX = 20_000;
export const ADJUST_TEXT: TextOpts = { script: "any", long: true };
export const ADJUST_REASON_MAX = 120;

/**
 * `long` widens the punctuation (descriptions, reasons); `person` narrows it to
 * a human name — no digits, only - ' . ; `multiline` keeps line breaks (notes).
 */
export type TextOpts = {
  script: Script;
  long?: boolean;
  person?: boolean;
  multiline?: boolean;
  /** English letters, digits and . _ + - @ only, with a single @. */
  email?: boolean;
};

/** The punctuation a box accepts, as shown to her: "- & ' . ( ) /". */
export const allowedPunct = (o: TextOpts) =>
  [...(o.email ? "._+-@" : o.person ? "-'." : o.long ? "-&'.()/,|:+!%،؟" : "-&'.()/")].join(" ");

const disallowed = (o: TextOpts, flags: string) => {
  if (o.email) return new RegExp("[^A-Za-z0-9._+\\-@]", flags);
  const letters = o.script === "en" ? "\\p{Script=Latin}" : "\\p{Script=Arabic}\\p{Script=Latin}";
  const digits = o.person ? "" : "\\d";
  const breaks = o.multiline ? "\\n" : "";
  const punct = allowedPunct(o).replace(/ /g, "").replace(/[-\\\]^]/g, "\\$&");
  return new RegExp(`[^${letters}${digits} ${breaks}${punct}]`, flags);
};

/**
 * Filter a name or description box as it is typed: letters of the box's script
 * (the Arabic box also takes Latin, for brand terms like "BIAB"), digits, single
 * spaces and a little punctuation. Emoji, tabs and stray symbols never land.
 * `long` widens the punctuation for descriptions.
 */
export function typedText(raw: string, o: TextOpts): string {
  if (o.email) {
    // An address never holds a space, and a pasted one often trails one.
    const s = raw.replace(/\s/g, "").replace(disallowed(o, "g"), "");
    const at = s.indexOf("@");
    // Keep the first @ and drop any later ones.
    return at < 0 ? s : s.slice(0, at + 1) + s.slice(at + 1).replace(/@/g, "");
  }
  return raw
    .replace(/\r/g, "")
    .replace(disallowed(o, "gu"), "")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \n]/, "");
}

/** The first character `typedText` would drop, so the box can say why. */
export const blockedChar = (raw: string, o: TextOpts): string | undefined =>
  o.email
    ? (raw.replace(/\s/g, "").match(disallowed(o, "u"))?.[0] ?? (raw.split("@").length > 2 ? "@" : undefined))
    : raw.match(disallowed(o, "u"))?.[0];

/** Why a box refused `ch`, in her words. */
export function blockedMessage(v: ValidationMessages, ch: string, o: TextOpts): string {
  if (o.email) return ch === "@" ? v.emailOneAt : v.blockedEmail(ch, allowedPunct(o));
  if (ARABIC.test(ch)) return v.blockedArabic;
  return (o.person ? v.blockedName : v.blocked)(ch, allowedPunct(o));
}

/**
 * What a filtered box keeps of a keystroke or paste, and the note saying what
 * was dropped or cut, so a lost character never looks like a broken keyboard.
 */
export function typedInput(v: ValidationMessages, raw: string, o: TextOpts, max: number) {
  const bad = blockedChar(raw, o);
  const clean = typedText(raw, o);
  return {
    value: clean.slice(0, max),
    note: bad ? blockedMessage(v, bad, o) : clean.length > max ? v.cut(max) : null,
  };
}

/** The blocked-character message for `value`, if any character is. */
const blockedIn = (v: ValidationMessages, value: string, o: TextOpts) => {
  const bad = blockedChar(value, o);
  return bad ? blockedMessage(v, bad, o) : undefined;
};

// ------------------------------------------------------- catalogue & packs ---

/** Name and description limits for everything sold: services, add-ons, packs. */
export const NAME_MAX = 30;
export const DESC_MAX = 100;

/**
 * The Arabic box must hold Arabic, except when it matches the English one:
 * that is how brand terms ("BIAB") and seeded rows are kept, and the amber
 * "missing Arabic" note already flags them.
 */
export const arScript = (ar: string, en: string): Script | undefined =>
  ar.trim() === en.trim() ? undefined : "ar";

// -------------------------------------------------------------- customers ---

export const PERSON_TEXT: TextOpts = { script: "any", person: true };
export const PERSON_NAME_MAX = 50; // room for a full Arabic name with bin/bint
export const NOTES_TEXT: TextOpts = { script: "any", long: true, multiline: true };
export const NOTES_MAX = 500;
export const EMAIL_TEXT: TextOpts = { script: "en", email: true };
export const EMAIL_MAX = 100;

/**
 * Filter a mobile box as it is typed: digits (Arabic-Indic become Latin) and a
 * leading +, so every paste shape lib/phone.ts understands still fits.
 */
export const typedPhone = (raw: string) => {
  const latin = latinDigits(raw);
  return ((/^\s*\+/.test(latin) ? "+" : "") + latin.replace(/\D/g, "")).slice(0, 15);
};

/**
 * A free-text reason or note: a cancellation, a no-show, a gift card message.
 * Letters required, no keyboard mash, no stray symbols, line breaks allowed.
 */
export function checkNote(
  v: ValidationMessages,
  label: string,
  value: string,
  o: { required?: boolean; max: number },
): string | undefined {
  return (
    blockedIn(v, value, NOTES_TEXT) ??
    rules(v).text(label, value, { required: o.required ?? true, max: o.max, script: "any" })
  );
}

/** A person's name: letters, spaces and - ' . only, no mash. Shared by every form that takes one. */
export function checkPersonName(
  v: ValidationMessages,
  label: string,
  value: string,
  o: { required?: boolean } = {},
): string | undefined {
  return (
    blockedIn(v, value, PERSON_TEXT) ??
    rules(v).text(label, value, { required: o.required ?? true, min: 2, max: PERSON_NAME_MAX, script: "any" })
  );
}

/** An email address: allowed characters, a real shape, not keyboard mash. */
export function checkEmail(
  v: ValidationMessages,
  label: string,
  value: string,
  o: { required?: boolean } = {},
): string | undefined {
  return blockedIn(v, value, EMAIL_TEXT) ?? rules(v).email(label, value, { required: o.required, max: EMAIL_MAX });
}

/**
 * The range a birthday may fall in, as YYYY-MM-DD: at most 100 years back, and
 * yesterday at the latest, since nobody booking a salon was born today.
 */
export const birthdayRange = (today: string) => ({
  earliest: shiftYears(today, -100),
  latest: new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10),
});

/**
 * An optional YYYY-MM-DD birthday inside `birthdayRange` of `today` (the
 * Riyadh date key). `fmt` shows the limit to her.
 */
export function checkBirthday(
  v: ValidationMessages,
  label: string,
  value: string,
  today: string,
  fmt: (key: string) => string = (k) => k,
): string | undefined {
  if (!value) return;
  const { earliest, latest } = birthdayRange(today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) return v.required(label);
  if (value > latest) return v.future(label);
  if (value < earliest) return v.notBefore(label, fmt(earliest));
}

export const CANCEL_REASON_MAX = 200;
export const NO_SHOW_NOTE_MAX = 500;
export const GIFT_MESSAGE_MAX = 300;

/** Shared by the customer drawer and updateCustomer, so the two agree. */
export function checkCustomer(
  t: Pick<AdminStrings, "validation" | "customers">,
  c: { name: string; phone: string; email: string; notes: string },
): Errors {
  const { validation: v, customers: l } = t;
  const phone = validateSaudiMobile(c.phone);
  return collect({
    name: checkPersonName(v, l.name, c.name),
    phone: phone === "required" ? v.required(l.phone) : phone && v.mobile(l.phone),
    email: checkEmail(v, l.email, c.email),
    notes: checkNote(v, l.notes, c.notes, { required: false, max: NOTES_MAX }),
  });
}

// ------------------------------------------------------------------ staff ---

export const PASSWORD_MIN = 8;
// bcrypt reads only the first 72 bytes; anything past that would be typed and
// silently ignored at sign-in.
export const PASSWORD_MAX = 72;

/** Shared by the staff drawer and saveStaff. A person, their sign-in, a mobile if any. */
export function checkStaff(
  t: Pick<AdminStrings, "validation" | "staff">,
  s: { name: string; email: string; phone: string; password: string; isNew: boolean },
): Errors {
  const { validation: v, staff: l } = t;
  const phone = s.phone.trim() ? validateSaudiMobile(s.phone) : null;
  const bytes = new TextEncoder().encode(s.password).length;
  return collect({
    name: checkPersonName(v, l.name, s.name),
    // Her sign-in, so never optional.
    email: checkEmail(v, l.email, s.email, { required: true }),
    phone: phone && v.mobile(l.phone),
    // Blank keeps the current password on an edit; a new account needs one.
    password: !s.password
      ? s.isNew && l.passwordRequired
      : s.password.length < PASSWORD_MIN
        ? v.tooShort(l.password, PASSWORD_MIN)
        : bytes > PASSWORD_MAX
          ? v.tooLong(l.password, PASSWORD_MAX)
          : /^\s|\s$/.test(s.password)
            ? v.passwordEdges
            : !(/\p{L}/u.test(s.password) && /\d/.test(s.password)) && v.passwordWeak,
  });
}

/**
 * A day off, from today onwards. Leave is booked to keep work off someone's
 * day; a past date keeps nothing off anything, and would quietly rewrite what
 * the attendance record says happened. Today itself is allowed, for a morning
 * sick call. An empty end means the one day. `today` is the Riyadh date key.
 */
export function checkTimeOff(
  t: Pick<AdminStrings, "validation" | "staff">,
  d: { from: string; to: string },
  today: string,
  fmt: (key: string) => string = (k) => k,
): Errors {
  const { validation: v, staff: l } = t;
  return collect({
    from: !d.from ? v.required(l.from) : d.from < today && l.dayOffPast(l.from, fmt(today)),
    to: d.from && d.to && d.to < d.from && l.badRange,
  });
}

// ------------------------------------------------------------ availability ---
// Shared by the page and its server actions, so the two can never disagree.

export const CHAIR_TEXT: TextOpts = { script: "any" };
export const CHAIR_MAX = 20;

/**
 * A chair is a number from 1 to 99 ("3") or a short name ("VIP", "Special 2").
 * Digits-only labels skip the letters rule — the seeded chairs are "1" to "4".
 */
export function checkChairLabel(
  t: Pick<AdminStrings, "validation" | "availability">,
  raw: string,
  taken: string[],
): string | undefined {
  const label = raw.trim();
  const blocked = blockedIn(t.validation, label, CHAIR_TEXT);
  if (blocked) return blocked;
  if (/^\d+$/.test(label)) {
    const n = Number(label);
    if (n < 1 || n > 99) return t.availability.stationNumber;
  } else {
    const msg = rules(t.validation).text(t.availability.stationLabel, label, { max: CHAIR_MAX, script: "any" });
    if (msg) return msg;
  }
  // Case-insensitive: "vip" beside "VIP" is two stickers nobody can tell apart.
  if (taken.some((x) => x.trim().toLowerCase() === label.toLowerCase()))
    return t.availability.stationTaken(label);
}

/** A year back (for the record), two years ahead, 90 days at most. */
export const CLOSURE_LIMITS = { backYears: 1, aheadYears: 2, maxDays: 90, reasonMax: 120 };
export const CLOSURE_TEXT: TextOpts = { script: "any", long: true };

const DAY_MS = 86_400_000;
// Calendar years, not 365-day blocks — a leap year would otherwise make "two
// years ahead" end a day early.
const shiftYears = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

/** The earliest and latest day a closure may touch, as YYYY-MM-DD. */
export const closureWindow = (today: string) => ({
  earliest: shiftYears(today, -CLOSURE_LIMITS.backYears),
  latest: shiftYears(today, CLOSURE_LIMITS.aheadYears),
});

/**
 * `today` is the Riyadh date key (lib/time `riyadhDateKey`); `fmt` turns a date
 * key into what she reads in the message.
 */
export function checkClosure(
  t: Pick<AdminStrings, "validation" | "availability">,
  c: { from: string; to: string; reason: string },
  today: string,
  fmt: (key: string) => string = (k) => k,
): Errors {
  const { validation: v, availability: a } = t;
  const { earliest, latest } = closureWindow(today);
  const days = Math.round((Date.parse(c.to) - Date.parse(c.from)) / DAY_MS) + 1;

  return collect({
    from: !c.from
      ? v.required(a.from)
      : c.from < earliest
        ? a.closureTooOld(a.from, fmt(earliest))
        : c.from > latest && a.closureTooFar(a.from, fmt(latest)),
    to: !c.to
      ? v.required(a.to)
      : c.to > latest
        ? a.closureTooFar(a.to, fmt(latest))
        : c.from && c.to < c.from
          ? v.notBefore(a.to, a.from)
          : c.from && days > CLOSURE_LIMITS.maxDays && a.closureTooLong(CLOSURE_LIMITS.maxDays, days),
    reason:
      blockedIn(v, c.reason, CLOSURE_TEXT) ??
      rules(v).text(a.reason, c.reason, { max: CLOSURE_LIMITS.reasonMax, script: "any" }),
  });
}

/** Keep only the fields that failed. */
export function collect(checks: Record<string, string | undefined | null | false>): Errors {
  return Object.fromEntries(Object.entries(checks).filter(([, m]) => m)) as Errors;
}

export const hasErrors = (e: Errors) => Object.keys(e).length > 0;

/**
 * After a refused save, put the cursor in the first box that needs fixing.
 * Focusing scrolls it into view, which matters in a long drawer where the
 * mistake is above the fold and the Save button is below it.
 */
export function focusFirstInvalid() {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
  );
}
