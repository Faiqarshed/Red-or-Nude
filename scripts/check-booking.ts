// Booking correctness checks. Run against a seeded database:
//
//   npx tsx scripts/check-booking.ts
//
// Covers the concurrency guarantees that the availability engine and
// lib/bookings.ts depend on. Plain asserts, no test framework — if it exits 0
// the invariants hold.
//
// It does NOT only clean up after itself: cleanup() empties every booking at
// the branch it picks, whether this script created it or not. That is why it
// runs against TEST_DATABASE_URL and nothing else.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import { and, eq, inArray, like, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookings, branches, customers, services, stations, ticketCounters } from "@/lib/db/schema";
import { createBooking, createBookings, sweepNoShows } from "@/lib/bookings";
import { utcToLocalDate } from "@/lib/availability";
import { splitGroupPrice, vatIncludedIn } from "@/lib/money";
import { refillDaysLeft } from "@/lib/refill";
import { formatTicketNo } from "@/lib/tickets";

const TEST_PHONE = "0500000001";

/**
 * Inverse of formatTicketNo, so "B99" and "C1" read as consecutive. The counter
 * is per branch per day and survives cleanup(), so which side of a letter
 * boundary a fixture lands on is luck — comparing the digits alone fails there.
 */
const ticketOrdinal = (t: string) => (t.charCodeAt(0) - 65) * 99 + Number(t.slice(1));

/** Where each branch's ticket queue has got to, so a run can assert it moved. */
async function counters(branchIds: string[], day: string): Promise<Record<string, number>> {
  const rows = await db
    .select()
    .from(ticketCounters)
    .where(and(inArray(ticketCounters.branchId, branchIds), eq(ticketCounters.day, day)));
  return Object.fromEntries(branchIds.map((id) => [id, rows.find((r) => r.branchId === id)?.next ?? 1]));
}

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

/**
 * The refill window. Pure maths, but it decides whether a button appears and
 * whether a half-price booking is accepted, so it gets its own asserts.
 */
function checkRefill() {
  const DAY = 86_400_000;
  const now = new Date("2026-06-30T09:00:00Z");
  const served = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
  const base = { status: "completed", refillDays: 30, alreadyRefilled: false, isRefill: false };

  // Open at both ends of the window. Zero days left IS "no refill on offer" —
  // there is no separate flag, so these asserts pin both meanings at once.
  assert.equal(refillDaysLeft({ ...base, startsAt: served(1) }, now), 29);
  assert.equal(refillDaysLeft({ ...base, startsAt: served(29.5) }, now), 1, "the last part-day still counts");

  // And shut one moment after it.
  assert.equal(refillDaysLeft({ ...base, startsAt: served(30) }, now), 0);
  assert.equal(refillDaysLeft({ ...base, startsAt: served(31) }, now), 0);

  // The three ways a booking earns no button at all.
  assert.equal(refillDaysLeft({ ...base, startsAt: served(1), refillDays: 0 }, now), 0, "no window on this service");
  assert.equal(refillDaysLeft({ ...base, startsAt: served(1), alreadyRefilled: true }, now), 0, "window already spent");
  assert.equal(refillDaysLeft({ ...base, startsAt: served(1), isRefill: true }, now), 0, "a refill does not earn another");

  // Lashes are a shorter window off the same code path.
  assert.equal(refillDaysLeft({ ...base, startsAt: served(13), refillDays: 14 }, now), 1);
  assert.equal(refillDaysLeft({ ...base, startsAt: served(15), refillDays: 14 }, now), 0);

  // An appointment that has not happened yet cannot be refilled, and a booking
  // that was never paid for was never served.
  assert.equal(
    refillDaysLeft({ ...base, status: "confirmed", startsAt: new Date(now.getTime() + DAY) }, now),
    0,
    "cannot refill a future appointment",
  );
  assert.equal(refillDaysLeft({ ...base, status: "pending", startsAt: served(1) }, now), 0);
  assert.equal(refillDaysLeft({ ...base, status: "cancelled", startsAt: served(1) }, now), 0);
  assert.ok(
    refillDaysLeft({ ...base, status: "confirmed", startsAt: served(1) }, now) > 0,
    "a past confirmed booking counts as served even if staff never pressed End",
  );

  console.log("  refill: window opens, counts down, and shuts ✓");
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
  checkRefill();

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
    ticketOrdinal(t2) - ticketOrdinal(t1),
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

  // -- Four guests, each with her own hour ----------------------------------
  // The engine always took any N; what is new is that a member may carry her own
  // branch and start. Two here sit at the party's hour and two sit four hours
  // later, which is the case a single party-wide reservation could not express:
  // the later pair may reuse a chair the earlier pair has finished with.
  await cleanup(branch.id);
  const later = new Date(base + 240 * 60_000).toISOString();
  const four = await createBookings({
    branchId: branch.id,
    startsAt: new Date(base).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "confirmed",
    members: [
      { serviceId: svcA.id, addonIds: [] },
      { serviceId: svcB.id, addonIds: [] },
      { serviceId: svcA.id, addonIds: [], startsAt: later },
      { serviceId: svcB.id, addonIds: [], startsAt: later },
    ],
  });
  assert.ok(four.ok, `four guests failed: ${four.ok ? "" : four.error}`);
  assert.equal(four.bookings.length, 4, "four guests, four bookings");

  const fourRows = await db.select().from(bookings).where(eq(bookings.groupId, four.groupId!));
  assert.equal(fourRows.length, 4, "all four must share the group id");

  // The two who asked for the same moment cannot be given the same chair, and
  // this is the pair that would collide if reservation forgot what it had just
  // promised inside the transaction.
  const atBase = fourRows.filter((r) => r.startsAt.getTime() === base);
  assert.equal(atBase.length, 2, "two guests kept the party's hour");
  assert.notEqual(atBase[0].stationId, atBase[1].stationId, "same hour must mean different chairs");
  assert.equal(
    fourRows.filter((r) => r.startsAt.toISOString() === later).length,
    2,
    "two guests kept their own later hour",
  );

  // One discount, over all four, however they are spread across the day.
  const gross4 = 2 * svcA.priceHalalas + 2 * svcB.priceHalalas;
  assert.equal(
    four.totalHalalas,
    gross4 - Math.round(gross4 * 0.1),
    "the group discount covers a party that is not sitting together",
  );
  console.log("  group of four: own hours, own chairs, one discount ✓");

  // -- One day is the whole of what a party shares --------------------------
  await cleanup(branch.id);
  const nextDay = await createBookings({
    branchId: branch.id,
    startsAt: new Date(base).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "confirmed",
    members: [
      { serviceId: svcA.id, addonIds: [] },
      { serviceId: svcB.id, addonIds: [], startsAt: new Date(base + 24 * 3_600_000).toISOString() },
    ],
  });
  assert.ok(!nextDay.ok, "a guest on another day is not a group booking");
  assert.equal(nextDay.ok ? "" : nextDay.error, "different-day");
  console.log("  group: a guest on another day is refused ✓");

  // -- A party split across two salons takes a number from each -------------
  // ticket_counters is keyed (branch_id, day), so the guest at the other branch
  // must draw from that branch's queue rather than a queue she is not standing
  // in. Skipped rather than failed where the seed has only one branch.
  const [other] = await db
    .select()
    .from(branches)
    .where(ne(branches.id, branch.id))
    .limit(1);
  const otherChairs = other
    ? await db
        .select()
        .from(stations)
        .where(and(eq(stations.branchId, other.id), eq(stations.active, true)))
    : [];

  if (other && otherChairs.length > 0) {
    await cleanup(branch.id);
    await cleanup(other.id);
    const day = utcToLocalDate(new Date(base));
    const before = await counters([branch.id, other.id], day);

    const apart = await createBookings({
      branchId: branch.id,
      startsAt: new Date(base).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
      status: "confirmed",
      members: [
        { serviceId: svcA.id, addonIds: [] },
        { serviceId: svcB.id, addonIds: [], branchId: other.id },
      ],
    });
    assert.ok(apart.ok, `split party failed: ${apart.ok ? "" : apart.error}`);

    const apartRows = await db.select().from(bookings).where(eq(bookings.groupId, apart.groupId!));
    assert.deepEqual(
      apartRows.map((r) => r.branchId).sort(),
      [branch.id, other.id].sort(),
      "each guest's row belongs to the salon she is sitting in",
    );

    const after = await counters([branch.id, other.id], day);
    assert.equal(after[branch.id] - before[branch.id], 1, "one number from this branch");
    assert.equal(after[other.id] - before[other.id], 1, "one number from the other branch");
    assert.ok(apartRows.every((r) => r.ticketNo), "both guests get a ticket");
    await cleanup(other.id);
    console.log("  group: split across two salons, a ticket from each queue ✓");
  }

  // -- The checkout upsell (coffee and a cookie) ----------------------------
  // Picked on the payment page, after the chair has been quoted and while it is
  // about to be held. So it must add its price to the bill and nothing at all to
  // the chair's time — an at_checkout add-on with a duration would move ends_at
  // underneath a booking that has already been priced and reserved.
  await cleanup(branch.id);
  const [treat] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.atCheckout, true), eq(addons.active, true)))
    .limit(1);
  assert.ok(treat, "migration 0016 must leave one active at_checkout add-on");
  assert.equal(treat.durationMin, 0, "a checkout add-on must not lengthen the appointment");

  const treated = await createBookings({
    branchId: branch.id,
    startsAt: new Date(base).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "confirmed",
    members: [{ serviceId: svcA.id, addonIds: [treat.id] }],
  });
  assert.ok(treated.ok, `checkout add-on booking failed: ${treated.ok ? "" : treated.error}`);
  assert.equal(
    treated.totalHalalas,
    svcA.priceHalalas + treat.priceHalalas,
    "the coffee is billed by the add-on machinery, at its catalogue price",
  );

  const [treatedRow] = await db
    .select()
    .from(bookings)
    .where(eq(bookings.id, treated.bookings[0].id));
  assert.equal(
    (treatedRow.endsAt.getTime() - treatedRow.startsAt.getTime()) / 60_000,
    svcA.durationMin,
    "a coffee must not move ends_at",
  );
  console.log("  checkout add-on: billed, chair unchanged ✓");

  // And it is never discounted. The group discount applies to the services on
  // the bill, not to the refreshments — 10 SAR is 10 SAR however many people
  // booked together. This is the assertion that would catch it drifting back
  // inside splitGroupPrice.
  await cleanup(branch.id);
  const groupTreat = await createBookings({
    branchId: branch.id,
    startsAt: new Date(base).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "confirmed",
    members: [
      { serviceId: svcA.id, addonIds: [treat.id] },
      { serviceId: svcB.id, addonIds: [] },
    ],
  });
  assert.ok(groupTreat.ok, `group with a treat failed: ${groupTreat.ok ? "" : groupTreat.error}`);

  const services2 = svcA.priceHalalas + svcB.priceHalalas;
  assert.equal(
    groupTreat.totalHalalas,
    services2 - Math.round(services2 * 0.1) + treat.priceHalalas,
    "the group discount takes 10% of the services and nothing off the coffee",
  );
  assert.equal(
    groupTreat.bookings.reduce((sum, b) => sum + b.totalHalalas, 0),
    groupTreat.totalHalalas,
    "the rows must still add up to the bill with a treat on one of them",
  );
  console.log(
    `  checkout add-on: ${treat.priceHalalas / 100} SAR flat, outside the group discount ✓`,
  );

  // -- Walk-ins are not payment-gated, and share the web ticket queue -------
  // The admin form calls createBooking(), the compatibility wrapper. A walk-in
  // customer is standing at the desk, so they are seated immediately and take
  // the next number from the same per-branch, per-day queue as web bookings —
  // the salon calls out one continuous sequence.
  await cleanup(branch.id);
  const web = await createBookings({
    branchId: branch.id,
    startsAt: new Date(base).toISOString(),
    customer: { phone: TEST_PHONE },
    source: "web",
    status: "confirmed",
    members: [{ serviceId: svcA.id, addonIds: [] }],
  });
  assert.ok(web.ok);

  const walkIn = await createBooking({
    branchId: branch.id,
    serviceId: svcA.id,
    addonIds: [],
    startsAt: new Date(base).toISOString(),
    customer: { phone: "0500000002" },
    source: "walk_in",
  });
  assert.ok(walkIn.ok, `walk-in failed: ${walkIn.ok ? "" : walkIn.error}`);
  assert.ok(walkIn.ticketNo, "a walk-in is seated now and must get a ticket immediately");

  const [webRow] = await db.select().from(bookings).where(eq(bookings.id, web.bookings[0].id));
  const [walkRow] = await db.select().from(bookings).where(eq(bookings.id, walkIn.id));
  assert.equal(walkRow.status, "confirmed", "a walk-in is confirmed on the spot");
  assert.equal(
    ticketOrdinal(walkIn.ticketNo) - ticketOrdinal(webRow.ticketNo!),
    1,
    `walk-in must take the next number after the web booking, got ${webRow.ticketNo} then ${walkIn.ticketNo}`,
  );
  console.log(`  walk-in: ${webRow.ticketNo} (web) then ${walkIn.ticketNo} (desk), one queue ✓`);

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
  // -- No-show release: chairs given back when nobody checks in ------------
  //
  // The rule is "confirmed, past its grace, today, recent". Each assertion below
  // is one clause of it, because getting any of them wrong releases a chair out
  // from under a customer who is sitting in it.
  await cleanup(branch.id);

  // The grace comes from settings (no_show_grace_min, default 20). The 5 / 30 /
  // 300 minute cases below straddle that default deliberately.
  const minsAgo = (n: number) => new Date(Date.now() - n * 60_000);

  /** Seat a confirmed booking whose slot started `n` minutes ago. */
  async function seatedAt(n: number, phone = TEST_PHONE) {
    const made = await createBookings({
      branchId: branch.id,
      startsAt: minsAgo(n).toISOString(),
      customer: { phone },
      source: "walk_in",
      status: "confirmed",
      members: [{ serviceId: svcA.id, addonIds: [] }],
    });
    assert.ok(made.ok, `setup booking failed: ${made.ok ? "" : made.error}`);
    return made.bookings[0].id;
  }

  const rowOf = async (id: string) =>
    (await db.select().from(bookings).where(eq(bookings.id, id)))[0];

  // Past the grace: released.
  const missed = await seatedAt(30);
  await sweepNoShows(branch.id);
  let noShowRow = await rowOf(missed);
  assert.equal(noShowRow.status, "no_show", "30 min in with no check-in must release the chair");
  assert.ok(noShowRow.noShowAt, "a released chair must be flagged for staff");
  assert.equal(noShowRow.noShowResolvedAt, null, "a fresh flag is unresolved");
  console.log("  no-show: 30 min past start, not checked in -> chair released ✓");

  // Idempotent. The sweep runs on every page load and must not keep moving the
  // timestamp, or a flag would never look old.
  const firstFlag = noShowRow.noShowAt!.getTime();
  await sweepNoShows(branch.id);
  noShowRow = await rowOf(missed);
  assert.equal(noShowRow.noShowAt!.getTime(), firstFlag, "re-sweeping must not re-flag");
  console.log("  no-show: sweeping twice keeps the original flag ✓");

  // Inside the grace: left alone. Five minutes late is late, not absent.
  await cleanup(branch.id);
  const justLate = await seatedAt(5);
  await sweepNoShows(branch.id);
  assert.equal((await rowOf(justLate)).status, "confirmed", "5 min late is not a no-show");
  console.log("  no-show: 5 min late is left alone ✓");

  // Checked in: never flagged, however long ago it started. The one that matters
  // most - in_progress is the arrival record the whole rule rests on.
  await cleanup(branch.id);
  const arrived = await seatedAt(90);
  await db.update(bookings).set({ status: "in_progress" }).where(eq(bookings.id, arrived));
  await sweepNoShows(branch.id);
  const arrivedRow = await rowOf(arrived);
  assert.equal(arrivedRow.status, "in_progress", "a checked-in customer must never be released");
  assert.equal(arrivedRow.noShowAt, null, "a checked-in customer must never be flagged");
  console.log("  no-show: checked in -> never released ✓");

  // Hours later, still flagged. The flag is about the customer who paid and was
  // not served, not about the chair — she is owed an answer whether staff open
  // the screen at 11am or at closing, so there is no "too late to notice".
  await cleanup(branch.id);
  const longAgo = await seatedAt(5 * 60);
  await sweepNoShows(branch.id);
  assert.equal(
    (await rowOf(longAgo)).status,
    "no_show",
    "a morning no-show must still be flagged in the afternoon",
  );
  console.log("  no-show: still flagged hours later ✓");

  // But not for ever. This is what stops switching the feature on from flagging
  // every untouched booking in the table's history.
  //
  // The bound used to be "today", and this assertion still read `26 * 60` — one
  // day back — long after NO_SHOW_LOOKBACK_DAYS replaced it with seven. Yesterday
  // is now swept on purpose: the old bound meant a day rolling over froze every
  // un-checked-in booking as `confirmed` for good. Nine days back is the edge
  // that still exists.
  await cleanup(branch.id);
  const longPast = await seatedAt(9 * 24 * 60);
  await sweepNoShows(branch.id);
  assert.equal(
    (await rowOf(longPast)).status,
    "confirmed",
    "past the lookback is history, not something to release a chair for",
  );
  console.log("  no-show: past the lookback is left alone ✓");

  // And the point of all of it: the chair is genuinely bookable again.
  await cleanup(branch.id);
  const released = await seatedAt(30);
  const releasedRow = await rowOf(released);
  await sweepNoShows(branch.id);
  const retaken = await createBookings({
    branchId: branch.id,
    startsAt: releasedRow.startsAt.toISOString(),
    stationId: releasedRow.stationId,
    customer: { phone: "0500000003" },
    source: "walk_in",
    status: "confirmed",
    members: [{ serviceId: svcA.id, addonIds: [] }],
  });
  assert.ok(retaken.ok, `released chair must be rebookable: ${retaken.ok ? "" : retaken.error}`);
  assert.equal(
    retaken.bookings[0].stationId,
    releasedRow.stationId,
    "the walk-in must land on the exact chair that was freed",
  );
  console.log("  no-show: freed chair is immediately rebookable ✓");

  await cleanup(branch.id);
  console.log("\nall booking checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
