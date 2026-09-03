// A demonstration you can run and read with your own eyes.
//
//   npx tsx --conditions=react-server scripts/prove-takeover.ts
//
// It creates a fake customer, has a fake attacker sign up using only that
// customer's phone number, and prints the customer's database row before and
// after. Nothing is mocked or stubbed — this is the real register route
// against the real throwaway database. Deletes only the two rows it makes.

import "./_test-db";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { mintSignupTicket } from "@/lib/account/session";

const VICTIM_PHONE = "0599887766";

function show(label: string, row: typeof customers.$inferSelect | undefined) {
  console.log(`\n  ${label}`);
  if (!row) return console.log("    (no row)");
  console.log(`    id       ${row.id}`);
  console.log(`    name     ${row.name}`);
  console.log(`    email    ${row.email}`);
  console.log(`    verified ${row.emailVerifiedAt ? "yes" : "no"}`);
}

async function main() {
  await db.delete(customers).where(eq(customers.phone, VICTIM_PHONE));

  // 1. A real customer, signed up properly, with bookings behind her.
  const [victim] = await db
    .insert(customers)
    .values({
      phone: VICTIM_PHONE,
      name: "Sara (real customer)",
      email: "sara@example.test",
      emailVerifiedAt: new Date(),
    })
    .returning();

  // From here on the row exists, so every exit path has to remove it — a throw
  // in the middle used to leave it behind for the next run's opening delete to
  // find. It only ever pollutes the gated test database, but a demonstration
  // that leaves litter is a demonstration people stop trusting.
  try {
    await demonstrate(victim);
  } finally {
    await db.delete(customers).where(eq(customers.id, victim.id));
  }
  process.exit(0);
}

async function demonstrate(victim: typeof customers.$inferSelect) {
  show("BEFORE — Sara's account", victim);

  // 2. The attacker proves an inbox *they* own. This part is legitimate: it is
  //    what everyone does when they sign up. They never touch Sara's email.
  const ticket = await mintSignupTicket("attacker@example.test");

  // 3. They post their own ticket with SARA'S PHONE NUMBER. That is the attack.
  //    No password, no code sent to Sara, nothing of hers except the number.
  const { POST } = await import("@/app/api/account/register/route");
  const res = await POST(
    new Request("http://localhost/api/account/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ ticket, name: "Attacker", phone: VICTIM_PHONE }),
    }),
  );

  console.log(`\n  The server answered: ${res.status} ${JSON.stringify(await res.json())}`);
  console.log(`  It also set a login cookie: ${res.headers.has("set-cookie") ? "yes" : "no"}`);

  // 4. Read Sara's row back — same id, so this is her row, not a new one.
  const [after] = await db.select().from(customers).where(eq(customers.id, victim.id));
  show("AFTER — the same row, same id", after);

  const stolen = after && after.email !== "sara@example.test";
  console.log(
    stolen
      ? "\n  >>> Sara's account now belongs to the attacker. The id never changed,\n" +
          "      so every booking and loyalty point of hers came along with it.\n"
      : "\n  >>> Sara's account is intact. The bug is fixed.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
