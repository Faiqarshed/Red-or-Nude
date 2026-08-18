// Renders the gift card email to disk so it can be checked in both languages,
// and in both variants, without buying a card.
//
//   npm run preview:giftcard                        → .preview/giftcard-*.html
//   npm run preview:giftcard -- --send you@you.com  → also sends the English one
//
// Pure without --send: no database, no network, nothing sent.

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert";
import { renderGiftCardEmail, type GiftCardEmailInput } from "@/lib/giftcard/email";

const sample = (lang: "ar" | "en"): GiftCardEmailInput => ({
  code: "7K4M-9QXB-2WHN-5TCD",
  amountSar: 500,
  senderName: "Khalid",
  recipientName: "Sarah",
  recipientEmail: "sarah@example.com",
  buyerEmail: "khalid@example.com",
  message: lang === "ar" ? "تستاهلين الدلع" : "You deserve this!",
  expiresAt: new Date("2027-08-18T00:00:00Z"),
  lang,
});

mkdirSync(".preview", { recursive: true });

for (const lang of ["ar", "en"] as const) {
  for (const forBuyer of [false, true]) {
    const data = sample(lang);
    const { subject, html, text } = renderGiftCardEmail(data, forBuyer);

    // The code is the product. If it isn't in both parts, the email is useless.
    assert.ok(html.includes(data.code), "the card code must appear in the HTML");
    assert.ok(text.includes(data.code), "the card code must appear in the text part");

    // The buyer's receipt must not repeat the personal message meant for the
    // recipient — they wrote it, and it reads oddly quoted back at them.
    if (forBuyer) {
      assert.ok(!html.includes("You deserve this!"), "buyer copy should omit the message");
    }

    const who = forBuyer ? "buyer" : "recipient";
    writeFileSync(`.preview/giftcard-${lang}-${who}.html`, html);
    writeFileSync(`.preview/giftcard-${lang}-${who}.txt`, `${subject}\n\n${text}`);
    console.log(`${lang}/${who}: ${subject}`);
  }
}

// Customer-supplied text lands in HTML — it must arrive escaped.
const injected = renderGiftCardEmail({
  ...sample("en"),
  senderName: '<script>alert("x")</script>',
});
assert.ok(!injected.html.includes("<script>"), "sender name must be HTML-escaped");

console.log("\nAll assertions passed. → .preview/giftcard-*.html");

async function send(to: string) {
  const { sendGiftCardEmails } = await import("@/lib/giftcard/email");
  const out = await sendGiftCardEmails({ ...sample("en"), recipientEmail: to, buyerEmail: null });
  if (out.recipient !== "sent") {
    console.error(`\nNot sent (${out.recipient}) — see the [giftcard] log line above.`);
    process.exit(1);
  }
  console.log(`\nSent to ${to}`);
}

const i = process.argv.indexOf("--send");
if (i !== -1) {
  const to = process.argv[i + 1];
  if (!to || to.startsWith("--")) {
    console.error("--send needs an address: npm run preview:giftcard -- --send you@example.com");
    process.exit(1);
  }
  void send(to);
}
