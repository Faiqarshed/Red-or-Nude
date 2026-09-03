/**
 * A floor to test the day-start assignment against (docs/DAY-START-ASSIGNMENT.md).
 *
 *   npm run seed:day
 *
 * Three technicians at the first branch, and six confirmed bookings for today —
 * two of them at the same moment, so the overlap rule has something to trip on.
 * Every booking is left **unassigned**, which is the state the morning run
 * expects to find.
 *
 * Re-runnable: it deletes today's bookings belonging to its own seed customers
 * before making new ones, and touches nothing else. Real customers, real
 * bookings and the existing staff list are never modified.
 *
 * Bookings go through createBookings(), the same path the website uses, so the
 * chairs, ticket numbers and totals are allocated for real rather than being
 * hand-written rows that only look like bookings.
 */

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
//
// Placement is load-bearing, not decorative. This sat at the bottom of the
// file and worked only because ES modules hoist a static import above the
// top-level main() call — while every other dependency here is a dynamic
// `await import()` inside main(). An edit tidying this one to match its
// neighbours would have removed the gate without removing the line.
import "./_test-db";

/** Every seeded account signs in with this. Fixture data; not a secret. */
const PASSWORD = "salon1234";

/**
 * The floor, and the desk in front of it.
 *
 * The receptionist earns her place here because `/admin` renders the front desk
 * *for a receptionist* — signed in as the CEO you get the dashboard instead, and
 * `next dev` signs you in as the CEO.
 *
 * Emails are the key this script upserts on, so re-runs don't duplicate.
 */
const STAFF = [
  { name: "Front desk (seed)", email: "desk@seed.local", role: "receptionist" as const },
  { name: "Sara (seed)", email: "sara.tech@seed.local", role: "technician" as const },
  { name: "Noura (seed)", email: "noura.tech@seed.local", role: "technician" as const },
  { name: "Lama (seed)", email: "lama.tech@seed.local", role: "technician" as const },
];

/**
 * The day, as minutes after the first appointment.
 *
 * Relative rather than clock hours, because createBookings() runs the no-show
 * sweep on its way in: a fixture written at 10:00 and seeded at 15:00 is marked
 * `no_show` before you can test anything with it. Everything here is ahead of
 * whenever you run the script.
 *
 * Zero twice on purpose: two customers starting at the same moment must land on
 * two different technicians, and that is the case a count-based rule alone gets
 * wrong. The +30 sits inside the opening Acrylic (90 min) for the same reason.
 */
const DAY = [
  { after: 0, service: "Acrylic", customer: "Hessa" },
  { after: 0, service: "Gel Polish", customer: "Reem" },
  { after: 30, service: "Classic Manicure", customer: "Dana" },
  { after: 90, service: "BIAB", customer: "Aljohara" },
  { after: 150, service: "Gel Polish", customer: "Mona" },
  { after: 210, service: "Classic Manicure", customer: "Wjdan" },
];

/** 05000001NN — distinctive enough to recognise as fixture data at the desk. */
const phoneFor = (i: number) => `05000001${String(i + 1).padStart(2, "0")}`;

async function main() {
  const { hash } = await import("bcryptjs");
  const { and, asc, eq, gte, inArray, lt } = await import("drizzle-orm");
  const { db } = await import("../lib/db");
  const s = await import("../lib/db/schema");
  const { createBookings } = await import("../lib/bookings");
  const { localTime, riyadhDayRange } = await import("../lib/time");

  const [branch] = await db
    .select({ id: s.branches.id, name: s.branches.name })
    .from(s.branches)
    .orderBy(asc(s.branches.sort))
    .limit(1);

  if (!branch) {
    console.error("No branches. Run `npm run db:seed` first.");
    process.exit(1);
  }
  console.log(`→ branch: ${branch.name.en}`);

  // ---- accounts ------------------------------------------------------------
  const passwordHash = await hash(PASSWORD, 10);
  for (const person of STAFF) {
    await db
      .insert(s.staff)
      .values({ ...person, branchId: branch.id, active: true, passwordHash })
      // Re-runs put them back on the floor: the whole point of a test seed is
      // that deactivating someone by hand, then re-seeding, gives you a clean
      // floor again rather than a mystery.
      .onConflictDoUpdate({
        target: s.staff.email,
        set: { role: person.role, branchId: branch.id, active: true, passwordHash },
      });
  }

  console.log(`→ ${STAFF.length} accounts (password: ${PASSWORD})`);
  for (const person of STAFF) console.log(`   ${person.role.padEnd(13)}${person.email}`);

  // Anyone already at this branch counts toward the spread too, so say so rather
  // than letting the tester wonder why six bookings went four ways.
  const onFloor = await db
    .select({ name: s.staff.name })
    .from(s.staff)
    .where(
      and(
        eq(s.staff.active, true),
        eq(s.staff.role, "technician"),
        eq(s.staff.branchId, branch.id),
      ),
    );
  console.log(`   floor is now ${onFloor.length}: ${onFloor.map((t) => t.name).join(", ")}`);

  // ---- clear the last run's day -------------------------------------------
  const phones = DAY.map((_, i) => phoneFor(i));
  const seedCustomers = await db
    .select({ id: s.customers.id })
    .from(s.customers)
    .where(inArray(s.customers.phone, phones));

  const { start, end } = riyadhDayRange();
  if (seedCustomers.length > 0) {
    const ids = seedCustomers.map((c) => c.id);
    // Scoped three ways — these customers, this branch, today — so a re-run
    // cannot reach a real booking or a previous day's fixture.
    const gone = await db
      .delete(s.bookings)
      .where(
        and(
          inArray(s.bookings.customerId, ids),
          eq(s.bookings.branchId, branch.id),
          gte(s.bookings.startsAt, start),
          lt(s.bookings.startsAt, end),
        ),
      )
      .returning({ id: s.bookings.id });
    if (gone.length > 0) console.log(`→ cleared ${gone.length} booking(s) from the last run`);
  }

  // ---- today ---------------------------------------------------------------
  //
  // The first appointment: the next half hour that is at least fifteen minutes
  // away, so nothing is already in the past and the front desk's early-check-in
  // guard has something to refuse.
  const SLOT_MS = 30 * 60_000;
  const anchor = new Date(Math.ceil((Date.now() + 15 * 60_000) / SLOT_MS) * SLOT_MS);

  const services = await db.select().from(s.services);
  const byName = new Map(services.map((svc) => [svc.name.en, svc]));

  let made = 0;
  for (const [i, slot] of DAY.entries()) {
    const service = byName.get(slot.service);
    if (!service) {
      console.log(`   skipped ${slot.customer}: no "${slot.service}" in the catalogue`);
      continue;
    }

    const startsAt = new Date(anchor.getTime() + slot.after * 60_000);

    const result = await createBookings({
      branchId: branch.id,
      startsAt: startsAt.toISOString(),
      customer: { name: slot.customer, phone: phoneFor(i), lang: "en" },
      // Walk-in, so it is confirmed immediately: a `pending` hold is unpaid and
      // the assignment run deliberately ignores those.
      source: "walk_in",
      status: "confirmed",
      members: [{ serviceId: service.id, addonIds: [] }],
      notes: "seed-day fixture",
    });

    if (!result.ok) {
      console.log(`   skipped ${slot.customer} at ${localTime(startsAt.toISOString())} — ${result.error}`);
      continue;
    }
    made++;
  }

  console.log(`→ ${made} confirmed booking(s), all unassigned, from ${localTime(anchor.toISOString())}`);
  console.log("");
  console.log("Now try:");
  console.log("  curl -H \"Authorization: Bearer $CRON_SECRET\" localhost:3000/api/cron/assign-day");
  console.log("  …then sign in at /admin/login as desk@seed.local — /admin is the front desk.");
  console.log("  Full script: docs/DAY-START-ASSIGNMENT.md Part 2.");
}

main().then(() => process.exit(0));
