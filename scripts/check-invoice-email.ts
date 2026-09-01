// End-to-end check for the invoice email, through the real payment path.
//
//   npm run check:invoice -- you@example.com
//
// Unlike scripts/preview-invoice.ts, which renders a made-up bill, this books a
// real appointment, charges it through confirmBookingPayment() and lets that
// function send the invoice itself. Nothing is stubbed: if the mail arrives, the
// production path works.
//
// The gateway is still lib/payments/fake.ts, which approves every charge — so
// this exercises everything except the gateway call itself.
//
// It writes real rows to whatever DATABASE_URL points at, then deletes exactly
// the ones it created. Point it at a development database.
// Must come first: this points DATABASE_URL at the local test database and
// refuses to run if there isn't one. See scripts/_test-db.ts.
import "./_test-db";

import assert from "node:assert";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, branches, customers, payments, services, stations } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { confirmBookingPayment } from "@/lib/payments/confirm";
import { buildBookingInvoice } from "@/lib/invoice/data";

const TEST_PHONE = "0500000009";

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes("@")) {
    console.error("Usage: npm run check:invoice -- you@example.com");
    process.exit(1);
  }

  // Both shapes, because they are the same code path with a different member
  // count — which is exactly the claim worth checking rather than assuming.
  for (const guests of [1, 2] as const) {
    console.log(`\n── ${guests === 1 ? "single booking" : "group booking (2 guests)"} ──`);
    await run(to, guests);
  }
}

async function run(to: string, guests: 1 | 2) {

  const [branch] = await db.select().from(branches).limit(1);
  const catalogue = await db.select().from(services).where(eq(services.active, true)).limit(2);
  assert.ok(branch && catalogue.length, "run `npm run db:seed` first");

  const chairs = await db
    .select()
    .from(stations)
    .where(and(eq(stations.branchId, branch.id), eq(stations.active, true)));
  assert.ok(chairs.length >= 2, "need at least 2 chairs to book a group");

  // Far enough out that it can't collide with real or seeded appointments.
  // Separate slots per scenario so the two runs can't contend for a chair.
  const startsAt = new Date(Date.UTC(2030, 6, 14 + guests, 6, 0)).toISOString(); // 09:00 Riyadh
  const [svcA, svcB] = catalogue.length > 1 ? catalogue : [catalogue[0], catalogue[0]];

  let bookingIds: string[] = [];

  try {
    // -- 1. Hold the chair(s), exactly as POST /api/bookings does -----------
    const held = await createBookings({
      branchId: branch.id,
      startsAt,
      customer: { name: "Invoice Test", phone: TEST_PHONE, email: to, lang: "en" },
      source: "web",
      status: "pending", // the whole point: unpaid, unconfirmed, no ticket yet
      members:
        guests === 1
          ? [{ serviceId: svcA.id, addonIds: [] }]
          : [
              { serviceId: svcA.id, addonIds: [] },
              { serviceId: svcB.id, addonIds: [] },
            ],
    });
    assert.ok(held.ok, `booking failed: ${held.ok ? "" : held.error}`);
    bookingIds = held.bookings.map((b) => b.id);

    assert.equal(held.bookings.length, guests, "one booking row per guest");
    assert.ok(
      held.bookings.every((b) => b.ticketNo === null),
      "a pending booking must not have a ticket yet",
    );
    console.log(`held ${guests} chair(s), ${held.totalHalalas / 100} SAR, no tickets yet ✓`);

    // -- 2. Charge it. This is the call that emails the invoice. -------------
    const paid = await confirmBookingPayment({
      code: held.bookings[0].code,
      method: "mada",
    });
    assert.ok(paid.ok, `payment failed: ${paid.ok ? "" : paid.error}`);
    assert.equal(paid.tickets.length, guests, "one ticket per guest");
    console.log(
      `charged ${paid.totalHalalas / 100} SAR → tickets ${paid.tickets.map((t) => t.ticketNo).join(" + ")} ✓`,
    );

    // -- 3. The rows really moved -------------------------------------------
    const after = await db.select().from(bookings).where(inArray(bookings.id, bookingIds));
    assert.ok(
      after.every((b) => b.status === "confirmed" && b.ticketNo),
      "every booking on a paid bill must be confirmed and ticketed",
    );

    // -- 4. And the invoice says what the card was charged -------------------
    // Rebuilt here only to assert on it; confirmBookingPayment already sent it.
    const invoice = await buildBookingInvoice(bookingIds);
    assert.ok(invoice, "an invoice must be buildable for a booking with an email");
    assert.equal(invoice.customer.email, to, "the invoice must go to the email given at checkout");
    assert.equal(
      invoice.subtotalHalalas + invoice.vatHalalas,
      invoice.totalHalalas,
      "subtotal + VAT must equal the total",
    );
    assert.equal(
      invoice.totalHalalas,
      paid.totalHalalas,
      "the invoice must not disagree with what was charged",
    );
    console.log(
      `invoice ${invoice.number}: ${invoice.subtotalHalalas / 100} + ${invoice.vatHalalas / 100} VAT = ${invoice.totalHalalas / 100} SAR ✓`,
    );

    console.log(`  → look for "[invoice] ${invoice.number} sent to ${to}" above`);
  } finally {
    // Only ever the rows this run created.
    if (bookingIds.length) {
      await db.delete(payments).where(inArray(payments.bookingId, bookingIds));
      await db.delete(bookings).where(inArray(bookings.id, bookingIds));
    }
    await db.delete(customers).where(eq(customers.phone, TEST_PHONE));
    console.log("cleaned up");
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
