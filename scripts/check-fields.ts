// Input field boundary checks — card and phone.
//
//   npm run check:fields
//
// Pure — no database, no network. lib/card.ts holds the rules the checkout form
// enforces, so these are the boundaries themselves, not a mock of them.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import {
  brandOf,
  cvvLength,
  formatCardNumber,
  formatExpiry,
  luhnValid,
  validateCard,
  validateCardNumber,
  validateCvv,
  validateExpiry,
} from "@/lib/card";
import { refillDaysLeft, refillWindowEnd } from "@/lib/refill";
import { SETTING_DEFAULTS, pickSettings } from "@/lib/settings";
import { closureDays } from "@/lib/time";
import {
  formatNational,
  toNationalDigits,
  toStoredPhone,
  validateSaudiMobile,
} from "@/lib/phone";

// -- number ------------------------------------------------------------------

// Well-known test numbers, all Luhn-valid.
for (const n of [
  "4111111111111111", // Visa
  "5555555555554444", // Mastercard
  "378282246310005", // Amex (15 digits)
  "4242424242424242",
]) {
  assert.ok(luhnValid(n), `${n} should pass Luhn`);
  assert.equal(validateCardNumber(n), null, `${n} should be accepted`);
}

// One transposed digit must be caught — the whole point of the checksum.
assert.equal(validateCardNumber("4111111111111112"), "card-checksum");
assert.equal(validateCardNumber(""), "required");
assert.equal(validateCardNumber("411111"), "card-length");
// 20 digits is past every scheme's maximum.
assert.equal(validateCardNumber("4".repeat(20)), "card-length");
console.log("  number: length + Luhn ✓");

assert.equal(brandOf("4111111111111111"), "visa");
assert.equal(brandOf("5555555555554444"), "mastercard");
assert.equal(brandOf("2221000000000009"), "mastercard"); // 2-series
assert.equal(brandOf("378282246310005"), "amex");
assert.equal(formatCardNumber("4111111111111111"), "4111 1111 1111 1111");
// Amex groups 4-6-5, not 4-4-4-4.
assert.equal(formatCardNumber("378282246310005"), "3782 822463 10005");
console.log("  number: brand detection + grouping ✓");

// -- cvv ---------------------------------------------------------------------

assert.equal(cvvLength("4111111111111111"), 3);
assert.equal(cvvLength("378282246310005"), 4, "Amex prints a 4-digit code");
assert.equal(validateCvv("123", "4111111111111111"), null);
assert.equal(validateCvv("12", "4111111111111111"), "cvv-length");
assert.equal(validateCvv("1234", "4111111111111111"), "cvv-length", "3-digit card, 4 given");
assert.equal(validateCvv("1234", "378282246310005"), null, "Amex takes 4");
assert.equal(validateCvv("123", "378282246310005"), "cvv-length");
assert.equal(validateCvv("", "4111111111111111"), "required");
console.log("  cvv: length follows the brand ✓");

// -- expiry ------------------------------------------------------------------

const now = new Date("2026-08-18T00:00:00Z");

assert.equal(validateExpiry("09/26", now), null);
// A card is good through the last day of its printed month.
assert.equal(validateExpiry("08/26", now), null, "expiring this month is still valid today");
assert.equal(validateExpiry("07/26", now), "expiry-past");
assert.equal(validateExpiry("12/25", now), "expiry-past");

assert.equal(validateExpiry("00/30", now), "expiry-month");
assert.equal(validateExpiry("13/30", now), "expiry-month");
assert.equal(validateExpiry("99/30", now), "expiry-month");

assert.equal(validateExpiry("", now), "required");
assert.equal(validateExpiry("8/26", now), "expiry-format");
assert.equal(validateExpiry("08/2026", now), "expiry-format");
// A mistyped year rather than a real 50-year card.
assert.equal(validateExpiry("08/99", now), "expiry-far");

assert.equal(formatExpiry("0826"), "08/26");
assert.equal(formatExpiry("08"), "08");
assert.equal(formatExpiry("08/26"), "08/26", "reformatting is idempotent");
console.log("  expiry: month bounds, past, and far-future ✓");

// -- whole form --------------------------------------------------------------

assert.deepEqual(
  validateCard({ number: "4111111111111111", name: "Sarah A", expiry: "09/28", cvv: "123" }, now),
  {},
  "a good card must produce no errors",
);

const bad = validateCard({ number: "4111111111111112", name: "", expiry: "13/20", cvv: "1" }, now);
assert.equal(bad.number, "card-checksum");
assert.equal(bad.name, "required");
// Month is checked before the past, so an impossible month says so.
assert.equal(bad.expiry, "expiry-month");
assert.equal(bad.cvv, "cvv-length");
console.log("  form: every field reports its own reason ✓");

// -- phone -------------------------------------------------------------------

// Every shape a person might paste must land on the same 9 national digits.
for (const input of [
  "0512345678",
  "512345678",
  "+966512345678",
  "966512345678",
  "00966512345678",
  "+966 51 234 5678",
  "051-234-5678",
]) {
  assert.equal(toNationalDigits(input), "512345678", `${input} should normalise`);
}

assert.equal(validateSaudiMobile("512345678"), null);
assert.equal(validateSaudiMobile(""), "required");
assert.equal(validateSaudiMobile("51234567"), "length", "8 digits is short");
// Overlong input is truncated to 9 digits first, so it is judged on what the
// field actually shows — "4512345678" becomes "451234567" and fails on prefix.
// The customer sees the truncated value in the field, so nothing is silently
// accepted behind their back.
assert.equal(validateSaudiMobile("4512345678"), "prefix");
// Landlines can't receive the SMS or WhatsApp this number exists for.
assert.equal(validateSaudiMobile("112345678"), "prefix");
assert.equal(validateSaudiMobile("412345678"), "prefix");
console.log("  phone: normalises every paste shape, rejects landlines ✓");

// The stored form must stay 05… — customers.phone is the unique key a returning
// customer is matched on, and switching to +966 would split their history.
assert.equal(toStoredPhone("512345678"), "0512345678");
assert.equal(toStoredPhone("+966512345678"), "0512345678");
// Whatever the customer typed, the server's own regex has to accept the result.
const SERVER_RE = /^(\+?966|0)?5\d{8}$/;
for (const input of ["0512345678", "512345678", "+966512345678", "00966512345678"]) {
  assert.ok(SERVER_RE.test(toStoredPhone(input)), `${input} must survive to a valid stored form`);
}
assert.equal(formatNational("512345678"), "51 234 5678");
console.log("  phone: stored form stays 05… and passes the API regex ✓");

// -- refill windows ----------------------------------------------------------

const served = { startsAt: new Date("2026-08-01T10:00:00Z"), status: "completed", alreadyRefilled: false, isRefill: false };
const today = new Date("2026-08-19T12:00:00Z");

// Derived window: 30 days from the appointment.
assert.equal(refillDaysLeft({ ...served, refillDays: 30 }, today), 12);
assert.equal(refillDaysLeft({ ...served, refillDays: 14 }, today), 0, "14-day window has lapsed");
assert.equal(refillDaysLeft({ ...served, refillDays: 0 }, today), 0, "no window on this service");

// The deadline belongs to the service and nothing moves it per booking. There
// used to be an admin grant that could; it meant two customers on the same
// service holding different deadlines with nothing on screen saying why.
for (const spent of [{ alreadyRefilled: true }, { isRefill: true }]) {
  assert.equal(
    refillDaysLeft({ ...served, ...spent, refillDays: 30 }, today),
    0,
    `spent or self-refilled offers nothing: ${JSON.stringify(spent)}`,
  );
}
// An appointment that has not happened yet cannot be refilled.
assert.equal(
  refillDaysLeft(
    { ...served, startsAt: new Date("2026-12-01T10:00:00Z"), status: "confirmed", refillDays: 30 },
    today,
  ),
  0,
  "unserved bookings stay ineligible",
);
console.log("  refill: spent, self-refilled and unserved bookings offer nothing ✓");

// The deadline the picker greys out and the one the server enforces are the
// same function, so a date can never be offered and then refused.
assert.equal(
  refillWindowEnd({ ...served, refillDays: 30 })?.toISOString().slice(0, 10),
  "2026-08-31",
  "derived window ends 30 days after the appointment",
);
assert.equal(refillWindowEnd({ ...served, refillDays: 0 }), null, "no window, no deadline");

// The window bounds the APPOINTMENT, not just the moment of booking: with a
// window open today, a date past its end must still be out of bounds.
const end = refillWindowEnd({ ...served, refillDays: 30 })!;
assert.ok(refillDaysLeft({ ...served, refillDays: 30 }, today) > 0, "offer is open today");
assert.ok(new Date("2026-10-05T10:00:00Z") > end, "an October slot is past the window");
assert.ok(new Date("2026-08-25T10:00:00Z") <= end, "a slot inside the window is fine");
console.log("  refill: window bounds the appointment date, not just the booking time ✓");

// -- closures: the days the admin typed come back out ------------------------
//
// addClosure stores a Riyadh closure half-open: local midnight, to local
// midnight on the day AFTER the last closed day. Reversing that by hand has two
// separate ways to be wrong, and both were live. Truncating the +03:00
// timestamp in UTC lands a day early; printing the exclusive end lands a day
// late. On the end they cancel out, which is how a wrong line went on looking
// right.

// 20-22 March 2026, exactly as addClosure writes it.
const eidStart = new Date("2026-03-20T00:00:00+03:00");
const eidEnd = new Date("2026-03-23T00:00:00+03:00");

assert.equal(
  eidStart.toISOString(),
  "2026-03-19T21:00:00.000Z",
  "the stored instant really is on the previous UTC day",
);
assert.deepEqual(
  closureDays(eidStart, eidEnd),
  { from: "2026-03-20", to: "2026-03-22" },
  "a closure reads back as the days it was entered as",
);

// One day, where an exclusive end is easiest to get wrong.
assert.deepEqual(
  closureDays(new Date("2026-03-20T00:00:00+03:00"), new Date("2026-03-21T00:00:00+03:00")),
  { from: "2026-03-20", to: "2026-03-20" },
  "a one-day closure starts and ends on that day",
);
console.log("  closures: a stored range reads back as the days the admin typed ✓");

// Settings now arrive as the whole table rather than the keys asked for — one
// cached read serving every caller (docs/PERFORMANCE.md). The merge is what
// keeps that safe: a key with no stored row must fall back to its default, and
// a wrong lookup here would silently give the salon 0% VAT rather than an error.

assert.deepEqual(
  pickSettings([{ key: "vat_percent", value: 5 }], ["vat_percent"]),
  { vat_percent: 5 },
  "a stored row wins over the default",
);
assert.deepEqual(
  pickSettings([{ key: "vat_percent", value: 5 }], ["no_show_grace_min"]),
  { no_show_grace_min: SETTING_DEFAULTS.no_show_grace_min },
  "a key with no row falls back to its default, not to undefined",
);
assert.deepEqual(
  pickSettings([], ["vat_percent", "currency"]),
  { vat_percent: SETTING_DEFAULTS.vat_percent, currency: SETTING_DEFAULTS.currency },
  "an empty table is all defaults",
);
assert.deepEqual(
  // The whole table is passed in now, so unrelated rows must not confuse the pick.
  pickSettings(
    [
      { key: "currency", value: "USD" },
      { key: "vat_percent", value: 20 },
      { key: "timezone", value: "Europe/Berlin" },
    ],
    ["vat_percent"],
  ),
  { vat_percent: 20 },
  "the right row is picked out of a full table",
);
assert.deepEqual(
  pickSettings([{ key: "vat_percent", value: 0 }], ["vat_percent"]),
  { vat_percent: 0 },
  "a stored zero is a value, not a missing row",
);
console.log("  settings: stored rows win, missing keys fall back to defaults ✓");

console.log("\nAll field boundary checks passed.");
