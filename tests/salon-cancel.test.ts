// The salon cancelling a booking (docs/WALLET-PLAN.md, gap 11).
//
// setBookingStatus used to save the status with no check of what it was, then
// return pack credits in a try/catch that only logged. A crash between the two
// left a cancelled booking with its credit gone; a drawer left open, or a
// double click, acted on a status that was no longer there. Now the status
// change is guarded on the status the desk was shown, a cancel needs a reason,
// and the status and everything it moves are one transaction.

import "./as-staff";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, packServices, packTxns, packs } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { buyPack } from "@/lib/packs";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

// Calls through to the real one unless a test says otherwise.
const packsCrash = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/packs", async (actual) => {
  const real = await actual<typeof import("@/lib/packs")>();
  return {
    ...real,
    returnPackCredits: (...args: Parameters<typeof real.returnPackCredits>) => {
      if (packsCrash.on) throw new Error("crash between the two writes");
      return real.returnPackCredits(...args);
    },
  };
});

const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");

let f: Fixtures;
const madePacks: string[] = [];

beforeEach(async () => {
  packsCrash.on = false;
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
  if (madePacks.length) await db.delete(packs).where(inArray(packs.id, madePacks));
});

/** A pending booking paid for with a pack credit, so a cancel has something to return. */
async function packBooking() {
  const [c] = await db.insert(customers).values({ phone: TEST_PHONE }).returning({ id: customers.id });
  const [pack] = await db
    .insert(packs)
    .values({ name: { ar: "باقة", en: "Cancel pack" }, priceHalalas: 50_000, validDays: 90, active: true, sort: 900 })
    .returning({ id: packs.id });
  madePacks.push(pack.id);
  await db.insert(packServices).values({ packId: pack.id, serviceId: f.svcA.id, quantity: 1 });
  const bought = await buyPack(c.id, pack.id);
  if (!bought.ok) throw new Error(bought.reason);

  const made = await createBookings({
    branchId: f.branchA,
    startsAt: new Date(FUTURE).toISOString(),
    customer: { phone: TEST_PHONE },
    customerId: c.id,
    source: "web",
    status: "pending",
    members: [{ serviceId: f.svcA.id, addonIds: [], customerPackId: bought.customerPackId }],
  });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0].id;
}

const statusOf = async (id: string) =>
  (await db.select({ s: bookings.status }).from(bookings).where(eq(bookings.id, id)))[0].s;

const creditsBack = async (id: string) =>
  db.select().from(packTxns).where(and(eq(packTxns.bookingId, id), gt(packTxns.delta, 0)));

describe("the salon cancels", () => {
  it("cancels with a reason, and gives the pack credit back", async () => {
    const id = await packBooking();

    expect(await setBookingStatus(id, "cancelled", "Technician off sick", "pending")).toEqual({ ok: true });

    const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
    expect(row.status).toBe("cancelled");
    expect(row.cancelReason).toBe("Technician off sick");
    expect(await creditsBack(id)).toHaveLength(1);
  });

  it("refuses a cancel without a reason", async () => {
    const id = await packBooking();

    expect(await setBookingStatus(id, "cancelled", "  ", "pending")).toEqual({ ok: false, error: "reason-required" });
    expect(await statusOf(id)).toBe("pending");
    expect(await creditsBack(id)).toHaveLength(0);
  });

  it("refuses to act on a status the desk is no longer looking at", async () => {
    const id = await packBooking();
    await db.update(bookings).set({ status: "checked_in" }).where(eq(bookings.id, id));

    // The drawer was opened while she was still pending.
    expect(await setBookingStatus(id, "cancelled", "Technician off sick", "pending")).toEqual({
      ok: false,
      error: "changed",
    });
    expect(await statusOf(id)).toBe("checked_in");
    expect(await creditsBack(id)).toHaveLength(0);
  });

  it("acts once on a double click", async () => {
    const id = await packBooking();

    const both = await Promise.all([
      setBookingStatus(id, "cancelled", "Branch closed", "pending"),
      setBookingStatus(id, "cancelled", "Branch closed", "pending"),
    ]);

    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, error: "changed" });
    expect(await creditsBack(id)).toHaveLength(1);
  });

  it("leaves the booking as it was when a write after the status fails", async () => {
    const id = await packBooking();
    packsCrash.on = true;

    const res = await setBookingStatus(id, "cancelled", "Technician off sick", "pending");

    expect(res.ok).toBe(false);
    expect(await statusOf(id)).toBe("pending");
    expect(await creditsBack(id)).toHaveLength(0);
  });
});
