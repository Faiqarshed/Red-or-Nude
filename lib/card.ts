// Card field rules for the checkout form.
//
// Pure and dependency-free, like lib/refill.ts — no React, no `server-only` — so
// the rules can be unit-tested and can never drift from what the form enforces.
//
// These are *input* boundaries, not authorisation. Nothing here proves a card is
// real or has funds; it catches typos before the customer is told "declined" by
// a gateway, which is the only thing client-side card validation can honestly do.
//
// Note on scope: these fields are currently display-only — nothing is posted to
// our server, and it must stay that way. A real gateway (Moyasar, Tap) collects
// the PAN in its own hosted iframe precisely so card data never touches our
// origin and we stay out of PCI scope. When one lands, this file validates what
// the customer sees; the gateway still re-validates everything.

/** Longest run of digits any scheme uses, plus the three grouping spaces. */
export const CARD_NUMBER_MAX = 19;

export type CardBrand = "visa" | "mastercard" | "amex" | "mada" | "unknown";

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Visa 4…, Mastercard 51-55 / 2221-2720, Amex 34 & 37. Enough to size the CVV. */
export function brandOf(number: string): CardBrand {
  const n = digitsOnly(number);
  if (/^4/.test(n)) return "visa";
  if (/^3[47]/.test(n)) return "amex";
  if (/^5[1-5]/.test(n)) return "mastercard";
  if (/^2(2[2-9]|[3-6]\d|7[01]|720)/.test(n)) return "mastercard";
  return "unknown";
}

/** Amex prints a 4-digit code on the front; everyone else uses 3 on the back. */
export function cvvLength(number: string): 3 | 4 {
  return brandOf(number) === "amex" ? 4 : 3;
}

/** "4111111111111111" → "4111 1111 1111 1111"; Amex groups 4-6-5. */
export function formatCardNumber(value: string): string {
  const n = digitsOnly(value).slice(0, CARD_NUMBER_MAX);
  const groups = brandOf(n) === "amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];

  const out: string[] = [];
  let i = 0;
  for (const size of groups) {
    if (i >= n.length) break;
    out.push(n.slice(i, i + size));
    i += size;
  }
  return out.join(" ");
}

/**
 * The Luhn checksum every card number carries. Catches a single mistyped digit
 * and most transpositions — the reason a typo can be caught before the gateway
 * is involved at all.
 */
export function luhnValid(number: string): boolean {
  const n = digitsOnly(number);
  if (n.length < 12) return false;

  let sum = 0;
  let double = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export type FieldError =
  | "required"
  | "card-length"
  | "card-checksum"
  | "expiry-format"
  | "expiry-month"
  | "expiry-past"
  | "expiry-far"
  | "cvv-length"
  | "name-short";

export function validateCardNumber(value: string): FieldError | null {
  const n = digitsOnly(value);
  if (!n) return "required";
  // 13 (older Visa) through 19 (some Mada and co-badged cards).
  if (n.length < 13 || n.length > CARD_NUMBER_MAX) return "card-length";
  if (!luhnValid(n)) return "card-checksum";
  return null;
}

export function validateCardName(value: string): FieldError | null {
  const v = value.trim();
  if (!v) return "required";
  if (v.length < 2) return "name-short";
  return null;
}

/** "MM/YY" or "MMYY". Rejects month 00 and 13+, the past, and typo-far futures. */
export function validateExpiry(value: string, now: Date = new Date()): FieldError | null {
  const n = digitsOnly(value);
  if (!n) return "required";
  if (n.length !== 4) return "expiry-format";

  const month = Number(n.slice(0, 2));
  const year = 2000 + Number(n.slice(2));
  if (month < 1 || month > 12) return "expiry-month";

  // A card is good through the last day of its printed month, so compare months
  // rather than days — a card expiring this month is still valid today.
  const nowMonths = now.getFullYear() * 12 + now.getMonth();
  const cardMonths = year * 12 + (month - 1);
  if (cardMonths < nowMonths) return "expiry-past";

  // Nobody is issued a card 20 years out; this is a mistyped year.
  if (cardMonths > nowMonths + 20 * 12) return "expiry-far";
  return null;
}

/** "12/34" as the customer types — the slash appears on its own. */
export function formatExpiry(value: string): string {
  const n = digitsOnly(value).slice(0, 4);
  return n.length <= 2 ? n : `${n.slice(0, 2)}/${n.slice(2)}`;
}

export function validateCvv(value: string, cardNumber: string): FieldError | null {
  const n = digitsOnly(value);
  if (!n) return "required";
  if (n.length !== cvvLength(cardNumber)) return "cvv-length";
  return null;
}

export type CardInput = { number: string; name: string; expiry: string; cvv: string };
export type CardErrors = Partial<Record<keyof CardInput, FieldError>>;

/** Every field at once. Empty object means the form may be submitted. */
export function validateCard(card: CardInput, now: Date = new Date()): CardErrors {
  const errors: CardErrors = {};
  const number = validateCardNumber(card.number);
  const name = validateCardName(card.name);
  const expiry = validateExpiry(card.expiry, now);
  const cvv = validateCvv(card.cvv, card.number);

  if (number) errors.number = number;
  if (name) errors.name = name;
  if (expiry) errors.expiry = expiry;
  if (cvv) errors.cvv = cvv;
  return errors;
}
