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
import { z } from "zod";
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
import { closureDays } from "@/lib/time";
import {
  formatNational,
  toNationalDigits,
  toStoredPhone,
  validateSaudiMobile,
} from "@/lib/phone";
import { adminStrings } from "@/lib/admin/strings";
import { emailField, nameField } from "@/lib/account/fields";
import {
  allowedPunct,
  blockedChar,
  checkChairLabel,
  checkClosure,
  checkCustomer,
  checkNote,
  checkPersonName,
  checkStaff,
  checkTimeOff,
  checkBirthday,
  collect,
  EMAIL_TEXT,
  NOTES_TEXT,
  typedPhone,
  PERSON_TEXT,
  hasErrors,
  numeric,
  rules,
  typedText,
} from "@/lib/admin/validate";

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
  "٠٥١٢٣٤٥٦٧٨",
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

// -- admin form checks -------------------------------------------------------

{
  const r = rules(adminStrings.en.validation);
  const errors = collect({
    name: r.text("Name", "   "),
    desc: r.text("Description", "", { required: false, max: 400 }),
    code: r.text("Code", "AB", { min: 3 }),
    price: r.number("Price", "-1", { min: 0 }),
    days: r.number("Days", "1.5", { int: true, min: 1 }),
    value: r.number("Value", 0, { positive: true }),
    uses: r.number("Uses", null, { required: false, min: 1 }),
    email: r.email("Email", "not-an-email"),
    optionalEmail: r.email("Email", ""),
    branch: false,
  });
  assert.deepEqual(errors, {
    name: "Name is required",
    code: "Code needs at least 3 characters",
    price: "Price must be at least 0",
    days: "Days must be a whole number",
    value: "Value must be more than 0",
    email: "Email needs an @, like name@example.com",
  });
  assert.equal(hasErrors(errors), true);
  assert.equal(r.number("Price", "100000", { min: 0, max: 100_000 }), undefined, "the limit itself is allowed");
  assert.equal(r.number("Price", "100001", { max: 100_000 }), "Price can't be more than 100,000");
  assert.equal(hasErrors(collect({ a: undefined, b: "" })), false, "passing fields are dropped");

  // Catalogue names: script, letters, decimals.
  assert.equal(r.text("Name (Arabic)", "wefr434", { script: "ar" }), "Name (Arabic) must be written in Arabic letters, or match the English name exactly for a brand term like BIAB");
  assert.equal(r.text("Name (Arabic)", "مانيكير 2", { script: "ar" }), undefined);
  assert.equal(r.text("Name (English)", "Gel جل", { script: "en" }), "Name (English) must be in English, but it contains Arabic letters");
  assert.equal(r.text("Name (English)", "12345", { script: "en" }), "Name (English) must contain letters, not only numbers or symbols");
  assert.equal(r.number("Price", "99.505", { decimals: 2 }), "Price can have at most 2 decimal places (e.g. 99.50)");
  assert.equal(r.number("Price", "99.5", { decimals: 2 }), undefined);

  // Number boxes filter what is typed.
  assert.equal(numeric("023453245643565", { maxDigits: 6, decimals: 2 }), "234532");
  assert.equal(numeric("12.345.6", { maxDigits: 6, decimals: 2 }), "12.34");
  assert.equal(numeric(".5", { maxDigits: 6, decimals: 2 }), "0.5");
  assert.equal(numeric("-1e5", { maxDigits: 3 }), "15");
  assert.equal(numeric("٤٥", { maxDigits: 3 }), "45", "Arabic-Indic digits become Latin");
  assert.equal(numeric("0", { maxDigits: 3 }), "0", "a lone zero stays");
  assert.equal(numeric("", { maxDigits: 3 }), "");

  // Keyboard mash.
  assert.equal(
    r.text("Name", "Gellll Polish", { script: "en" }),
    'Name: "Gellll" has the same letter 3 times in a row. Please check the spelling.',
    "the offending word is quoted",
  );
  assert.equal(
    r.text("Name", "Cat wefrtrhgfr", { script: "en" }),
    'Name: "wefrtrhgfr" doesn\'t look like a real word. Please check the spelling.',
  );
  for (const ok of ["Classic Manicure", "BIAB", "French Tip", "Lash Extensions", "Art 1", "Nail Art 1000"]) {
    assert.equal(r.text("Name", ok, { script: "en" }), undefined, `${ok} is a real name`);
  }

  // Text boxes filter what is typed.
  assert.equal(typedText("Cat 😺 Eye#", { script: "en" }), "Cat Eye");
  assert.equal(typedText("  Gel   Polish", { script: "en" }), "Gel Polish");
  assert.equal(typedText("جل Gel", { script: "en" }), "Gel", "English box drops Arabic");
  assert.equal(typedText("BIAB بياب", { script: "ar" }), "BIAB بياب", "Arabic box keeps brand terms");
  assert.equal(typedText("SHAPING | BUFFING, CARE!", { script: "en", long: true }), "SHAPING | BUFFING, CARE!");
  assert.equal(typedText("SHAPING | BUFFING", { script: "en" }), "SHAPING BUFFING", "names don't take |");

  // …and can name what they dropped.
  assert.equal(blockedChar("Cat #Eye", { script: "en" }), "#");
  assert.equal(blockedChar("Cat 😺", { script: "en" }), "😺", "an emoji is one character, not half of one");
  assert.equal(blockedChar("French Tip (2)", { script: "en" }), undefined);
  assert.equal(allowedPunct({ script: "en" }), "- & ' . ( ) /");
  // Signed amounts (gift card adjustments): one leading minus, nothing else.
  assert.equal(numeric("-50", { maxDigits: 5, decimals: 2, signed: true }), "-50");
  assert.equal(numeric("5-0", { maxDigits: 5, decimals: 2, signed: true }), "50", "a minus in the middle is dropped");
  assert.equal(numeric("--12.345e", { maxDigits: 5, decimals: 2, signed: true }), "-12.34");
  assert.equal(numeric("-", { maxDigits: 5, signed: true }), "-", "a lone minus survives so she can keep typing");
  assert.equal(numeric("-50", { maxDigits: 5 }), "50", "unsigned boxes never take a minus");

  // Customers: a real name, a Saudi mobile, a real email if any, notes that keep their lines.
  const customer = (name: string, notes = "", phone = "0555000111", email = "") =>
    checkCustomer(adminStrings.en, { name, phone, email, notes });
  assert.deepEqual(customer("Noura Al-Qahtani", "Prefers\nmornings", "+966 55 500 0111", "noura@example.com"), {});
  assert.deepEqual(customer("نورة بنت عبدالله القحطاني"), {}, "a full Arabic name fits");
  assert.equal(customer("Noura", "", "").phone, "Mobile is required");
  assert.equal(customer("Noura", "", "0112345678").phone, "Mobile must be a Saudi mobile: 05 followed by 8 digits", "landline");
  assert.equal(customer("Noura", "", "05550001").phone, "Mobile must be a Saudi mobile: 05 followed by 8 digits", "too short");
  assert.equal(typedPhone("+966 55-500 0111"), "+966555000111");
  assert.equal(typedPhone("٠٥٥٥abc٠٠٠١١١"), "0555000111", "Arabic-Indic digits become Latin");
  assert.equal(typedPhone("05+55"), "0555", "a plus only counts in front");
  assert.equal(customer("Noura", "", "0555000111", "noura@").email, "Email is missing the domain after the @, like example.com");

  // Email shapes: each common mistake names itself; EMAIL_RE catches the rest.
  const mail = (s: string) => r.email("Email", s, { max: 100 });
  for (const ok of [
    "noura@example.com",
    "n.al-qahtani+vip@mail.redornude.sa",
    "a@x.co",
    "a_b@x.museum",
    "a@sub.x-y.com",
    "noura_@x.com",
    // Real shapes the mash checks must leave alone.
    "noura1995@gmail.com",
    "ahmed.q8.1990@hotmail.com",
    "0555123456@gmail.com",
    "966555123456@icloud.com",
    "sara.2024@outlook.sa",
    "faiq.arshed@airbridgedevs.com",
    "m.schmidt@web.de",
    // Handles she picked on purpose.
    "nouraaa@gmail.com",
    "noura2k24@gmail.com",
    "noura19951995@gmail.com",
    "princess.n0ura@hotmail.com",
    "xx.noura.xx@gmail.com",
  ]) {
    assert.equal(mail(ok), undefined, `${ok} is a real address`);
    // Never looser than the public APIs' zod check, or a saved address couldn't sign in.
    assert.ok(z.string().email().safeParse(ok).success, `${ok} must also pass zod`);
  }
  for (const [bad, why] of [
    ["noura.example.com", "Email needs an @, like name@example.com"],
    ["@example.com", "Email is missing the part before the @"],
    ["noura@example", "Email is missing the domain after the @, like example.com"],
    [".noura@x.com", "Email can't start or end with a dot before the @, or have two dots in a row"],
    ["noura.@x.com", "Email can't start or end with a dot before the @, or have two dots in a row"],
    ["no..ura@x.com", "Email can't start or end with a dot before the @, or have two dots in a row"],
    ["noura@x.c", "Email must end in letters after the last dot, like .com or .sa"],
    ["noura@x.c0m", "Email must end in letters after the last dot, like .com or .sa"],
    ["noura@x.com.", "Email must end in letters after the last dot, like .com or .sa"],
    ["noura@x-.com", "Email isn't a valid email address (e.g. name@example.com)"],
    ["noura@-x.com", "Email isn't a valid email address (e.g. name@example.com)"],
    ["noura@x..com", "Email isn't a valid email address (e.g. name@example.com)"],
    ["noura@.x.com", "Email isn't a valid email address (e.g. name@example.com)"],
    ["_noura@x.com", "Email isn't a valid email address (e.g. name@example.com)"],
    ["no%ura@x.com", "Email isn't a valid email address (e.g. name@example.com)"],
    // Well-formed, but mash.
    ["uygt76t879708770979678687@gmail.com", 'Email: "uygt76t879708770979678687" doesn\'t look like a real email. Please check it.'],
    ["a1b2c3@gmail.com", 'Email: "a1b2c3" doesn\'t look like a real email. Please check it.'],
    ["sdfghjk@gmail.com", 'Email: "sdfghjk" doesn\'t look like a real email. Please check it.'],
    ["8237492384923@gmail.com", 'Email: "8237492384923" doesn\'t look like a real email. Please check it.'],
    ["noura@sdfghj.com", 'Email: "sdfghj.com" doesn\'t look like a real email. Please check it.'],
    [`${"a".repeat(65)}@x.com`, "Email can't be longer than 64 characters"],
  ] as const) {
    assert.equal(mail(bad), why, bad);
  }
  assert.equal(customer("Noura", "", "0555000111", "noura@x@y.com").email, "An email address has only one @");
  assert.equal(typedText("نورة#noura@@ex@ample.com ", EMAIL_TEXT), "noura@example.com");
  assert.equal(blockedChar(" noura@x.com ", EMAIL_TEXT), undefined, "spaces go quietly");
  assert.equal(customer("").name, "Name is required");
  assert.equal(customer("Noura2").name, `"2" can't be used in a name. Allowed: letters, spaces and - ' .`);
  assert.equal(customer("Sdfghjk").name, 'Name: "Sdfghjk" doesn\'t look like a real word. Please check the spelling.');
  assert.equal(customer("Noura", "VIP 😀").notes, `"😀" can't be used here. Allowed: letters, numbers and - & ' . ( ) / , | : + ! % ، ؟`);
  assert.equal(typedText("a\r\n\n\n\nb", NOTES_TEXT), "a\n\nb", "runs of blank lines collapse to one");

  assert.equal(typedText("Noura 2", PERSON_TEXT), "Noura ", "digits never land in a name");

  // Staff: a person, a required sign-in email, an optional mobile, a real password.
  const member = (o: Partial<{ name: string; email: string; phone: string; password: string; isNew: boolean }> = {}) =>
    checkStaff(adminStrings.en, { name: "Lama Al-Harbi", email: "lama@redornude.com", phone: "", password: "Salon2026", isNew: true, ...o });
  assert.deepEqual(member(), {});
  assert.deepEqual(member({ phone: "0555000111" }), {});
  assert.deepEqual(member({ password: "", isNew: false }), {}, "blank keeps the current password on an edit");
  assert.equal(member({ password: "" }).password, "A password is required for a new account");
  assert.equal(member({ email: "" }).email, "Email is required");
  assert.equal(member({ phone: "12345" }).phone, "Mobile must be a Saudi mobile: 05 followed by 8 digits");
  assert.equal(member({ password: "short1" }).password, "Password needs at least 8 characters");
  assert.equal(member({ password: "onlyletters" }).password, "Password needs at least one letter and one number");
  assert.equal(member({ password: "12345678" }).password, "Password needs at least one letter and one number");
  assert.equal(member({ password: " Salon2026" }).password, "Password can't start or end with a space");
  assert.equal(member({ password: "a1".repeat(37) }).password, "Password can't be longer than 72 characters", "bcrypt's 72-byte ceiling");
  assert.equal(member({ password: "كلمةسر2026" }).password, undefined, "Arabic letters count as letters");
  assert.equal(member({ name: "Lama (seed)" }).name, `"(" can't be used in a name. Allowed: letters, spaces and - ' .`);

  // Days off: from today onwards; today itself is fine.
  const dayOff = (from: string, to = "") => checkTimeOff(adminStrings.en, { from, to }, "2026-09-15");
  assert.deepEqual(dayOff("2026-09-15"), {}, "today, for a morning sick call");
  assert.deepEqual(dayOff("2026-09-20", "2026-09-22"), {});
  assert.equal(
    dayOff("2026-09-14").from,
    "From can't be before today (2026-09-15). Days off can only be added from today onwards.",
  );
  assert.equal(dayOff("").from, "From is required");
  assert.equal(dayOff("2026-09-22", "2026-09-20").to, "The end date is before the start date");

  // Reasons and notes: optional when asked to be, real when given, bounded.
  const v = adminStrings.en.validation;
  assert.equal(checkNote(v, "Reason", "", { required: false, max: 200 }), undefined, "an optional reason may be blank");
  assert.equal(checkNote(v, "Reason", "", { max: 500 }), "Reason is required");
  assert.equal(checkNote(v, "Reason", "Customer called\nto cancel", { max: 200 }), undefined);
  assert.equal(checkNote(v, "Reason", "Customer asked ".repeat(14), { max: 200 }), "Reason can't be longer than 200 characters");
  assert.equal(checkNote(v, "Reason", "sick 🤒", { max: 200 }), `"🤒" can't be used here. Allowed: letters, numbers and - & ' . ( ) / , | : + ! % ، ؟`);
  assert.equal(checkPersonName(v, "Name", "", { required: false }), undefined);
  assert.equal(checkPersonName(v, "Name", "Sara Al-Otaibi"), undefined);
  assert.equal(checkPersonName(v, "Name", "Sara 2"), `"2" can't be used in a name. Allowed: letters, spaces and - ' .`);

  // Blank mandatory boxes block the save, whatever their type.
  assert.equal(r.number("Price (SAR)", "", { min: 0, max: 100_000, decimals: 2 }), "Price (SAR) is required");
  assert.equal(r.number("Duration (minutes)", "   ", { int: true, min: 5, max: 600 }), "Duration (minutes) is required");
  assert.equal(r.text("Name (English)", "", { min: 2, max: 30, script: "en" }), "Name (English) is required");
  assert.equal(r.number("Price (SAR)", "0", { positive: true }), "Price (SAR) must be more than 0");

  // Chairs: a number 1–99 or a real short name, never blank, never twice.
  const chair = (label: string, taken: string[] = ["1", "2", "VIP"]) =>
    checkChairLabel(adminStrings.en, label, taken);
  assert.equal(chair("3"), undefined);
  assert.equal(chair("Special"), undefined);
  assert.equal(chair("Special 2"), undefined);
  assert.equal(chair("   "), "Label is required");
  assert.equal(chair("0"), "A chair number must be from 1 to 99");
  assert.equal(chair("124567890"), "A chair number must be from 1 to 99");
  assert.equal(chair("124567890-=';LK>Jhmgnfb"), `"=" can't be used here. Allowed: letters, numbers and - & ' . ( ) /`);
  assert.equal(chair("Jhmgnfb"), 'Label: "Jhmgnfb" doesn\'t look like a real word. Please check the spelling.');
  assert.equal(chair("vip"), `There's already a chair called "vip" in this branch. Please pick another name.`);
  assert.equal(chair(" 2 "), `There's already a chair called "2" in this branch. Please pick another name.`);
  assert.equal(chair("كرسي خاص"), undefined, "Arabic chair names are fine");

  // Mash arrives in three shapes, and all three are refused wherever a real
  // word is asked for — a run of consonants, a group drummed out, a keyboard row.
  const gibberish = (s: string) => `Label: "${s}" doesn't look like a real word. Please check the spelling.`;
  for (const junk of [
    "ergtrwfrthegrwtegrg", // consonants in a row
    "asdasdasd", "abcabcabc", // a group drummed out
    "qwertyuiop", "Zxcvbnm", "lkjhgf", "asdf", // a run along one row
    "ftgyhujhygtfr", "rtyuio", "dfghjk", // a walk across the keys
  ]) {
    assert.equal(chair(junk), gibberish(junk), `mash refused: ${junk}`);
  }
  // And the salon's own words still pass. A rule that cries wolf gets worked around.
  for (const real of ["Chair 7", "Window", "Bridal Suite", "Manicure 1", "Lounge", "B3"]) {
    assert.equal(chair(real), undefined, `a real label stays allowed: ${real}`);
  }
  // Sawsan walks s-a-w-s-a and Trewin holds "trew": both real, both must pass.
  for (const name of ["Noura Al Qahtani", "Anne-Marie O'Neill", "Lulwah", "Abdulrahman", "Mishaal", "Sawsan", "Trewin", "Aswad"]) {
    assert.equal(checkPersonName(adminStrings.en.validation, "Name", name), undefined, `a real name stays allowed: ${name}`);
  }
  assert.ok(
    checkCustomer(adminStrings.en, { name: "Noura", phone: "0555123456", email: "asdasdasd@gmail.com", notes: "" }).email,
    "mash in the local part of an address is refused too",
  );

  // Closures: a year back, two years ahead, 90 days long, a real reason.
  const day = "2026-09-15";
  const closure = (from: string, to: string, reason = "Eid holiday") =>
    checkClosure(adminStrings.en, { from, to, reason }, day);
  assert.deepEqual(closure("2026-09-20", "2026-09-22"), {});
  assert.deepEqual(closure("2025-09-15", "2025-09-15"), {}, "exactly a year back is allowed, for the record");
  assert.deepEqual(closure("2025-09-14", "2025-09-14"), {
    from: "From can't be before 2025-09-15. Past closures can be recorded up to one year back.",
  });
  assert.deepEqual(closure("2028-09-15", "2028-09-15"), {}, "exactly two years ahead is allowed");
  assert.equal(closure("2028-09-10", "2028-09-16").to, "To can't be after 2028-09-15. Closures can be planned up to two years ahead.");
  assert.equal(closure("2026-10-01", "2026-12-29").to, undefined, "90 days is the limit itself");
  assert.equal(closure("2026-10-01", "2026-12-30").to, "A closure can last 90 days at most. This one is 91 days.");
  assert.equal(closure("2026-09-22", "2026-09-20").to, "To can't be before From");
  assert.equal(closure("", "").from, "From is required");
  assert.equal(closure("2026-09-20", "2026-09-22", "").reason, "Reason is required");
  assert.equal(closure("2026-09-20", "2026-09-22", "sdfghjkl").reason, 'Reason: "sdfghjkl" doesn\'t look like a real word. Please check the spelling.');
  assert.deepEqual(closure("2026-09-20", "2026-09-22", "صيانة المحل"), {}, "an Arabic reason is fine");

  assert.equal(adminStrings.en.validation.blocked("#", allowedPunct({ script: "en" })), `"#" can't be used here. Allowed: letters, numbers and - & ' . ( ) /`);
}
console.log("  admin forms: each failing field gets its own message, passing ones none ✓");

// -- customer account API ----------------------------------------------------
{
  // The address from the QA report: well-formed, plainly mash.
  assert.equal(emailField.safeParse("239032849234230@gmail.com").success, false, "digit-mash address is refused");
  assert.equal(emailField.safeParse(" noura@example.com ").success, true);
  assert.equal(emailField.safeParse("noura@x-.com").success, false, "stricter than zod's email()");
  assert.equal(nameField.safeParse("Noura Al-Qahtani").success, true);
  assert.equal(nameField.safeParse("Noura 2").success, false, "digits never land in a name");
  assert.equal(nameField.safeParse("sdfghjk").success, false);

  const v = adminStrings.en.validation;
  const bday = (s: string) => checkBirthday(v, "Birthday", s, "2026-09-15");
  assert.equal(bday(""), undefined, "optional");
  assert.equal(bday("1995-03-20"), undefined);
  assert.equal(bday("2026-09-14"), undefined, "yesterday is the latest");
  assert.equal(bday("2026-09-15"), "Birthday must be a date in the past", "not today");
  assert.equal(bday("2026-09-16"), "Birthday must be a date in the past");
  assert.equal(bday("1926-09-15"), undefined, "100 years back is the limit itself");
  assert.equal(bday("1926-09-14"), "Birthday can't be before 1926-09-15");
  assert.equal(bday("1700-01-01"), "Birthday can't be before 1926-09-15");
  assert.equal(bday("20256-01-01"), "Birthday is required", "a mistyped year is not a date");
}
console.log("  account: email, name and birthday refused by the API as on the page ✓");

console.log("\nAll field boundary checks passed.");
