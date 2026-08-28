// What the chat assistant is allowed to know.
//
//   npm run check:chat
//
// Prints the block that goes into every request's system instruction, in both
// languages, and asserts the one property that matters: it contains salon
// facts and no customer data. A booking reaches the model only through the
// session-scoped tool in app/api/chat/route.ts, never through this block, and
// this is the check that fails if someone later widens it.
//
// Reads the real database, so what it prints is what the model would actually
// be told today.

import { config } from "dotenv";
config({ path: ".env.local" });

import assert from "node:assert";
import { knowledgeBlock } from "@/lib/chat/knowledge";

async function main() {
  for (const lang of ["en", "ar"] as const) {
    const block = await knowledgeBlock(lang);

    console.log(`\n${"=".repeat(70)}\n  ${lang.toUpperCase()}  (${block.length} chars)\n${"=".repeat(70)}`);
    console.log(block || "(empty — nothing active in the catalogue)");

    assert(block.length > 0, `${lang}: the block is empty; the assistant would know nothing`);

    // No email addresses. Branch rows carry a phone but never an inbox, and a
    // customer's address must never be within reach of the prompt.
    assert(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(block), `${lang}: an email address leaked into the block`);

    // No Saudi mobile numbers. Branch landlines are fine and expected; a 05x
    // number is a customer's.
    assert(!/\b05\d{8}\b/.test(block), `${lang}: a mobile number leaked into the block`);

    // No booking references (RON-XXXX). If one appears here it came from a
    // bookings row, which has no business in a block sent to every visitor.
    assert(!/\bRON-[A-Z0-9]{4,}\b/.test(block), `${lang}: a booking reference leaked into the block`);
  }

  console.log("\n✓ the block carries salon facts and no customer data");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
