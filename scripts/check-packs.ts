// Membership pack credits (docs/SCOPE-ENHANCEMENT.md §6).
//
//   npm run check:packs
//
// Against real Postgres, because the rules that matter here are the ones the
// database enforces: the partial unique index that refuses a second spend on one
// booking, and SUM(delta) being the only place a balance exists.
//
// Credits are per service and not interchangeable — most of what follows is
// that one sentence, asserted from several directions.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bookings,
  branches,
  customerPacks,
  customers,
  packServices,
  packTxns,
  packs,
  services,
} from "@/lib/db/schema";
import { buyPack, packCredits, quotePackCredit, returnPackCredits, spendPackCredit } from "@/lib/packs";

const PHONE = "0500000077";

/** Did this error come from the named constraint? See the note at its use. */
function named(err: unknown, constraint: string): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e.message.includes(constraint)) return true;
  }
  return false;
}
const made: { packs: string[]; customers: string[]; bookings: string[] } = {
  packs: [],
  customers: [],
  bookings: [],
};

async function main() {
  const [branch] = await db.select().from(branches).limit(1);
  const catalogue = await db
    .select()
    .from(services)
    .where(eq(services.active, true))
    .orderBy(desc(services.priceHalalas))
    .limit(2);
  assert.ok(branch && catalogue.length > 1, "run `npm run db:seed` first");
  const [svcA, svcB] = catalogue;

  // A pack of three of one service and one of another — the shape the client
  // asked for, and the shape a single pool of uses could not express.
  const [pack] = await db
    .insert(packs)
    .values({
      name: { ar: "باقة الفحص", en: "Check Pack" },
      priceHalalas: 89900,
      validDays: 90,
    })
    .returning({ id: packs.id });
  made.packs.push(pack.id);

  await db.insert(packServices).values([
    { packId: pack.id, serviceId: svcA.id, quantity: 3 },
    { packId: pack.id, serviceId: svcB.id, quantity: 1 },
  ]);

  const [customer] = await db
    .insert(customers)
    .values({ phone: PHONE, name: "Pack Tester" })
    .returning({ id: customers.id });
  made.customers.push(customer.id);

  // -- buying grants the lines, and nothing else ----------------------------
  const bought = await buyPack(customer.id, pack.id);
  assert.ok(bought.ok, "the pack was sold");
  const held = bought.customerPackId;

  const credits = await packCredits(customer.id);
  assert.equal(credits.length, 2, "two services, two credit lines");
  assert.equal(credits.find((c) => c.serviceId === svcA.id)?.left, 3);
  assert.equal(credits.find((c) => c.serviceId === svcB.id)?.left, 1);
  console.log("  bought: 3 + 1 credits, from the ledger and nowhere else ✓");

  // -- the purchase is a snapshot -------------------------------------------
  // The salon rewriting the pack must not rewrite what she already owns.
  await db
    .update(packServices)
    .set({ quantity: 99 })
    .where(and(eq(packServices.packId, pack.id), eq(packServices.serviceId, svcA.id)));
  const afterEdit = await packCredits(customer.id);
  assert.equal(
    afterEdit.find((c) => c.serviceId === svcA.id)?.left,
    3,
    "editing the pack cannot change a purchase already made",
  );
  console.log("  the pack was edited to 99 — she still has 3 ✓");

  // -- spending takes one, from that service only ---------------------------
  const book = async () => {
    const startsAt = new Date(Date.UTC(2031, 0, 5, 7, 0));
    const [row] = await db
      .insert(bookings)
      .values({
        code: `ZZP-${Math.random().toString(36).slice(2, 7)}`,
        branchId: branch.id,
        customerId: customer.id,
        serviceId: svcA.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        status: "confirmed",
        source: "web",
      })
      .returning({ id: bookings.id });
    made.bookings.push(row.id);
    return row.id;
  };

  const first = await book();
  await spendPackCredit(db, held, svcA.id, first);
  const spent = await packCredits(customer.id);
  assert.equal(spent.find((c) => c.serviceId === svcA.id)?.left, 2, "one off the service booked");
  assert.equal(spent.find((c) => c.serviceId === svcB.id)?.left, 1, "and none off the other");
  console.log("  spent one: 2 + 1, the other service untouched ✓");

  // -- one spend per booking, enforced by the database ----------------------
  // A retried request or two tabs, not a check that can be raced.
  const doubleSpend = await spendPackCredit(db, held, svcA.id, first).catch((e: unknown) => e);
  assert.ok(doubleSpend instanceof Error, "a second spend on one booking must be refused");
  // Walked rather than matched on `.message`: Drizzle wraps the driver error in
  // a DrizzleQueryError whose own message is only the failed SQL, so checking
  // the top-level message silently misses it. Same reason isSlotConflict in
  // lib/bookings.ts walks the chain.
  assert.ok(
    named(doubleSpend, "pack_txns_booking_unique"),
    "…and refused by the index, not by anything else",
  );
  console.log("  a repeated spend on one booking is refused ✓");

  // -- credits are not interchangeable --------------------------------------
  const second = await book();
  const third = await book();
  await spendPackCredit(db, held, svcA.id, second);
  await spendPackCredit(db, held, svcA.id, third);

  const drained = await packCredits(customer.id);
  assert.equal(
    drained.find((c) => c.serviceId === svcA.id),
    undefined,
    "a service with nothing left is not a credit",
  );

  const refused = await quotePackCredit(customer.id, held, svcA.id);
  assert.ok(!refused.ok && refused.reason === "spent", "run out reads as spent, not as missing");

  // The other service still has its one — this is the whole point of quantities
  // per service rather than a pool.
  const other = await quotePackCredit(customer.id, held, svcB.id);
  assert.ok(other.ok && other.left === 1, "the other service keeps its credit");
  console.log("  ran out of one service, the other still has its credit ✓");

  // -- a service the pack never covered -------------------------------------
  const [uncovered] = await db
    .select()
    .from(services)
    .where(and(eq(services.active, true)))
    .orderBy(services.priceHalalas)
    .limit(1);
  if (uncovered && uncovered.id !== svcA.id && uncovered.id !== svcB.id) {
    const never = await quotePackCredit(customer.id, held, uncovered.id);
    assert.ok(
      !never.ok && never.reason === "wrong-service",
      "never covered reads differently from run out",
    );
    console.log("  a service the pack never covered says so ✓");
  }

  // -- cancelling in time gives it back, once -------------------------------
  const returned = await returnPackCredits([first], "cancelled");
  assert.equal(returned, 1, "one credit came back");
  assert.equal(
    (await packCredits(customer.id)).find((c) => c.serviceId === svcA.id)?.left,
    1,
    "and it is spendable again",
  );

  const again = await returnPackCredits([first], "cancelled");
  assert.equal(again, 0, "cancelling twice cannot mint a credit she never bought");
  console.log("  cancelled: one back, and only one ✓");

  // -- an expired pack is dead, not swept -----------------------------------
  await db
    .update(customerPacks)
    .set({ expiresAt: new Date(Date.now() - 86_400_000) })
    .where(eq(customerPacks.id, held));
  assert.deepEqual(await packCredits(customer.id), [], "nothing is spendable past the deadline");
  const lapsed = await quotePackCredit(customer.id, held, svcB.id);
  assert.ok(!lapsed.ok && lapsed.reason === "expired", "and it says why");
  console.log("  expired: dead on read, with no job to run ✓");

  // -- somebody else's pack --------------------------------------------------
  const [stranger] = await db
    .insert(customers)
    .values({ phone: "0500000078", name: "Not Her" })
    .returning({ id: customers.id });
  made.customers.push(stranger.id);
  const theirs = await quotePackCredit(stranger.id, held, svcB.id);
  assert.ok(!theirs.ok && theirs.reason === "not-found", "a pack that is not yours is not yours");
  console.log("  another customer's pack is invisible ✓");

  console.log("\ncheck:packs — pack credits hold against Postgres");
}

async function cleanup() {
  if (made.bookings.length) {
    await db.delete(packTxns).where(inArray(packTxns.bookingId, made.bookings));
    await db.delete(bookings).where(inArray(bookings.id, made.bookings));
  }
  if (made.customers.length) {
    await db.delete(customerPacks).where(inArray(customerPacks.customerId, made.customers));
    await db.delete(customers).where(inArray(customers.id, made.customers));
  }
  if (made.packs.length) {
    await db.delete(packServices).where(inArray(packServices.packId, made.packs));
    await db.delete(packs).where(inArray(packs.id, made.packs));
  }
  console.log(`cleaned up ${made.packs.length} pack(s), ${made.bookings.length} bookings`);
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  });
