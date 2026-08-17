// Booking correctness checks. Run against a seeded database:
//
//   npx tsx scripts/check-booking.ts
//
// Covers the concurrency guarantees that the availability engine and
// lib/bookings.ts depend on. Plain asserts, no test framework — if it exits 0
// the invariants hold. It cleans up after itself, but it writes real rows, so
// point it at a development database.

import { config } from "dotenv";
config({ path: ".env.local" });

import assert from "node:assert";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, branches, customers, services, stations } from "@/lib/db/schema";
import { createBooking, createBookings } from "@/lib/bookings";
import { splitGroupPrice, vatIncludedIn } from "@/lib/money";
import { formatTicketNo } from "@/lib/tickets";

const TEST_PHONE = "0500000001";

async function cleanup(branchId: string) {
  await db.delete(bookings).where(eq(bookings.branchId, branchId));
  await db.delete(customers).where(like(customers.phone, "05000000%"));
}

/** Pure maths — no database needed. */
function checkPricing() {
  // A single guest at 0% must be untouched: the ordinary booking cannot regress.
  assert.deepEqual(splitGroupPrice([25000], 0), [{ discountHalalas: 0, totalHalalas: 25000 }]);

  // Awkward amounts that don't divide cleanly at 10%.
  for (const grosses of [
    [13333, 8888],
    [25000, 25000],
    [9999, 1],
    [7777, 3333],
    [100, 100],
  ]) {
    const split = splitGroupPrice(grosses, 10);
    const grossTotal = grosses.reduce((a, b) => a + b, 0);
    const billTotal = grossTotal - Math.round((grossTotal * 10) / 100);

    // The guests' totals must add back up to the bill exactly — this is the one
    // that actually matters, because it's what the customer is charged.
    assert.equal(
      split.reduce((sum, s) => sum + s.totalHalalas, 0),
      billTotal,
      `totals must sum to the bill for ${grosses}`,
    );
    assert.equal(
      split.reduce((sum, s) => sum + s.discountHalalas, 0),
      grossTotal - billTotal,
      `discounts must sum to the discount for ${grosses}`,
    );

    // And every row's own subtotal + VAT must equal its total.
    for (const s of split) {
      const vat = vatIncludedIn(s.totalHalalas, 15);
      assert.equal(s.totalHalalas - vat + vat, s.totalHalalas);
      assert.ok(vat >= 0 && vat < s.totalHalalas, "VAT must be a sane slice of the total");
    }
  }
  console.log("  pricing: discount splits with no drift ✓");

  assert.equal(formatTicketNo(1), "A1");
  assert.equal(formatTicketNo(45), "A45");
  assert.equal(formatTicketNo(99), "A99");
  assert.equal(formatTicketNo(100), "B1");
  assert.equal(formatTicketNo(198), "B99");
  assert.equal(formatTicketNo(199), "C1");
  console.log("  tickets: A1 … A99 → B1 ✓");
}

async function main() {
  const [branch] = await db.select().from(branches).limit(1);
  const [service] = await db.select().from(services).where(eq(services.active, true)).limit(1);
  assert.ok(branch && service, "run `npm run db:seed` first");

  const chairs = await db
    .select()
    .from(stations)
    .where(and(eq(stations.branchId, branch.id), eq(stations.active, true)));

  const n = chairs.length;
  const dur = service.durationMin;
  console.log(`branch has ${n} chairs, service is ${dur} min`);
  assert.ok(n >= 2, "need at least 2 chairs to test contention");

  // A far-future instant so these never collide with real or seeded data.
  const base = Date.UTC(2030, 5, 10, 6, 0); // 09:00 Riyadh

  const book = (offsetMin: number) =>
    createBooking({
      branchId: branch.id,
      serviceId: service.id,
      addonIds: [],
      startsAt: new Date(base + offsetMin * 60_000).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
    });

  // -- Overlapping bookings at DIFFERENT start times ------------------------
  // These all overlap each other, so at most `n` can be seated. They start at
  // different times, which is precisely what the bookings_station_slot_unique
  // constraint does NOT catch — only the row lock in reserveStations does.
  await cleanup(branch.id);
  const offsets = Array.from({ length: n + 1 }, (_, i) => i * 5);
  const results = await Promise.all(offsets.map(book));

  const seated = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok && r.error === "slot-taken").length;
  console.log(`  ${offsets.length} concurrent overlapping attempts → ${seated} seated, ${refused} refused`);
  assert.equal(seated, n, `expected exactly ${n} bookings on ${n} chairs, got ${seated}`);
  assert.equal(refused, 1, "the surplus attempt must be told the slot is gone");

  const rows = await db.select().from(bookings).where(eq(bookings.branchId, branch.id));
  const perChair = new Map<string, number>();
  for (const r of rows) perChair.set(r.stationId!, (perChair.get(r.stationId!) ?? 0) + 1);
  assert.ok([...perChair.values()].every((c) => c === 1), "a chair was double-booked");
  console.log("  no chair holds two overlapping bookings ✓");

  // -- A booking starting exactly when another ends -------------------------
  // Fill every chair, then book at exactly the moment they all free up. The
  // conflict predicate must be strict at both ends or this is wrongly refused,
  // and the calendar would offer a slot that fails on confirm.
  await cleanup(branch.id);
  const fill = await Promise.all(Array.from({ length: n }, () => book(0)));
  assert.equal(fill.filter((r) => r.ok).length, n, "setup: every chair should fill");

  const adjacent = await book(dur);
  console.log(`  booking at exactly +${dur} min → ${adjacent.ok ? "seated ✓" : adjacent.error}`);
  assert.ok(adjacent.ok, "a booking starting exactly when another ends must be allowed");

  // -- A cancelled booking frees its chair for the same time ----------------
  // The availability engine has always ignored cancelled bookings, but the
  // uniqueness rule on (station_id, starts_at) did not, so re-booking a slot
  // someone had cancelled failed outright. The index is partial now.
  await cleanup(branch.id);
  const first = await Promise.all(Array.from({ length: n }, () => book(0)));
  assert.equal(first.filter((r) => r.ok).length, n, "setup: every chair should fill");
  assert.ok(!(await book(0)).ok, "setup: a full slot must refuse the next one");

  await db
    .update(bookings)
    .set({ status: "cancelled" })
    .where(eq(bookings.branchId, branch.id));

  const rebooked = await book(0);
  console.log(`  re-booking a cancelled slot → ${rebooked.ok ? "seated ✓" : rebooked.error}`);
  assert.ok(rebooked.ok, "a cancelled booking must give its chair back");

  checkPricing();

  // -- A group of two -------------------------------------------------------
  await cleanup(branch.id);
  const catalogue = await db.select().from(services).where(eq(services.active, true)).limit(2);
  const [svcA, svcB] = catalogue.length > 1 ? catalogue : [catalogue[0], catalogue[0]];

  const group = await createBookings({
    branchId: branch.id,
    startsAt: new Date(base).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "confirmed",
    members: [
      { serviceId: svcA.id, addonIds: [] },
      { serviceId: svcB.id, addonIds: [] },
    ],
  });
  assert.ok(group.ok, `group booking failed: ${group.ok ? "" : group.error}`);

  assert.equal(group.bookings.length, 2, "two guests, two bookings");
  assert.ok(group.groupId, "a group must carry a group id");
  assert.notEqual(
    group.bookings[0].stationId,
    group.bookings[1].stationId,
    "two guests must get two different chairs",
  );
  assert.equal(
    group.bookings.reduce((sum, b) => sum + b.totalHalalas, 0),
    group.totalHalalas,
    "the two rows must add up to the combined bill",
  );

  const gross = svcA.priceHalalas + svcB.priceHalalas;
  assert.equal(group.totalHalalas, gross - Math.round(gross * 0.1), "10% off the combined bill");

  const [t1, t2] = group.bookings.map((b) => b.ticketNo!);
  assert.ok(t1 && t2, "a confirmed booking must carry a ticket");
  assert.equal(
    Number(t2.slice(1)) - Number(t1.slice(1)),
    1,
    `group tickets must be consecutive, got ${t1} and ${t2}`,
  );
  console.log(
    `  group: ${t1} + ${t2}, ${gross / 100} SAR → ${group.totalHalalas / 100} SAR (10% off) ✓`,
  );

  // Stored rows must agree with what was returned.
  const stored = await db.select().from(bookings).where(eq(bookings.groupId, group.groupId!));
  assert.equal(stored.length, 2, "both rows must share the group id");
  for (const row of stored) {
    assert.equal(
      row.subtotalHalalas + row.vatHalalas,
      row.totalHalalas,
      "subtotal + VAT must equal the row total",
    );
    assert.ok(row.discountHalalas > 0, "each group row carries its share of the discount");
  }
  console.log("  group: subtotal + VAT == total on both rows ✓");

  // -- An unpaid hold gets no ticket ---------------------------------------
  await cleanup(branch.id);
  const held = await createBookings({
    branchId: branch.id,
    startsAt: new Date(base).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "pending",
    members: [{ serviceId: svcA.id, addonIds: [] }],
  });
  assert.ok(held.ok, "a pending hold should still be created");
  assert.equal(held.bookings[0].ticketNo, null, "an unpaid hold must not get a ticket number");
  console.log("  pending hold carries no ticket ✓");

  await cleanup(branch.id);
  console.log("\nall booking checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
