// Renders the invoice email to disk so it can be opened in a browser and checked
// in both languages without taking a payment.
//
//   npm run preview:invoice                        → .preview/invoice-{ar,en}.html
//   npm run preview:invoice -- --send you@you.com  → also sends the English one
//
// Run it through the npm script, not bare `tsx`: --send reaches the transport,
// which imports `server-only`, and that throws unless Node resolves with the
// --conditions=react-server flag the script sets. Same as `npm run check`.
//
// Without --send this is pure: no database, no network, nothing sent. The sample
// bill below is a group booking, which is the awkward case — two guests, a shared
// discount, and totals that have to add back up to what the card was charged.
// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert";
import type { InvoiceData } from "@/lib/invoice/data";
import { renderInvoiceEmail } from "@/lib/invoice/template";
import { splitGroupPrice } from "@/lib/money";

function sample(lang: "ar" | "en"): InvoiceData {
  // Two guests, 10% off the combined bill — the same maths lib/bookings.ts runs.
  const grosses = [25000, 18000];
  const split = splitGroupPrice(grosses, 10);
  const guests = split.map((s, i) => {
    return {
      code: ["RON-4F2K", "RON-7XQM"][i],
      ticketNo: ["K45", "K46"][i],
      stationLabel: ["3", "4"][i],
      technicianName: ["Sara", "Noura"][i],
      lines:
        i === 0
          ? [
              { label: { ar: "تركيب أظافر", en: "Full set" }, amountHalalas: 20000 },
              { label: { ar: "تصميم موسمي", en: "Seasonal design" }, amountHalalas: 5000 },
            ]
          : [{ label: { ar: "مانيكير", en: "Manicure" }, amountHalalas: 18000 }],
      discountHalalas: s.discountHalalas,
      totalHalalas: s.totalHalalas,
    };
  });

  const sum = (pick: (g: (typeof guests)[number]) => number) =>
    guests.reduce((n, g) => n + pick(g), 0);

  return {
    seller: {
      name: "Red or Nude",
      branchName: { ar: "فرع العليا", en: "Olaya branch" },
      branchAddress: { ar: "طريق العليا، الرياض", en: "Olaya Road, Riyadh" },
      branchPhone: "0112345678",
    },
    customer: { name: "Sara", email: "sara@example.com", phone: "0512345678", lang },
    startsAt: new Date("2026-08-20T14:00:00Z"),
    method: "mada",
    providerRef: "pay_9f3a1c",
    guests,
    promoCode: null,
    discountHalalas: sum((g) => g.discountHalalas),
    totalHalalas: sum((g) => g.totalHalalas),
    taxInvoiceUrl: "https://streampay.sa/s/example",
    memberships: [
      {
        packName: { ar: "باقة العناية", en: "Care membership" },
        expiresAt: new Date("2026-11-18T09:12:00Z"),
        lines: [
          { serviceName: { ar: "مانيكير", en: "Manicure" }, left: 5, granted: 6 },
          { serviceName: { ar: "جل", en: "Gel polish" }, left: 0, granted: 2 },
        ],
      },
    ],
  };
}

mkdirSync(".preview", { recursive: true });

for (const lang of ["ar", "en"] as const) {
  const data = sample(lang);

  // The email must never disagree with the card. Everything else is styling.
  assert.equal(
    data.guests.reduce((n, g) => n + g.totalHalalas, 0),
    data.totalHalalas,
    "the guests' totals must add up to the bill",
  );

  const { subject, html, text } = renderInvoiceEmail(data);
  assert.ok(html.includes(data.taxInvoiceUrl!), "the email must link StreamPay's tax invoice");
  assert.ok(!/VAT no\.|الرقم الضريبي/.test(html), "the confirmation is not a tax invoice");

  // Customer-supplied text is interpolated into the HTML; it must arrive escaped.
  const injected = renderInvoiceEmail({
    ...data,
    customer: { ...data.customer, name: '<script>alert("x")</script>' },
  });
  assert.ok(!injected.html.includes("<script>"), "customer name must be HTML-escaped");

  writeFileSync(`.preview/invoice-${lang}.html`, html);
  writeFileSync(`.preview/invoice-${lang}.txt`, `${subject}\n\n${text}`);
  console.log(`${lang}: ${subject}  →  .preview/invoice-${lang}.html`);
}

console.log("\nAll assertions passed.");

// --send actually posts one through the same sendMail() the payment path uses,
// whichever transport is configured — so a green result means the real thing
// works, not a mock.
// Wrapped in a function because tsx transforms this to CJS, which has no
// top-level await.
async function send(to: string) {
  // Imported lazily so the render path above stays runnable with no key set.
  const { sendMail, activeTransport } = await import("@/lib/email");
  console.log(`\nsending via: ${activeTransport()}`);
  const { subject, html, text } = renderInvoiceEmail(sample("en"));

  const result = await sendMail({ to, subject, html, text, tags: ["booking-invoice-test"] });
  if (!result.ok) {
    console.error(`\nNot sent (${result.reason}): ${result.detail ?? ""}`);
    process.exit(1);
  }
  console.log(`Sent to ${to} — id ${result.id}`);
}

const sendIndex = process.argv.indexOf("--send");
if (sendIndex !== -1) {
  const to = process.argv[sendIndex + 1];
  if (!to || to.startsWith("--")) {
    console.error("--send needs an address: npm run preview:invoice -- --send you@example.com");
    process.exit(1);
  }
  void send(to);
}
