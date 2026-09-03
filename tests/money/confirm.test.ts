// Taking the money, and the four ways that must not go wrong twice.
//
// The state machine is the movie-ticket model: POST /api/bookings holds the
// chair as `pending`, and only a successful charge here flips it to `confirmed`
// and issues the ticket number. Everything around the gateway is real even
// though the gateway is not — see docs/PAYMENTS-MOYASAR.md §1, which says so in
// as many words.
//
// What would be easy to break: the `pending`-only guard. It is one `.some()`
// call, and it is the only thing standing between a replayed confirm and a
// second set of ticket numbers, a second invoice and a second award of loyalty
// points for one appointment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, loyaltyTxns, payments } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);

// The confirm path emails an invoice and notifies. Neither may leave the box.
const mails = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/invoice/send", () => ({
  sendBookingInvoice: async (...a: unknown[]) => void mails.push(a),
}));
vi.mock("@/lib/notify", () => ({ notify: async (...a: unknown[]) => void mails.push(a) }));

const fx = new Fixtures();
beforeEach(() => {
  resetAppContext();
  mails.length = 0;
});
afterEach(() => fx.cleanup());

const SLOT = "2030-04-06T11:00:00.000Z";

async function held(opts: { members?: number; phone: string; price?: number }) {
  const { createBookings } = await import("@/lib/bookings");
  const branch = await fx.branch({ stationCount: 2 });
  const svc = await fx.service({ durationMin: 60, priceHalalas: opts.price ?? 25_000 });
  const made = await createBookings({
    branchId: branch.id,
    startsAt: SLOT,
    customer: { name: "Payer", phone: opts.phone, email: "payer@example.test" },
    source: "web",
    status: "pending",
    members: Array.from({ length: opts.members ?? 1 }, () => ({
      serviceId: svc.id,
      addonIds: [],
    })),
  });
  await fx.claimBookingsOf(branch.id);
  if (!made.ok) throw new Error(`fixture could not hold a chair: ${made.error}`);
  return { branch, svc, made };
}

/** Payment rows for a booking, so "was it charged once" is answerable. */
const paymentsFor = (bookingId: string) =>
  db.select().from(payments).where(eq(payments.bookingId, bookingId));

describe("confirming a held booking", () => {
  it("charges once, confirms, and issues exactly one ticket", async () => {
    const { made } = await held({ phone: "0540000001" });
    const code = made.bookings[0].code;

    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const result = await confirmBookingPayment({ code, method: "mada" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tickets).toHaveLength(1);
    expect(result.totalHalalas).toBe(25_000);

    const [row] = await db.select().from(bookings).where(eq(bookings.code, code));
    expect(row.status).toBe("confirmed");
    expect(row.ticketNo, "a confirmed booking with no queue number").not.toBeNull();

    const paid = await paymentsFor(row.id);
    expect(paid).toHaveLength(1);
    expect(paid[0].status).toBe("paid");
    // The row's amount equals its own booking's total, per the file comment.
    expect(paid[0].amountHalalas).toBe(row.totalHalalas);
  });

  it("refuses a replay, and does not issue a second ticket", async () => {
    // Run twice (Phase 10 lens 8). A double-tap on the pay button, or a retry
    // after a timeout the customer never saw resolve.
    const { made } = await held({ phone: "0540000002" });
    const code = made.bookings[0].code;

    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const first = await confirmBookingPayment({ code, method: "card" });
    expect(first.ok).toBe(true);

    const replay = await confirmBookingPayment({ code, method: "card" });
    expect(replay.ok, "the same booking was paid for twice").toBe(false);
    if (replay.ok) return;
    expect(replay.error).toBe("expired");

    const [row] = await db.select().from(bookings).where(eq(bookings.code, code));
    expect(await paymentsFor(row.id), "a second payments row was written").toHaveLength(1);
  });

  it("survives two confirms fired at the same moment", async () => {
    // The same thing as a race rather than a sequence, which is the shape a
    // double-click actually has.
    const { made } = await held({ phone: "0540000003" });
    const code = made.bookings[0].code;

    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const [a, b] = await Promise.all([
      confirmBookingPayment({ code, method: "card" }),
      confirmBookingPayment({ code, method: "card" }),
    ]);

    const [row] = await db.select().from(bookings).where(eq(bookings.code, code));
    const rows = await paymentsFor(row.id);
    const paidRows = rows.filter((r) => r.status === "paid");

    expect([a.ok, b.ok].filter(Boolean), "both confirms succeeded").toHaveLength(1);
    expect(paidRows, "the customer was charged twice").toHaveLength(1);
  });

  it("charges a group once and gives every guest their own ticket", async () => {
    const { made } = await held({ members: 2, phone: "0540000004" });
    expect(made.bookings).toHaveLength(2);

    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const result = await confirmBookingPayment({ code: made.bookings[0].code, method: "apple" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tickets, "a group of two got one ticket between them").toHaveLength(2);
    // One gateway transaction: both payment rows share a providerRef, and the
    // sum of the rows is the combined bill.
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.providerRef, (await paymentsFor(made.bookings[0].id))[0].providerRef!));
    expect(new Set(rows.map((r) => r.providerRef)).size).toBe(1);
    expect(rows.reduce((s, r) => s + r.amountHalalas, 0)).toBe(result.totalHalalas);
  });

  it("resolves the whole group from any member's code", async () => {
    const { made } = await held({ members: 2, phone: "0540000005" });
    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    // The *second* guest's code, not the anchor's.
    const result = await confirmBookingPayment({ code: made.bookings[1].code, method: "stc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tickets).toHaveLength(2);
  });
});

describe("when the charge does not go through", () => {
  it("leaves the hold in place so the slot is not lost", async () => {
    // Deliberate, and the file says why: the customer retries without
    // re-picking their slot, and an abandoned hold expires on its own.
    const { made } = await held({ phone: "0540000006" });
    const code = made.bookings[0].code;

    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const declined = await confirmBookingPayment({ code, method: "card", simulate: "decline" });
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error).toBe("payment-declined");

    const [row] = await db.select().from(bookings).where(eq(bookings.code, code));
    expect(row.status, "a declined card released the chair").toBe("pending");
    expect(row.ticketNo, "a declined card still issued a queue number").toBeNull();

    const rows = await paymentsFor(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });

  it("sends no invoice and awards no points on the failure path", async () => {
    // Negative space (Phase 10 lens 10): the absence is the assertion.
    const { made } = await held({ phone: "0540000007" });
    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    await confirmBookingPayment({
      code: made.bookings[0].code,
      method: "card",
      simulate: "decline",
    });

    expect(mails, "a declined payment still emailed the customer").toHaveLength(0);
    const points = await db
      .select()
      .from(loyaltyTxns)
      .where(eq(loyaltyTxns.bookingId, made.bookings[0].id));
    expect(points, "a declined payment still earned points").toHaveLength(0);
  });

  it("lets the customer retry after a decline and succeed", async () => {
    const { made } = await held({ phone: "0540000008" });
    const code = made.bookings[0].code;
    const { confirmBookingPayment } = await import("@/lib/payments/confirm");

    await confirmBookingPayment({ code, method: "card", simulate: "decline" });
    const retry = await confirmBookingPayment({ code, method: "card" });
    expect(retry.ok, "a customer could not retry after a decline").toBe(true);

    const [row] = await db.select().from(bookings).where(eq(bookings.code, code));
    // Two attempts, two rows — one failed, one paid. The history is kept.
    const rows = await paymentsFor(row.id);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "paid"]);
  });
});

describe("what cannot be paid for", () => {
  it("refuses a code that does not exist", async () => {
    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const result = await confirmBookingPayment({ code: "RON-NOPE", method: "card" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not-found");
  });

  it("refuses a booking that was already cancelled", async () => {
    const { made } = await held({ phone: "0540000009" });
    await db
      .update(bookings)
      .set({ status: "cancelled" })
      .where(eq(bookings.id, made.bookings[0].id));

    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const result = await confirmBookingPayment({ code: made.bookings[0].code, method: "card" });
    expect(result.ok, "a cancelled booking was charged for").toBe(false);
  });

  it("refuses a group where one member has already gone", async () => {
    // Partial state: one guest cancelled out of a pair. Charging the bill would
    // take money for a chair nobody is sitting in.
    const { made } = await held({ members: 2, phone: "0540000010" });
    await db
      .update(bookings)
      .set({ status: "cancelled" })
      .where(eq(bookings.id, made.bookings[1].id));

    const { confirmBookingPayment } = await import("@/lib/payments/confirm");
    const result = await confirmBookingPayment({ code: made.bookings[0].code, method: "card" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("expired");

    // And nothing was charged for the guest who is still there.
    expect(await paymentsFor(made.bookings[0].id)).toHaveLength(0);
  });
});

describe("the amount is the server's number, never the caller's", () => {
  it("ignores any total posted in the request body", async () => {
    // Phase 10 lens 5. The route's schema has no amount field at all, which is
    // the right answer — this proves it stays that way through the handler.
    const { made } = await held({ phone: "0540000011", price: 25_000 });
    const { POST } = await import("@/app/api/payments/confirm/route");
    const { post, read } = await import("../helpers/app");

    const { status } = await read(
      await POST(
        post("http://x/api/payments/confirm", {
          code: made.bookings[0].code,
          method: "mada",
          amountHalalas: 1, // the attack
          totalHalalas: 1,
        }),
      ),
    );
    expect(status).toBe(200);

    const rows = await paymentsFor(made.bookings[0].id);
    expect(rows[0].amountHalalas, "the caller set their own price").toBe(25_000);
  });

  it("refuses to honour a decline simulation in production", async () => {
    // The route strips `simulate` when NODE_ENV is production. Without that, a
    // caller could force declines on anyone's booking.
    const { made } = await held({ phone: "0540000012" });
    const { POST } = await import("@/app/api/payments/confirm/route");
    const { post, read } = await import("../helpers/app");

    const prev = process.env.NODE_ENV;
    // @ts-expect-error NODE_ENV is readonly in the types, writable at runtime.
    process.env.NODE_ENV = "production";
    try {
      const { status } = await read(
        await POST(
          post("http://x/api/payments/confirm", {
            code: made.bookings[0].code,
            method: "card",
            simulate: "decline",
          }),
        ),
      );
      // Charged anyway — the simulation was ignored, which is the point.
      expect(status, "a production caller forced a decline").toBe(200);
    } finally {
      // @ts-expect-error see above
      process.env.NODE_ENV = prev;
    }
  });
});

describe("the gateway seam", () => {
  it("is still the fake driver, which approves everything", async () => {
    // A deployment tripwire, not a unit test. lib/payments/index.ts returns
    // fakeDriver unconditionally and ignores PAYMENT_DRIVER — docs/DEPLOYMENT.md
    // §0 says shipping like this means customers book for free. When a real
    // driver lands, this test must be updated, which is the reminder.
    const { getDriver } = await import("@/lib/payments");
    expect(getDriver().name).toBe("fake");

    process.env.PAYMENT_DRIVER = "moyasar";
    expect(
      getDriver().name,
      "PAYMENT_DRIVER now selects a driver — update this test and DEPLOYMENT §0",
    ).toBe("fake");
  });
});
