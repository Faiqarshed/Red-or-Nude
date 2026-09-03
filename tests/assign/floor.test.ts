// Who gets the customer: the day off, the leaver, and the branch boundary.
//
// Two scripts already own most of this area and this file deliberately repeats
// neither. `scripts/check-roles.ts` exercises `chooseTechnician`, the whole of
// `planAssignments` — the even spread, overlap, back-to-back, the surplus, the
// tilt from a manual load — and `isToday`, all without a database.
// `scripts/check-assign.ts` runs the live path against real rows: the dawn deal,
// the branch lock, a cancellation freeing its technician, and `releaseToday`.
//
// What neither touches is the *eligibility* half of the rule, which is three
// WHERE clauses and one date comparison:
//
//   • `offOn` — a `date` range compared as a Riyadh calendar string. Nothing
//     asserts either end is inclusive, and nothing asserts it is Riyadh's day
//     rather than UTC's, which is a three-hour window every night where the two
//     disagree about who is in.
//   • `staff.active` — a technician who has left keeps her row.
//   • `staff.branchId` — the other branch's technicians are not this floor's.
//   • `pickTechnician`'s busy set, which is deliberately *not* bounded to today
//     or to this branch: a booking stuck `in_progress` since yesterday holds
//     its technician, and quietly handing her a second customer is how it stays
//     stuck.
//
// What would be easy to break: bounding that busy query to today "for
// symmetry". Every test of the spread stays green, and the technician standing
// over yesterday's unfinished customer is handed today's walk-in.
//
// Register: docs/_testing/requirements-jobs.md and docs/DAY-START-ASSIGNMENT.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, bookings, staffTimeOff } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);
vi.mock("@/lib/notify", () => ({ notify: async () => {} }));

const fx = new Fixtures();

/**
 * Every booking this file made. `assignDay` writes an audit row per assignment
 * and those are not fixtures, so they are swept by entity id. In `afterEach`
 * rather than at the end of each case, so a failing test still cleans up.
 */
const made: string[] = [];

beforeEach(() => {
  resetAppContext();
  made.length = 0;
});

afterEach(async () => {
  if (made.length) await db.delete(auditLog).where(inArray(auditLog.entityId, made));
  await fx.cleanup();
});

/** `fx.booking`, with the id recorded for the sweep above. */
async function mkBooking(opts: Parameters<Fixtures["booking"]>[0]) {
  const row = await fx.booking(opts);
  made.push(row.id);
  return row;
}

/** A slot `hour` hours into today in Riyadh — the day assignDay deals. */
async function today(hour: number, mins = 45) {
  const { riyadhDayRange } = await import("@/lib/time");
  const startsAt = new Date(riyadhDayRange().start.getTime() + hour * 3_600_000);
  return { startsAt, endsAt: new Date(startsAt.getTime() + mins * 60_000) };
}

/** Book a day off. Tracked by id, like every other fixture row. */
async function daysOff(staffId: string, startsOn: string, endsOn: string) {
  const [row] = await db
    .insert(staffTimeOff)
    .values({ staffId, startsOn, endsOn, reason: "test" })
    .returning();
  fx.claim(staffTimeOff, row.id);
  return row;
}

const techOf = async (id: string) =>
  (await db.select({ t: bookings.technicianId }).from(bookings).where(eq(bookings.id, id)))[0].t;

// ============================================================= days off

describe("who is in today — offOn", () => {
  it("counts both ends of the range, and neither day outside it", async () => {
    // Stored as dates and compared as a Riyadh calendar string, so a range the
    // admin typed as "the 10th to the 12th" means exactly those three days.
    const branch = await fx.branch();
    const tech = await fx.staff("technician", branch.id);
    await daysOff(tech.id, "2026-06-10", "2026-06-12");

    const { offOn } = await import("@/lib/assign");
    const on = async (iso: string) => (await offOn(new Date(iso))).has(tech.id);

    expect(await on("2026-06-09T12:00:00.000Z"), "the day before the leave counted as off").toBe(
      false,
    );
    expect(await on("2026-06-10T12:00:00.000Z"), "the first day of the leave was not off").toBe(
      true,
    );
    expect(await on("2026-06-11T12:00:00.000Z")).toBe(true);
    expect(await on("2026-06-12T12:00:00.000Z"), "the last day of the leave was not off").toBe(
      true,
    );
    expect(await on("2026-06-13T12:00:00.000Z"), "the day after the leave counted as off").toBe(
      false,
    );
  });

  it("reads the Riyadh calendar day, not the UTC one", async () => {
    // 21:00 UTC is already tomorrow at the salon. A UTC comparison would have
    // her working on a day she booked off — Saudi Arabia keeps no DST, so this
    // three-hour window is the only place the two calendars part company, and
    // it happens every night.
    const branch = await fx.branch();
    const tech = await fx.staff("technician", branch.id);
    await daysOff(tech.id, "2026-06-10", "2026-06-10");

    const { offOn } = await import("@/lib/assign");
    // 2026-06-09T22:00Z is 2026-06-10T01:00 in Riyadh: she is off.
    expect(
      (await offOn(new Date("2026-06-09T22:00:00.000Z"))).has(tech.id),
      "the small hours of her day off were read as the day before",
    ).toBe(true);
    // 2026-06-10T22:00Z is 2026-06-11T01:00 in Riyadh: she is back.
    expect(
      (await offOn(new Date("2026-06-10T22:00:00.000Z"))).has(tech.id),
      "she was still off three hours into the next day",
    ).toBe(false);
  });

  it("names only the people who are actually off", async () => {
    const branch = await fx.branch();
    const away = await fx.staff("technician", branch.id);
    const working = await fx.staff("technician", branch.id);
    await daysOff(away.id, "2026-06-10", "2026-06-10");

    const { offOn } = await import("@/lib/assign");
    const off = await offOn(new Date("2026-06-10T12:00:00.000Z"));
    expect(off.has(away.id)).toBe(true);
    expect(off.has(working.id), "a technician who is in was reported as off").toBe(false);
  });
});

// ================================================ who may take a walk-in

describe("pickTechnician — the walk-in at the desk", () => {
  it("spreads the work to whoever has had the least of it today", async () => {
    const branch = await fx.branch();
    const busy = await fx.staff("technician", branch.id);
    const quiet = await fx.staff("technician", branch.id);
    const svc = await fx.service();
    // Two on her list already, none on hers.
    for (const hour of [11, 13]) {
      await mkBooking({
        branchId: branch.id,
        serviceId: svc.id,
        technicianId: busy.id,
        status: "confirmed",
        ...(await today(hour)),
      });
    }

    const { pickTechnician } = await import("@/lib/assign");
    expect(await pickTechnician(branch.id), "the work landed on whoever was already loaded").toBe(
      quiet.id,
    );
  });

  it("does not offer a customer to a technician who has left", async () => {
    // A leaver keeps her row — the bookings she worked point at it — so
    // `active` is the only thing standing between her and today's walk-in.
    const branch = await fx.branch();
    await fx.staff("technician", branch.id, { active: false });

    const { pickTechnician } = await import("@/lib/assign");
    expect(await pickTechnician(branch.id), "a deactivated technician was given a customer").toBe(
      null,
    );
  });

  it("does not reach across to another branch's floor", async () => {
    const here = await fx.branch();
    const there = await fx.branch();
    await fx.staff("technician", there.id);

    const { pickTechnician } = await import("@/lib/assign");
    expect(await pickTechnician(here.id), "another branch's technician was booked").toBe(null);
  });

  it("does not offer a customer to someone who is off today", async () => {
    const branch = await fx.branch();
    const away = await fx.staff("technician", branch.id);
    const { riyadhDateKey } = await import("@/lib/time");
    await daysOff(away.id, riyadhDateKey(), riyadhDateKey());

    const { pickTechnician } = await import("@/lib/assign");
    expect(await pickTechnician(branch.id), "a technician on leave was given a walk-in").toBe(null);
  });

  it("counts a technician standing over a customer as busy, whenever that started", async () => {
    // Deliberately unbounded by day: a booking stuck `in_progress` since
    // yesterday is a real thing, and handing its technician a second customer
    // is how it stays stuck.
    const branch = await fx.branch();
    const tech = await fx.staff("technician", branch.id);
    const svc = await fx.service();
    const yesterday = await today(-13);
    await mkBooking({
      branchId: branch.id,
      serviceId: svc.id,
      technicianId: tech.id,
      status: "in_progress",
      ...yesterday,
    });

    const { pickTechnician } = await import("@/lib/assign");
    expect(
      await pickTechnician(branch.id),
      "a technician mid-service since yesterday was handed another customer",
    ).toBe(null);
  });

  it("counts her busy even when the customer she is with is at another branch", async () => {
    // The same rule, the other axis: she is holding somebody, wherever.
    const here = await fx.branch();
    const there = await fx.branch();
    const tech = await fx.staff("technician", here.id);
    const svc = await fx.service();
    await mkBooking({
      branchId: there.id,
      serviceId: svc.id,
      technicianId: tech.id,
      status: "checked_in",
      ...(await today(12)),
    });

    const { pickTechnician } = await import("@/lib/assign");
    expect(await pickTechnician(here.id)).toBe(null);
  });

  it("counts a finished appointment as free again, not as work in hand", async () => {
    // `completed` and `cancelled` are not the two busy statuses; only a
    // customer actually in the chair keeps her out.
    const branch = await fx.branch();
    const tech = await fx.staff("technician", branch.id);
    const svc = await fx.service();
    for (const status of ["completed", "cancelled", "no_show", "confirmed"] as const) {
      await mkBooking({
        branchId: branch.id,
        serviceId: svc.id,
        technicianId: tech.id,
        status,
        ...(await today(12)),
      });
    }

    const { pickTechnician } = await import("@/lib/assign");
    expect(await pickTechnician(branch.id), "a closed ticket kept its technician busy").toBe(
      tech.id,
    );
  });

  it("says nobody rather than refusing to check the customer in", async () => {
    // Returning null is the answer, not an error: refusing to seat a customer
    // because the floor is full would be worse than the problem it solves.
    const branch = await fx.branch();
    const { pickTechnician } = await import("@/lib/assign");
    await expect(pickTechnician(branch.id)).resolves.toBeNull();
  });
});

// ================================================== dealing the whole day

describe("assignDay — the dawn run", () => {
  it("never touches a booking a person has already named", async () => {
    // What makes the job safe to re-run, safe to double-fire and safe to run
    // late: the WHERE carries `technician_id is null`, so a name the desk put
    // there is invisible to it.
    const branch = await fx.branch({ stationCount: 3 });
    const mine = await fx.staff("technician", branch.id);
    const theirs = await fx.staff("technician", branch.id);
    const svc = await fx.service();
    const named = await mkBooking({
      branchId: branch.id,
      serviceId: svc.id,
      technicianId: theirs.id,
      status: "confirmed",
      ...(await today(12)),
    });

    const { assignDay } = await import("@/lib/assign");
    await assignDay(branch.id);

    expect(await techOf(named.id), "the run overwrote a receptionist's choice").toBe(theirs.id);
    expect(mine.id).not.toBe(theirs.id);
  });

  it("leaves an unpaid hold alone — taking someone off the floor for it is inventing work", async () => {
    const branch = await fx.branch();
    await fx.staff("technician", branch.id);
    const svc = await fx.service();
    const hold = await mkBooking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "pending",
      ...(await today(12)),
    });

    const { assignDay } = await import("@/lib/assign");
    const result = await assignDay(branch.id);

    expect(await techOf(hold.id), "a pending hold was given a technician").toBeNull();
    expect(result.assigned).toBe(0);
  });

  it("deals to nobody when the only technician has left or is at another branch", async () => {
    const branch = await fx.branch();
    const other = await fx.branch();
    await fx.staff("technician", branch.id, { active: false });
    await fx.staff("technician", other.id);
    const svc = await fx.service();
    const open = await mkBooking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      ...(await today(12)),
    });

    const { assignDay } = await import("@/lib/assign");
    const result = await assignDay(branch.id);

    expect(await techOf(open.id)).toBeNull();
    expect(result).toEqual({ assigned: 0, unassigned: 1 });
  });

  it("leaves the day to the desk when everyone is off, without throwing", async () => {
    const branch = await fx.branch();
    const away = await fx.staff("technician", branch.id);
    const { riyadhDateKey } = await import("@/lib/time");
    await daysOff(away.id, riyadhDateKey(), riyadhDateKey());
    const svc = await fx.service();
    const open = await mkBooking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      ...(await today(12)),
    });

    const { assignDay } = await import("@/lib/assign");
    const result = await assignDay(branch.id);

    expect(await techOf(open.id), "a technician on leave was dealt a customer").toBeNull();
    expect(result).toEqual({ assigned: 0, unassigned: 1 });
  });

  it("says who dealt each booking, as the job rather than as a person", async () => {
    // The trail has to distinguish the ones a person assigned from the ones the
    // job did, which is what the null actor id is for.
    const branch = await fx.branch();
    const tech = await fx.staff("technician", branch.id);
    const svc = await fx.service();
    const open = await mkBooking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      ...(await today(12)),
    });

    const { assignDay } = await import("@/lib/assign");
    await assignDay(branch.id);

    const trail = await db.select().from(auditLog).where(eq(auditLog.entityId, open.id));
    expect(trail, "an automatic assignment left no trail").toHaveLength(1);
    expect(trail[0].action).toBe("assign-technician");
    expect(trail[0].actorName).toBe("Automatic assignment");
    expect(trail[0].actorId, "the job was logged as a member of staff").toBeNull();
    expect(trail[0].diff!.technicianId).toEqual({ from: null, to: tech.id });

  });

  it("is safe to run twice — the second run has nothing left to do", async () => {
    // Run twice (Phase 10 lens 8). The second pass must not re-deal what the
    // first one settled, nor write a second audit row for it.
    const branch = await fx.branch({ stationCount: 2 });
    await fx.staff("technician", branch.id);
    const svc = await fx.service();
    const open = await mkBooking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      ...(await today(12)),
    });

    const { assignDay } = await import("@/lib/assign");
    const first = await assignDay(branch.id);
    const chosen = await techOf(open.id);
    const second = await assignDay(branch.id);

    expect(first.assigned).toBe(1);
    expect(second, "the second run dealt the same booking again").toEqual({
      assigned: 0,
      unassigned: 0,
    });
    expect(await techOf(open.id)).toBe(chosen);

    const trail = await db.select().from(auditLog).where(eq(auditLog.entityId, open.id));
    expect(trail, "one assignment was audited twice").toHaveLength(1);
  });
});
