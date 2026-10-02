// Cancelling into the wallet (docs/WALLET-PLAN.md, step 2c).
//
// Once a booking is confirmed, money never goes back to the card: a cancel
// credits her wallet with everything she paid on it, card and wallet alike,
// VAT included, as she paid it. A booking that kept no email has nobody's
// wallet to go to, so the owner is sent it; her cancel goes through either way.

import "./as-staff";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/throttle", () => ({ throttled: () => false, clientIp: () => "127.0.0.1" }));
vi.mock("@/lib/booking-auth", () => ({ refuseBookingAction: async () => null }));
// The desk's cancel is switched off (SALON_CAN_CANCEL, lib/cancellation.ts);
// switched back on here so the code kept for that day stays tested.
vi.mock("@/lib/cancellation", async (actual) => ({
  ...(await actual<typeof import("@/lib/cancellation")>()),
  SALON_CAN_CANCEL: true,
}));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("@/lib/email", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    mail.sent.push(m);
    return { ok: true };
  },
}));

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, payments, walletDecisions, walletTxns } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { formatSAR } from "@/lib/money";
import { spendWallet, walletBalance } from "@/lib/wallet";
import { refundedOutside } from "@/lib/payments/refund";
import { fakeDriver } from "@/lib/payments/fake";
import { POST } from "@/app/api/my-bookings/cancel/route";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");

let f: Fixtures;
const EMAIL = "sara@test.local";

beforeEach(async () => {
  mail.sent = [];
  f = await fixtures();
  await db.delete(walletDecisions);
  await reset(f.branchA, f.branchB);
  await db.delete(payments).where(eq(payments.provider, "test-wallet"));
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("her cancel", () => {
  it("credits what she paid, card and wallet, to the booking's email", async () => {
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
    expect(await walletBalance(EMAIL)).toEqual({
      total: b.totalHalalas + 5_000,
      available: b.totalHalalas + 5_000,
    });
    // Nothing went back to the card.
    const [pay] = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    expect(pay.status).toBe("paid");
  });

  it("credits once however many times she presses cancel", async () => {
    const [b] = await paidParty();

    await cancel(b.code);
    expect((await cancel(b.code)).status).toBe(409);
    expect(await creditsOn([b.id])).toHaveLength(1);
  });

  it("credits each guest of a group her own bill", async () => {
    const rows = await paidParty(2);

    await cancel(rows[0].code);

    const credits = await creditsOn(rows.map((r) => r.id));
    expect(credits).toHaveLength(2);
    for (const r of rows) {
      expect(credits.find((c) => c.bookingId === r.id)?.deltaHalalas).toBe(r.totalHalalas);
    }
  });

  it("credits nothing for a hold she never paid", async () => {
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
    const [b] = await paidParty();
    await db.update(bookings).set({ customerId: null }).where(eq(bookings.id, b.id));

    await cancel(b.code);

    expect(await creditsOn([b.id])).toHaveLength(0);
    const [decision] = await db.select().from(walletDecisions).where(eq(walletDecisions.bookingId, b.id));
    expect(decision).toMatchObject({ kind: "no-customer", amountHalalas: b.totalHalalas });
  });

  it("cancels a booking that kept no email, and sends its money to the owner", async () => {
    const [b] = await paidParty();
    await db.update(bookings).set({ customerEmail: null }).where(eq(bookings.id, b.id));

    expect((await cancel(b.code)).status).toBe(200);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(row.status).toBe("cancelled");
    expect(await creditsOn([b.id])).toHaveLength(0);
    const [decision] = await db.select().from(walletDecisions).where(eq(walletDecisions.bookingId, b.id));
    expect(decision).toMatchObject({ kind: "no-email", amountHalalas: b.totalHalalas });
  });
});

describe("telling her", () => {
  it("emails her the credit, to the booking's email", async () => {
    const [b] = await paidParty();

    await cancel(b.code);

    const credit = mail.sent.filter((m) => m.text.includes(formatSAR(b.totalHalalas, { decimals: true })));
    expect(credit).toHaveLength(1);
    expect(credit[0].to).toBe(EMAIL);
  });

  it("emails her when the salon cancels, with its reason", async () => {
    const [b] = await paidParty();

    await setBookingStatus(b.id, "cancelled", "Technician off sick", "confirmed");

    expect(mail.sent.filter((m) => m.text.includes("Technician off sick"))).toHaveLength(1);
  });

});

describe("the salon's cancel, when switched back on", () => {
  it("credits her in full, with the salon's reason", async () => {
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
    const [b] = await paidParty(1, { startsAt: new Date(Date.now() + 3_600_000) });

    expect(await setBookingStatus(b.id, "cancelled", "Technician off sick", "confirmed")).toEqual({
      ok: false,
      error: "held",
    });
    expect(await creditsOn([b.id])).toHaveLength(0);
  });
});

describe("when the payment behind a credit goes back to her card", () => {
  // StreamPay reports a running total, not the amount of this refund.
  const refunded = (halalas: number) => vi.spyOn(fakeDriver, "refundedHalalas").mockResolvedValue(halalas);
  const reversals = () => db.select().from(walletTxns).where(eq(walletTxns.reason, "reversal"));
  const refOf = (groupId: string | null) => `test-wallet-${groupId}`;

  it("takes back what went to her card, outside the app or by chargeback", async () => {
    const [b] = await paidParty();
    await cancel(b.code);

    refunded(b.totalHalalas);
    await refundedOutside(refOf(b.groupId));

    const [r] = await reversals();
    expect(r).toMatchObject({ deltaHalalas: -b.totalHalalas, ownerEmail: EMAIL });
    expect(await walletBalance(EMAIL)).toEqual({ total: 0, available: 0 });
  });

  it("takes back each part once, however often StreamPay reports it", async () => {
    const [b] = await paidParty();
    await cancel(b.code);

    refunded(Math.min(100_00, b.totalHalalas));
    await refundedOutside(refOf(b.groupId));
    refunded(Math.min(250_00, b.totalHalalas - 1));
    await refundedOutside(refOf(b.groupId));
    await refundedOutside(refOf(b.groupId));

    const back = (await reversals()).map((r) => -r.deltaHalalas);
    expect(back.reduce((a, n) => a + n, 0)).toBe(Math.min(250_00, b.totalHalalas - 1));
    expect(back).toHaveLength(2);
  });

  it("takes back a group's refund once, not once per guest", async () => {
    const rows = await paidParty(2);
    await cancel(rows[0].code);

    refunded(100_00);
    await refundedOutside(refOf(rows[0].groupId));

    const back = await reversals();
    expect(back).toHaveLength(1);
    expect(back[0].deltaHalalas).toBe(-100_00);
  });

  it("never takes back what her wallet paid, only what went to her card", async () => {
    const [b] = await paidParty(1, { walletPart: 5_000 });
    await cancel(b.code);

    refunded(b.totalHalalas);
    await refundedOutside(refOf(b.groupId));

    expect(await walletBalance(EMAIL)).toEqual({ total: 5_000, available: 5_000 });
  });

  it("shows her nothing below zero when she already spent it, and tells the owner", async () => {
    const [b, later] = [...(await paidParty()), ...(await paidParty(1, { startsAt: new Date(FUTURE + 7_200_000) }))];
    await cancel(b.code);
    await db.transaction((tx) => spendWallet(tx, later.customerId!, EMAIL, b.totalHalalas, { bookingId: later.id }));

    refunded(b.totalHalalas);
    await refundedOutside(refOf(b.groupId));

    expect(await walletBalance(EMAIL)).toEqual({ total: -b.totalHalalas, available: 0 });
    const [decision] = await db.select().from(walletDecisions).where(eq(walletDecisions.kind, "negative-balance"));
    expect(decision.amountHalalas).toBe(b.totalHalalas);
  });

  it("touches no wallet when the refunded payment funded no credit", async () => {
    const [b] = await paidParty();

    refunded(b.totalHalalas);
    await refundedOutside(refOf(b.groupId));

    expect(await reversals()).toHaveLength(0);
  });
});
