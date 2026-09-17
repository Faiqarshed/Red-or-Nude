// The eight gaps the audit found, each with the smallest check that fails if
// the fix is undone.
//
// Four of these are about a rule that existed on one path and not its twin — a
// code's attempt budget, a branch's authority, a refill's owner, a chair's
// availability — so every test here asserts the *second* path, which is the one
// nobody had asked before.

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookings, customers, otps, services, stations } from "@/lib/db/schema";
import { createBooking, createBookings } from "@/lib/bookings";
import { getDayAvailability, utcToLocalDate } from "@/lib/availability";
import { OTP_MAX_ATTEMPTS, issueOtp, verifyOtp } from "@/lib/otp";
import { inBranchScope } from "@/lib/admin/branch-scope";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

describe("one-time codes", () => {
  const subject = `booking:${"0".repeat(8)}-0000-0000-0000-000000000090`;

  /** A wrong guess that is definitely wrong, whatever was issued. */
  const wrong = (issued: string) => (issued === "000000" ? "111111" : "000000");

  it("spends the five-attempt budget even when every guess arrives at once", async () => {
    const issued = await issueOtp(subject);
    const guesses = 40;

    // The bug this replaces: each request read `attempts` before any of them
    // wrote, so forty guesses cost one or two of the five and the budget never
    // ran out. Sequentially it always looked right.
    const results = await Promise.all(
      Array.from({ length: guesses }, () => verifyOtp(subject, wrong(issued))),
    );

    // Only `wrong` means the guess was weighed. Everything else was turned away
    // without one: `too-many-attempts` once the budget is gone, `no-code` once
    // the fifth wrong guess has burned the row out from under the rest.
    const weighed = results.filter((r) => !r.ok && r.reason === "wrong").length;

    expect(results.every((r) => !r.ok)).toBe(true);
    expect(weighed).toBeLessThanOrEqual(OTP_MAX_ATTEMPTS);
    expect(weighed).toBeLessThan(guesses);

    // And the real code is dead afterwards — a burned budget must not leave a
    // working key behind. The reason is `no-code`, not `too-many-attempts`: the
    // row was consumed, and consumed, expired and never-issued are one answer by
    // design (see VerifyOtpResult). What matters is that it is a refusal.
    expect((await verifyOtp(subject, issued)).ok).toBe(false);
  });

  it("lets exactly one of two simultaneous correct guesses through", async () => {
    const issued = await issueOtp(subject);

    const [a, b] = await Promise.all([
      verifyOtp(subject, issued),
      verifyOtp(subject, issued),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);

    const live = await db
      .select()
      .from(otps)
      .where(and(eq(otps.subject, subject), isNull(otps.consumedAt)));
    expect(live).toHaveLength(0);
  });
});

describe("branch authority", () => {
  const at = (branchId: string | null) => ({ role: "receptionist" as const, branchId });

  it("pins a receptionist to her own front desk and nobody else", () => {
    expect(inBranchScope(at("branch-a"), "branch-a")).toBe(true);
    expect(inBranchScope(at("branch-a"), "branch-b")).toBe(false);
    // A booking with no branch is not hers to touch either.
    expect(inBranchScope(at("branch-a"), null)).toBe(false);
  });

  it("lets anyone unpinned act anywhere", () => {
    // The CEO spans branches by definition; a regional admin has no branch of
    // their own. Both are `null` out of scopedBranchId, which means no filter.
    expect(inBranchScope({ role: "ceo", branchId: null }, "branch-b")).toBe(true);
    expect(inBranchScope({ role: "ceo", branchId: "branch-a" }, "branch-b")).toBe(true);
    expect(inBranchScope({ role: "admin", branchId: null }, "branch-b")).toBe(true);
  });
});

describe("refills belong to somebody", () => {
  /** A finished booking with an open refill window, under `email`. */
  async function parentFor(email: string) {
    // The window is what makes the offer real, and the seed may not give one.
    await db.update(services).set({ refillDays: 30 }).where(eq(services.id, f.svcA.id));

    const made = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      customer: { phone: TEST_PHONE, email },
      source: "web",
    });
    if (!made.ok) throw new Error(`fixture booking failed: ${made.error}`);

    await db
      .update(bookings)
      .set({ status: "completed" })
      .where(eq(bookings.id, made.id));

    return made.code;
  }

  /** Tomorrow — inside the parent's 30-day window, which the engine also checks. */
  const inWindow = () => new Date(Date.now() + 86_400_000).toISOString();

  it("refuses the discount to an address the offer never went to", async () => {
    const code = await parentFor("her@example.com");

    const result = await createBookings({
      branchId: f.branchA,
      startsAt: inWindow(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      customer: { phone: "0500000091", email: "someone-else@example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });

    expect(result).toMatchObject({ ok: false, error: "refill-not-yours" });
  });

  it("still lets the customer it was emailed to claim it", async () => {
    const code = await parentFor("her@example.com");

    const result = await createBookings({
      branchId: f.branchA,
      startsAt: inWindow(),
      members: [{ serviceId: f.svcA.id, addonIds: [] }],
      // Capitalised differently on the way back in, as a customer would.
      customer: { phone: TEST_PHONE, email: "Her@Example.com" },
      source: "web",
      status: "pending",
      refillOfCode: code,
    });

    expect(result.ok).toBe(true);
  });
});

describe("the catalogue decides what can be sold", () => {
  it("refuses a booking naming an add-on the salon has retired", async () => {
    const [extra] = await db.select().from(addons).where(eq(addons.active, true)).limit(1);
    if (!extra) return; // nothing seeded to retire

    await db.update(addons).set({ active: false }).where(eq(addons.id, extra.id));
    try {
      const result = await createBooking({
        branchId: f.branchA,
        serviceId: f.svcA.id,
        addonIds: [extra.id],
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE },
        source: "web",
      });
      expect(result).toEqual({ ok: false, error: "invalid-service" });
    } finally {
      await db.update(addons).set({ active: true }).where(eq(addons.id, extra.id));
    }
  });

  it("refuses an add-on id that is not an add-on at all", async () => {
    const result = await createBooking({
      branchId: f.branchA,
      serviceId: f.svcA.id,
      addonIds: ["00000000-0000-0000-0000-0000000000ff"],
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "web",
    });
    // Silently pricing the appointment without it was the old behaviour: the
    // customer paid for something other than what she asked for.
    expect(result).toEqual({ ok: false, error: "invalid-service" });
  });
});

describe("availability and the reservation lock agree", () => {
  it("counts a booking that started yesterday and is still running", async () => {
    const day = utcToLocalDate(new Date(FUTURE));
    const [chair] = await db
      .select()
      .from(stations)
      .where(and(eq(stations.branchId, f.branchA), eq(stations.active, true)))
      .limit(1);

    const before = await getDayAvailability(f.branchA, day, 60, new Date(FUTURE - 86_400_000));
    const opening = before.find((s) => s.freeStationIds.length > 0);
    if (!opening) return; // branch shut that day; nothing to assert

    // Written straight in: this is a row the day query has to notice, and the
    // shape of it — not how it came to exist — is what is under test.
    const [guest] = await db
      .insert(customers)
      .values({ phone: "0500000092", name: "overnight" })
      .returning();

    await db.insert(bookings).values({
      code: `RON-OV${Math.floor(Math.random() * 900 + 100)}`,
      branchId: f.branchA,
      customerId: guest.id,
      stationId: chair.id,
      serviceId: f.svcA.id,
      // Begins the day before the window and runs past the slot being asked for.
      startsAt: new Date(Date.parse(opening.startsAt) - 12 * 3_600_000),
      endsAt: new Date(Date.parse(opening.startsAt) + 3_600_000),
      status: "confirmed",
      source: "walk_in",
      serviceName: { ar: "ليلي", en: "overnight" },
    });

    const after = await getDayAvailability(f.branchA, day, 60, new Date(FUTURE - 86_400_000));
    const sameSlot = after.find((s) => s.startsAt === opening.startsAt);

    // The chair is busy, so the calendar must say so — before the fix it showed
    // free and the booking was then refused as `slot-taken`.
    expect(sameSlot?.freeStationIds).not.toContain(chair.id);
    expect(sameSlot?.freeStationIds.length).toBe(opening.freeStationIds.length - 1);
  });
});
