// Cancelling into the wallet (docs/WALLET-PLAN.md, step 2c).
//
// Once a booking is confirmed, money never goes back to the card: a cancel
// credits her wallet with everything she paid on it, card and wallet alike.
// Behind `wallet_launched_at`: until it is set, her cancel still refunds the
// card and the salon's cancel moves no money, exactly as before.
//
// Two answers are still owed, and until they come the code refuses rather than
// guessing (WalletHeld, "held"): a salon cancel inside the 3 h window (open
// question 1), and a booking made before bookings kept their email (open
// question 6). Nothing reaches a customer until launch, and launch waits on both.

import "./as-staff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/throttle", () => ({ throttled: () => false, clientIp: () => "127.0.0.1" }));
vi.mock("@/lib/booking-auth", () => ({ refuseBookingAction: async () => null }));

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, payments, settings, walletDecisions, walletTxns } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { walletBalance } from "@/lib/wallet";
import { POST } from "@/app/api/my-bookings/cancel/route";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");

let f: Fixtures;
const EMAIL = "sara@test.local";

async function launch() {
  const at = new Date().toISOString();
  await db
    .insert(settings)
    .values({ key: "wallet_launched_at", value: at })
    .onConflictDoUpdate({ target: settings.key, set: { value: at } });
}

beforeEach(async () => {
  f = await fixtures();
  await db.delete(walletDecisions);
  await reset(f.branchA, f.branchB);
  await db.delete(payments).where(eq(payments.provider, "test-wallet"));
});

afterEach(async () => {
  await db.delete(settings).where(eq(settings.key, "wallet_launched_at"));
});

/**
 * A confirmed party, each guest's bill paid by card, with `walletPart` of each
 * bill paid from her wallet on top. Starts far enough out to be cancellable.
 */
async function paidParty(guests = 1, { walletPart = 0, startsAt = new Date(FUTURE) } = {}) {
  const made = await createBookings({
    branchId: f.branchA,
    startsAt: startsAt.toISOString(),
    customer: { phone: TEST_PHONE, email: EMAIL },
    source: "web",
    status: "confirmed",
    members: Array.from({ length: guests }, () => ({ serviceId: f.svcA.id, addonIds: [] })),
  });
  if (!made.ok) throw new Error(made.error);
  const rows = await db.select().from(bookings).where(inArray(bookings.id, made.bookings.map((b) => b.id)));
  for (const b of rows) {
    await db.update(bookings).set({ walletDiscountHalalas: walletPart }).where(eq(bookings.id, b.id));
    await db.insert(payments).values({
      bookingId: b.id,
      provider: "test-wallet",
      providerRef: `test-wallet-${made.groupId}`,
      amountHalalas: b.totalHalalas,
      status: "paid",
    });
  }
  return rows;
}

const cancel = (code: string) =>
  POST(
    new Request("http://localhost/api/my-bookings/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );

const creditsOn = (ids: string[]) => db.select().from(walletTxns).where(inArray(walletTxns.bookingId, ids));

describe("her cancel, after launch", () => {
  it("credits what she paid, card and wallet, to the booking's email", async () => {
    await launch();
    const [b] = await paidParty(1, { walletPart: 5_000 });

    const res = await cancel(b.code);
    expect(res.status).toBe(200);

    const [credit] = await creditsOn([b.id]);
    expect(credit).toMatchObject({
      reason: "cancel-customer",
      deltaHalalas: b.totalHalalas + 5_000,
      ownerEmail: EMAIL,
      customerId: b.customerId,
    });
    expect(credit.paymentId).not.toBeNull();
    expect(await walletBalance(b.customerId!, EMAIL)).toEqual({
      total: b.totalHalalas + 5_000,
      available: b.totalHalalas + 5_000,
    });
    // Nothing went back to the card.
    const [pay] = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    expect(pay.status).toBe("paid");
  });

  it("credits once however many times she presses cancel", async () => {
    await launch();
    const [b] = await paidParty();

    await cancel(b.code);
    expect((await cancel(b.code)).status).toBe(409);
    expect(await creditsOn([b.id])).toHaveLength(1);
  });

  it("credits each guest of a group her own bill", async () => {
    await launch();
    const rows = await paidParty(2);

    await cancel(rows[0].code);

    const credits = await creditsOn(rows.map((r) => r.id));
    expect(credits).toHaveLength(2);
    for (const r of rows) {
      expect(credits.find((c) => c.bookingId === r.id)?.deltaHalalas).toBe(r.totalHalalas);
    }
  });

  it("credits nothing for a hold she never paid", async () => {
    await launch();
    const made = await createBookings({
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE, email: EMAIL },
      source: "web",
      status: "pending",
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
    });
    if (!made.ok) throw new Error(made.error);

    expect((await cancel(made.bookings[0].code)).status).toBe(200);
    expect(await creditsOn([made.bookings[0].id])).toHaveLength(0);
  });

  it("sends money on a booking with no customer to the owner instead", async () => {
    await launch();
    const [b] = await paidParty();
    await db.update(bookings).set({ customerId: null }).where(eq(bookings.id, b.id));

    await cancel(b.code);

    expect(await creditsOn([b.id])).toHaveLength(0);
    const [decision] = await db.select().from(walletDecisions).where(eq(walletDecisions.bookingId, b.id));
    expect(decision).toMatchObject({ kind: "no-customer", amountHalalas: b.totalHalalas });
  });

  it("refuses, rather than guess, on a booking made before bookings kept their email", async () => {
    await launch();
    const [b] = await paidParty();
    await db.update(bookings).set({ customerEmail: null }).where(eq(bookings.id, b.id));

    const res = await cancel(b.code);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "held" });
    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row.status).toBe("confirmed");
    expect(await creditsOn([b.id])).toHaveLength(0);
  });
  it.todo("credits a booking made before bookings kept their email (open question 6)");
});

describe("before launch", () => {
  it("writes nothing to the wallet", async () => {
    const [b] = await paidParty();

    expect((await cancel(b.code)).status).toBe(200);
    expect(await creditsOn([b.id])).toHaveLength(0);
    expect(await setBookingStatus((await paidParty(1, { startsAt: new Date(FUTURE + 7_200_000) }))[0].id, "cancelled", "Branch closed", "confirmed")).toEqual({ ok: true });
    expect(await db.select().from(walletTxns)).toHaveLength(0);
  });
});

describe("the salon's cancel, after launch", () => {
  it("credits her in full, with the salon's reason", async () => {
    await launch();
    const [b] = await paidParty(1, { walletPart: 2_000 });

    expect(await setBookingStatus(b.id, "cancelled", "Technician off sick", "confirmed")).toEqual({ ok: true });

    const [credit] = await creditsOn([b.id]);
    expect(credit).toMatchObject({
      reason: "cancel-salon",
      deltaHalalas: b.totalHalalas + 2_000,
      note: "Technician off sick",
      ownerEmail: EMAIL,
    });
  });

  it("refuses to set a credited cancel back to confirmed", async () => {
    await launch();
    const [b] = await paidParty();
    await setBookingStatus(b.id, "cancelled", "Branch closed", "confirmed");

    expect(await setBookingStatus(b.id, "confirmed", undefined, "cancelled")).toEqual({
      ok: false,
      error: "has-credit",
    });
    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row.status).toBe("cancelled");
  });

  it("refuses, rather than guess, inside the 3 h window", async () => {
    await launch();
    const [b] = await paidParty(1, { startsAt: new Date(Date.now() + 3_600_000) });

    expect(await setBookingStatus(b.id, "cancelled", "Technician off sick", "confirmed")).toEqual({
      ok: false,
      error: "held",
    });
    expect(await creditsOn([b.id])).toHaveLength(0);
  });
  it.todo("credits (or not) a salon cancel inside the 3 h window (open question 1)");
});
