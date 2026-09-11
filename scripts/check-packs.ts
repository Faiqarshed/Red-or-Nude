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
  payments,
  customerPacks,
  customers,
  packServices,
  packTxns,
  packs,
  services,
  stations,
} from "@/lib/db/schema";
import { buyPack, packCredits, quotePackCredit, returnPackCredits, spendPackCredit } from "@/lib/packs";
import { createBookings } from "@/lib/bookings";
import { confirmBookingPayment } from "@/lib/payments/confirm";

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
  // What she was sold, which the profile subtracts from to say "2 of 3 used".
  assert.equal(credits.find((c) => c.serviceId === svcA.id)?.granted, 3, "granted is the purchase");
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
  assert.ok(!refused.ok, "a service with nothing left cannot be spent");

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
    assert.ok(!never.ok, "a service the pack never covered cannot be spent");
    console.log("  a service the pack never covered is refused ✓");
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

  // The `+1` a return writes is a credit back, not a bigger membership. Counting
  // every positive row as the grant would grow what she was sold each time she
  // cancelled in time, and the profile would read "1 of 4 used" on a pack of 3.
  assert.equal(
    (await packCredits(customer.id)).find((c) => c.serviceId === svcA.id)?.granted,
    3,
    "a returned credit does not grow what the membership came with",
  );
  console.log("  cancelled: one back, and only one ✓");

  // -- an expired pack is dead, not swept -----------------------------------
  await db
    .update(customerPacks)
    .set({ expiresAt: new Date(Date.now() - 86_400_000) })
    .where(eq(customerPacks.id, held));
  assert.deepEqual(await packCredits(customer.id), [], "nothing is spendable past the deadline");
  const lapsed = await quotePackCredit(customer.id, held, svcB.id);
  assert.ok(!lapsed.ok, "and nothing on it can be spent");
  console.log("  expired: dead on read, with no job to run ✓");

  // -- somebody else's pack --------------------------------------------------
  const [stranger] = await db
    .insert(customers)
    .values({ phone: "0500000078", name: "Not Her" })
    .returning({ id: customers.id });
  made.customers.push(stranger.id);
  const theirs = await quotePackCredit(stranger.id, held, svcB.id);
  assert.ok(!theirs.ok, "a pack that is not yours is not yours");
  console.log("  another customer's pack is invisible ✓");

  // -- a credit actually pays for a booking ---------------------------------
  // Everything above is the ledger on its own. This is the whole path:
  // createBookings prices the service line to zero, writes the -1 inside its own
  // transaction, and charges for the extras it did not cover.
  const [live] = await db
    .insert(customers)
    .values({ phone: "0500000079", name: "Live Pack" })
    .returning({ id: customers.id });
  made.customers.push(live.id);

  const liveBuy = await buyPack(live.id, pack.id);
  assert.ok(liveBuy.ok, "setup: bought a pack to spend");
  // Read rather than assumed: the pack was edited to 99 above, so what she just
  // bought is whatever it held at *her* purchase, which is the point being made.
  const beforeBooking = (await packCredits(live.id)).find((c) => c.serviceId === svcA.id)!.left;

  const [chair] = await db
    .select()
    .from(stations)
    .where(and(eq(stations.branchId, branch.id), eq(stations.active, true)))
    .limit(1);
  assert.ok(chair, "setup: the branch has a chair");

  const booked = await createBookings({
    branchId: branch.id,
    startsAt: new Date(Date.UTC(2031, 2, 4, 7, 0)).toISOString(),
    customer: { phone: "0500000079" },
    customerId: live.id,
    source: "web",
    status: "confirmed",
    members: [{ serviceId: svcA.id, addonIds: [], customerPackId: liveBuy.customerPackId }],
  });
  assert.ok(booked.ok, `booking with a credit failed: ${booked.ok ? "" : booked.error}`);
  made.bookings.push(booked.bookings[0].id);

  assert.equal(booked.totalHalalas, 0, "the credit paid for the service line");
  assert.equal(
    (await packCredits(live.id)).find((c) => c.serviceId === svcA.id)?.left,
    beforeBooking - 1,
    "and exactly one credit came off",
  );
  console.log("  booked with a credit: charged 0, one credit spent ✓");

  // A pack she does not own cannot pay for anything, however the request is
  // shaped — this is the check that the browser does not decide.
  const stolen = await createBookings({
    branchId: branch.id,
    startsAt: new Date(Date.UTC(2031, 2, 4, 9, 0)).toISOString(),
    customer: { phone: PHONE },
    customerId: customer.id,
    source: "web",
    status: "confirmed",
    members: [{ serviceId: svcA.id, addonIds: [], customerPackId: liveBuy.customerPackId }],
  });
  assert.ok(stolen.ok, "the booking still stands");
  made.bookings.push(stolen.bookings[0].id);
  assert.ok(
    stolen.totalHalalas > 0,
    "somebody else's pack pays for nothing — she is charged in full",
  );
  console.log("  another customer's pack pays for nothing ✓");

  // -- a hold that died unpaid does not keep the credit ---------------------
  // The credit comes off when the booking is *created*, before she has paid for
  // anything. Nothing gives it back when that hold dies — returnPackCredits is
  // wired to the cancel button, which she cannot press on a booking the sweep
  // has already cancelled. So the rule lives in the read: see neverRedeemed.
  const [walked] = await db
    .insert(customers)
    .values({ phone: "0500000080", name: "Walked Away" })
    .returning({ id: customers.id });
  made.customers.push(walked.id);

  const walkedBuy = await buyPack(walked.id, pack.id);
  assert.ok(walkedBuy.ok, "setup: bought a pack to strand");
  const owned = (await packCredits(walked.id)).find((c) => c.serviceId === svcA.id)!.left;
  const leftNow = async () =>
    (await packCredits(walked.id)).find((c) => c.serviceId === svcA.id)?.left;

  /** A booking in whatever state, with one credit already spent against it. */
  const strand = async (
    status: "pending" | "cancelled" | "no_show",
    cancelReason: string | null,
    createdAt: Date,
    hour: number,
  ) => {
    const startsAt = new Date(Date.UTC(2031, 4, 6, hour, 0));
    const [row] = await db
      .insert(bookings)
      .values({
        code: `ZZS-${Math.random().toString(36).slice(2, 7)}`,
        branchId: branch.id,
        customerId: walked.id,
        serviceId: svcA.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        status,
        cancelReason,
        source: "web",
        createdAt,
      })
      .returning({ id: bookings.id });
    made.bookings.push(row.id);
    const spent = await spendPackCredit(db, walkedBuy.customerPackId, svcA.id, row.id);
    assert.ok(spent, "setup: the credit was spent against this booking");
    return row.id;
  };

  // Her card was declined and she closed the tab; the sweep collected the hold.
  await strand("cancelled", "payment-timeout", new Date(), 7);
  assert.equal(
    await leftNow(),
    owned,
    "a hold the sweep cancelled was never redeemed — the credit is still hers",
  );

  // The same story before the sweep has run, which is the case that matters:
  // sweepExpiredHolds only fires when some *other* customer books at this
  // branch, so a balance that waited for it would be wrong for hours.
  await strand("pending", null, new Date(Date.now() - 86_400_000), 9);
  assert.equal(await leftNow(), owned, "and still hers before anything swept it");

  // The other side of the rule, or this would just read "packs never run out".
  // A hold still inside its window keeps the credit — she may yet pay — and a
  // no-show forfeits it exactly as the money is forfeited.
  await strand("pending", null, new Date(), 11);
  assert.equal(
    await leftNow(),
    owned - 1,
    "a hold still inside its window is a credit in flight, not a credit back",
  );

  await strand("no_show", null, new Date(), 13);
  assert.equal(
    await leftNow(),
    owned - 2,
    "a no-show forfeits the credit, the same way it forfeits the money",
  );
  console.log("  a hold that died unpaid keeps her credit; a no-show does not ✓");

  // And the booking path has to count it the same way, or the screen offers a
  // credit that createBookings then refuses.
  const recovered = await createBookings({
    branchId: branch.id,
    startsAt: new Date(Date.UTC(2031, 4, 7, 7, 0)).toISOString(),
    customer: { phone: "0500000080" },
    customerId: walked.id,
    source: "web",
    status: "confirmed",
    members: [{ serviceId: svcA.id, addonIds: [], customerPackId: walkedBuy.customerPackId }],
  });
  assert.ok(recovered.ok, "the recovered credit is spendable");
  made.bookings.push(recovered.bookings[0].id);
  assert.equal(recovered.totalHalalas, 0, "and it paid for the service line");
  console.log("  spendPackCredit counts it the same way packCredits does ✓");

  // -- a booking the credit pays for in full never reaches a gateway ---------
  // She owes nothing, so there is nothing to authorise. A real PSP refuses a
  // zero charge, and asking her for a card to be charged nothing is a step that
  // exists only because the code could not tell the difference.
  const [free] = await db
    .insert(customers)
    .values({ phone: "0500000081", name: "Nothing To Pay" })
    .returning({ id: customers.id });
  made.customers.push(free.id);

  const freeBuy = await buyPack(free.id, pack.id);
  assert.ok(freeBuy.ok, "setup: bought a pack to spend in full");

  const freeBooking = await createBookings({
    branchId: branch.id,
    startsAt: new Date(Date.UTC(2031, 5, 9, 7, 0)).toISOString(),
    customer: { phone: "0500000081" },
    customerId: free.id,
    source: "web",
    // Pending, as the web flow leaves it: the chair is held and nothing is paid
    // until confirmBookingPayment says so. createBookings defaults to
    // `confirmed`, which is the walk-in case, so this has to be asked for.
    status: "pending",
    members: [{ serviceId: svcA.id, addonIds: [], customerPackId: freeBuy.customerPackId }],
  });
  assert.ok(
    freeBooking.ok,
    `booking with a full credit failed: ${freeBooking.ok ? "" : freeBooking.error}`,
  );
  made.bookings.push(freeBooking.bookings[0].id);
  assert.equal(freeBooking.totalHalalas, 0, "setup: the credit covered the whole bill");

  const paid = await confirmBookingPayment({ code: freeBooking.bookings[0].code, method: "card" });
  assert.ok(paid.ok, `confirming a free booking failed: ${paid.ok ? "" : paid.error}`);
  assert.equal(paid.totalHalalas, 0, "and it confirmed for nothing");
  assert.ok(paid.tickets.length === 1, "with a ticket number, like any other booking");

  const [settled] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, freeBooking.bookings[0].id))
    .limit(1);
  assert.equal(settled.status, "confirmed", "the booking is confirmed, not left pending");

  // The zero still lands in `payments`: it is what the double-tap guard is keyed
  // on, and a confirmed booking with no payment row is a hole in the day's
  // takings rather than a zero in it.
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.bookingId, freeBooking.bookings[0].id))
    .limit(1);
  assert.ok(row, "a payment row was still written");
  assert.equal(row.amountHalalas, 0, "for zero");
  assert.equal(row.status, "paid", "and settled rather than left pending");
  console.log("  a booking the credit covers in full confirms with no charge ✓");

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
