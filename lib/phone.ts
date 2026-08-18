// Saudi mobile number rules.
//
// Pure and dependency-free, like lib/card.ts — the same rules run in the form
// and can be unit-tested, so what the customer is allowed to type and what the
// server accepts can't drift apart.
//
// A Saudi mobile is 9 national digits beginning with 5. The country code is
// fixed at +966 in the UI rather than typed, which removes the whole class of
// "did they mean 05…, 5…, +9665… or 009665…" ambiguity at the source.
//
// **Stored form is `05XXXXXXXX`.** That is deliberate and load-bearing:
// `customers.phone` is the unique key a returning customer is matched on, and
// existing rows are in that format. Submitting +966 instead would fail to match
// them and quietly create a second customer for the same person, splitting their
// history. So the prefix is presentation; the wire format is unchanged.

/** Shown, fixed, in the UI. Never typed and never submitted. */
export const SAUDI_DIALLING_CODE = "+966";

/** Digits after the country code. 5XXXXXXXX. */
export const NATIONAL_LENGTH = 9;

/**
 * Whatever was typed or pasted → the 9 national digits, at most.
 *
 * Tolerates the shapes people actually paste: +966 5x, 00966 5x, 0 5x, spaces
 * and dashes. Trailing digits past 9 are dropped rather than silently reordered.
 */
export function toNationalDigits(input: string): string {
  let d = input.replace(/\D/g, "");
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  // A single leading zero is the national trunk prefix, not part of the number.
  if (d.startsWith("0")) d = d.slice(1);
  return d.slice(0, NATIONAL_LENGTH);
}

export type PhoneError = "required" | "length" | "prefix";

export function validateSaudiMobile(national: string): PhoneError | null {
  const d = toNationalDigits(national);
  if (!d) return "required";
  if (d.length !== NATIONAL_LENGTH) return "length";
  // Every Saudi mobile starts with 5; 01x–04x are landlines and can't receive
  // the SMS or WhatsApp this number exists for.
  if (!d.startsWith("5")) return "prefix";
  return null;
}

export const isValidSaudiMobile = (national: string): boolean =>
  validateSaudiMobile(national) === null;

/**
 * The form the database and the API expect: `05XXXXXXXX`.
 * See the header — this must stay the stored shape.
 */
export function toStoredPhone(national: string): string {
  return `0${toNationalDigits(national)}`;
}

/** "5X XXX XXXX" — grouped only for reading; never submitted like this. */
export function formatNational(national: string): string {
  const d = toNationalDigits(national);
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 9)].filter(Boolean);
  return parts.join(" ");
}
