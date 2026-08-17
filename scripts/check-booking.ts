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
import { createBooking } from "@/lib/bookings";

const TEST_PHONE = "0500000001";

async function cleanup(branchId: string) {
  await db.delete(bookings).where(eq(bookings.branchId, branchId));
  await db.delete(customers).where(like(customers.phone, "05000000%"));
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

  await cleanup(branch.id);
  console.log("\nall booking checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
