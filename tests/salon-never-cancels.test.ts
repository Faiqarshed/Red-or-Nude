// The salon never cancels a booking (the client, 2026-09-30; CLAUDE.md).
//
// Only she cancels, from her own booking. The desk's cancel is switched off by
// SALON_CAN_CANCEL in lib/cancellation.ts rather than deleted, so this file is
// the one that runs with the switch as it ships. salon-cancel.test.ts and
// cancel-credit.test.ts turn it back on to keep the switched-off code tested.

import "./as-staff";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { drawerStatuses } from "@/lib/auth/rbac";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");

let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
});

async function booking() {
  const made = await createBookings({
    branchId: f.branchA,
    startsAt: new Date(FUTURE).toISOString(),
    customer: { phone: TEST_PHONE, email: "never-cancelled@test.local" },
    source: "web",
    status: "pending",
    members: [{ serviceId: f.svcA.id, addonIds: [] }],
  });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0].id;
}

const row = async (id: string) =>
  (await db.select({ status: bookings.status, why: bookings.cancelReason }).from(bookings).where(eq(bookings.id, id)))[0];

describe("the salon cancelling a booking", () => {
  it("is refused, even for the owner, and the booking stands", async () => {
    const id = await booking();

    expect(await setBookingStatus(id, "cancelled", "Technician off sick", "pending")).toEqual({
      ok: false,
      error: "salon-cannot-cancel",
    });
    expect(await row(id)).toEqual({ status: "pending", why: null });
  });

  it("can't rewrite the reason on a booking she cancelled herself", async () => {
    const id = await booking();
    await db.update(bookings).set({ status: "cancelled", cancelReason: "Changed my mind" }).where(eq(bookings.id, id));

    expect(await setBookingStatus(id, "cancelled", "Desk's own reason", "cancelled")).toEqual({
      ok: false,
      error: "salon-cannot-cancel",
    });
    expect(await row(id)).toEqual({ status: "cancelled", why: "Changed my mind" });
  });

  it("is not offered in the booking drawer, to any role", () => {
    expect(drawerStatuses("receptionist")).toEqual(["checked_in"]);
    expect(drawerStatuses("ceo")).not.toContain("cancelled");
    expect(drawerStatuses("ceo")).toContain("no_show");
  });
});
