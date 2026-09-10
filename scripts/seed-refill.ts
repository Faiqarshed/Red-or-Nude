// A finished appointment with an open refill window, to click through by hand.
//
//   npx tsx --conditions=react-server scripts/seed-refill.ts
//
// Prints a reference. Two ways in:
//   /booking?refill=<reference>   the page quotes the refill, no proof needed
//   /my-bookings                  the reference plus an emailed OTP
// Confirming either charges what lib/bookings.ts prices, so the whole flat-99
// path gets exercised end to end.
//
// Picks the most expensive service that has a window, because that is where a
// flat price is most visibly not a percentage: 280 SAR of work for 99.

// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, branches, customers, services, stations } from "@/lib/db/schema";
import { halalasToSar, vatIncludedIn } from "@/lib/money";

const DAYS_AGO = 3;

/** Where the OTP goes, so the /my-bookings route can be tested for real. */
const EMAIL = "humayunbaig046@gmail.com";

async function main() {
  const [branch] = await db.select().from(branches).where(eq(branches.active, true)).limit(1);
  const [service] = await db
    .select()
    .from(services)
    // A service with no window carries no refill at all, so it cannot be used here.
    .where(and(eq(services.active, true), gt(services.refillDays, 0)))
    .orderBy(desc(services.priceHalalas))
    .limit(1);
  assertFound(branch, "no active branch — run `npm run db:seed`");
  assertFound(service, "no service with refill_days > 0 — run `npm run db:seed`");

  const [station] = await db
    .select()
    .from(stations)
    .where(and(eq(stations.branchId, branch.id), eq(stations.active, true)))
    .limit(1);
  assertFound(station, "no active chair at that branch");

  // Reused across runs so repeat seeding doesn't litter the customer list.
  const phone = "0500000009";
  const [existing] = await db.select().from(customers).where(eq(customers.phone, phone)).limit(1);
  const customer =
    existing ??
    (
      await db
        .insert(customers)
        .values({ phone, name: "Refill Tester", email: EMAIL })
        .returning()
    )[0];

  // A customer row from an earlier run may carry a different address.
  if (customer.email !== EMAIL) {
    await db.update(customers).set({ email: EMAIL }).where(eq(customers.id, customer.id));
  }

  const startsAt = new Date(Date.now() - DAYS_AGO * 86_400_000);
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  const code = `RON-RF${String(Date.now()).slice(-3)}`;
  const total = service.priceHalalas;
  const vat = vatIncludedIn(total, 15);

  await db.insert(bookings).values({
    code,
    branchId: branch.id,
    customerId: customer.id,
    stationId: station.id,
    serviceId: service.id,
    startsAt,
    endsAt,
    // `completed` is the salon having pressed End. Anything less than served
    // grants no refill — see refillDaysLeft in lib/refill.ts.
    status: "completed",
    source: "web",
    customerName: customer.name,
    serviceName: service.name,
    servicePriceHalalas: service.priceHalalas,
    subtotalHalalas: total - vat,
    vatHalalas: vat,
    totalHalalas: total,
  });

  const daysLeft = service.refillDays - DAYS_AGO;
  console.log("");
  console.log(`  reference   ${code}`);
  console.log(`  service     ${service.name.en} — paid ${halalasToSar(total)} SAR`);
  console.log(`  had it      ${DAYS_AGO} days ago, at ${branch.name.en}`);
  console.log(`  refill      99 SAR, ${daysLeft} days left of a ${service.refillDays}-day window`);
  console.log(`  email       ${EMAIL}  (where the /my-bookings OTP goes)`);
  console.log("");
  console.log(`  open        http://localhost:3000/booking?refill=${code}`);
  console.log("");
}

function assertFound<T>(row: T | undefined, why: string): asserts row is T {
  if (!row) {
    console.error(`\n  ${why}\n`);
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
