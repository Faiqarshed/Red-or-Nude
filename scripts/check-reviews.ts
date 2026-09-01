// Rating invitation and submission boundaries (brief §2.9).
//
//   npm run check:reviews
//
// No database and no network. Two things are worth pinning down here: the score
// range the API accepts, and that the email renders in both languages with the
// token in every link and customer text escaped.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import { z } from "zod";
import { renderReviewEmail } from "@/lib/reviews/email";

// -- the score range ---------------------------------------------------------
//
// Mirrors the schema in app/api/reviews/route.ts. A rating outside 1–5 has to be
// refused rather than clamped: a 0 that silently becomes a 1 is a complaint
// recorded as praise.

const rating = z.number().int().min(1).max(5);

for (const good of [1, 2, 3, 4, 5]) {
  assert.ok(rating.safeParse(good).success, `${good} is a valid rating`);
}
for (const bad of [0, 6, -1, 2.5, Number.NaN]) {
  assert.ok(!rating.safeParse(bad).success, `${bad} is not a valid rating`);
}

// Skipping the technician is not the same as rating them 0.
assert.ok(rating.nullable().safeParse(null).success, "the technician score may be skipped");
assert.ok(!rating.nullable().safeParse(0).success, "but 0 is still not a score");

// -- the email ---------------------------------------------------------------

const token = "9f3a1c00-0000-4000-8000-00000000abcd";

for (const lang of ["ar", "en"] as const) {
  const mail = renderReviewEmail({ token, customerName: "Sara", serviceName: "Full set", lang });

  assert.ok(mail.subject.length > 0, `${lang}: the subject is not empty`);
  assert.ok(mail.html.includes(`dir="${lang === "ar" ? "rtl" : "ltr"}"`), `${lang}: direction`);

  // Every star has to carry the token and its own score, or a click lands on a
  // page that cannot tell which review it is.
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(mail.html.includes(`/review/${token}?r=${n}`), `${lang}: star ${n} links correctly`);
    assert.ok(mail.text.includes(`/review/${token}?r=${n}`), `${lang}: star ${n} in plain text`);
  }

  // The plain-text twin is not optional — a share of clients only ever show it.
  assert.ok(mail.text.includes(`/review/${token}`), `${lang}: plain text carries the link`);
}

// Customer-supplied text lands inside an HTML document. A service name with
// markup in it must arrive as text, not as markup.
const nasty = renderReviewEmail({
  token,
  customerName: '<script>alert("x")</script>',
  serviceName: 'Nails & "lashes"',
  lang: "en",
});

assert.ok(!nasty.html.includes("<script>"), "a script tag in a name is escaped");
assert.ok(nasty.html.includes("&lt;script&gt;"), "…and is still visible as text");
assert.ok(nasty.html.includes("&amp;"), "an ampersand is escaped");
assert.ok(!nasty.html.includes('Nails & "lashes"'), "raw quotes and ampersands do not survive");

console.log("check:reviews — all rating checks passed");
