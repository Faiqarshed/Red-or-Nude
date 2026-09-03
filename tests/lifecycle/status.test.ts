// Moving a booking through its states, from the one write path that does it.
//
// Deliberately not a 49-cell legality matrix. `setBookingStatus` allows
// out-of-order corrections on purpose — its comment calls cancelling, marking
// someone absent and completing out of order "a correction to the record", and
// says that is the owner's call. Asserting a transition graph the code never
// claims would be inventing a spec.
//
// What it *does* claim, and what is asserted here:
//
//   * two statuses are the desk's own (checked_in, completed) and every other
//     one needs bookings.status, which the desk does not hold;
//   * check-in cannot happen more than `checkin_early_min` before the slot —
//     a rule that used to live only at the front desk while the bookings drawer
//     walked straight past it and took a technician off the floor hours early;
//   * entering a status stamps its moment, and re-saving the same status does
//     not reset a clock the commission figures are read from.
//
// The stamps are the fragile part: they are read months later by
// /admin/performance, and nothing goes bang when one is wrong.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, settings } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { actor, resetAppContext } from "../helpers/app";

// lib/auth/guard.ts imports `auth` from "./index" — mock that exact specifier,
// or the real Auth.js instance answers and devFallbackStaff below takes over.
vi.mock("@/lib/auth/index", async () => (await import("../helpers/app")).authMock);
vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);
vi.mock("@/lib/notify", () => ({ notify: async () => {} }));
vi.mock("@/lib/reviews/invite", () => ({ inviteReview: async () => ({ ok: true }) }));

const fx = new Fixtures();
beforeEach(resetAppContext);
afterEach(() => fx.cleanup());

type Role = "ceo" | "admin" | "receptionist" | "technician";

async function as(role: Role, branchId: string | null) {
  const row = await fx.staff(role, branchId);
  actor.current = {
    id: row.id,
    name: row.name,
    email: row.email,
    role,
    branchId: row.branchId,
  };
  return row;
}

/** A booking starting now, so check-in is legal without fighting the clock. */
async function startingNow(branchId: string, serviceId: string, overrides = {}) {
  return fx.booking({
    branchId,
    serviceId,
    status: "confirmed",
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 3_540_000),
    ...overrides,
  });
}

const statusOf = async (id: string) => {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, id));
  return row;
};

describe("who may set which status", () => {
  it("lets the front desk check someone in and close the ticket", async () => {
    // The desk's two moves. It holds bookings.manage and bookings.checkin but
    // deliberately not bookings.status.
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("receptionist", branch.id);
    const bkg = await startingNow(branch.id, svc.id);

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    expect(await setBookingStatus(bkg.id, "checked_in")).toEqual({ ok: true });
    expect(await setBookingStatus(bkg.id, "completed")).toEqual({ ok: true });
  });

  it("refuses the front desk every other status", async () => {
    // Overwriting the record is not something a busy counter should be able to
    // do by mis-clicking — lib/auth/rbac.ts on why bookings.status is split out.
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("receptionist", branch.id);
    const bkg = await startingNow(branch.id, svc.id);

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    for (const status of ["cancelled", "no_show", "in_progress", "pending", "confirmed"] as const) {
      expect(
        await setBookingStatus(bkg.id, status),
        `the front desk set a booking to ${status}`,
      ).toEqual({ ok: false, error: "forbidden" });
      expect((await statusOf(bkg.id)).status).toBe("confirmed");
    }
  });

  it("refuses an admin the same statuses, and the CEO none of them", async () => {
    // Admin holds bookings.manage but not bookings.status — the grant that
    // reads backwards, revoked 2026-09-01 at the salon's request.
    const branch = await fx.branch();
    const svc = await fx.service();
    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");

    await as("admin", branch.id);
    const forAdmin = await startingNow(branch.id, svc.id);
    expect(await setBookingStatus(forAdmin.id, "no_show")).toEqual({
      ok: false,
      error: "forbidden",
    });

    await as("ceo", null);
    const forCeo = await startingNow(branch.id, svc.id);
    expect(await setBookingStatus(forCeo.id, "no_show")).toEqual({ ok: true });
  });

  it("refuses a technician outright", async () => {
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("technician", branch.id);
    const bkg = await startingNow(branch.id, svc.id);

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    // A technician holds only bookings.own, so requireCan("bookings.manage")
    // throws before any of the status logic runs.
    await expect(setBookingStatus(bkg.id, "checked_in")).rejects.toThrow(/Forbidden/);
  });

  it("refuses a signed-out caller on a deployed build", async () => {
    // A Server Action is a POST to a URL. The rendered page is not the gate.
    //
    // NODE_ENV is stubbed because currentStaff() falls back to devFallbackStaff()
    // whenever it is not "production", handing an unauthenticated caller the
    // seeded CEO so `next dev` needs no login. Under vitest it is "test", so
    // without this stub a bare "no session" case passes for the wrong reason.
    // Stubbing it is part of the attack: what a deployed panel does is the
    // thing being asserted.
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("ceo", null);
    const bkg = await startingNow(branch.id, svc.id);

    actor.current = null;
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
      await expect(setBookingStatus(bkg.id, "checked_in")).rejects.toThrow(/Forbidden/);
      expect((await statusOf(bkg.id)).status).toBe("confirmed");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("hands an unauthenticated caller the CEO when NODE_ENV is not production", async () => {
    // @characterization — the dev fallback, pinned. lib/auth/guard.ts:20 calls
    // it "Local dev only (`next dev`; never true for `next start`/deployed
    // builds)", which holds only because `next start` sets NODE_ENV=production.
    // A self-hosted staging box with NODE_ENV unset or set to anything else has
    // an admin panel that needs no login. See known-bugs-lifecycle.md
    // BUG-LIFE-001.
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("ceo", null);
    const bkg = await startingNow(branch.id, svc.id);

    actor.current = null; // no session at all
    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    expect(await setBookingStatus(bkg.id, "checked_in")).toEqual({ ok: true });
  });
});

describe("checking someone in too early", () => {
  it("refuses a check-in well before the slot", async () => {
    // The rule that the bookings drawer used to walk past, taking a technician
    // off the floor hours early.
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("ceo", null);
    const tomorrow = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      startsAt: new Date(Date.now() + 86_400_000),
    });

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    expect(await setBookingStatus(tomorrow.id, "checked_in")).toEqual({
      ok: false,
      error: "too-early",
    });
    expect((await statusOf(tomorrow.id)).checkedInAt).toBeNull();
  });

  it("allows one inside the early window", async () => {
    const { getSettings } = await import("@/lib/settings");
    const { checkin_early_min: earlyMin } = await getSettings(["checkin_early_min"]);

    const branch = await fx.branch();
    const svc = await fx.service();
    await as("ceo", null);
    // Half the allowance before the slot — comfortably inside it.
    const soon = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      startsAt: new Date(Date.now() + (earlyMin / 2) * 60_000),
    });

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    expect(await setBookingStatus(soon.id, "checked_in")).toEqual({ ok: true });
  });
});

describe("the three moments the salon floor is measured by", () => {
  it("stamps checked_in_at on entry and never on re-entry", async () => {
    // Re-saving the same status must not reset a clock the commission figures
    // are read from — the guard is `before.status !== to`.
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("ceo", null);
    const bkg = await startingNow(branch.id, svc.id);

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    await setBookingStatus(bkg.id, "checked_in");
    const first = (await statusOf(bkg.id)).checkedInAt;
    expect(first).not.toBeNull();

    await new Promise((r) => setTimeout(r, 25));
    await setBookingStatus(bkg.id, "checked_in");
    expect(
      (await statusOf(bkg.id)).checkedInAt?.getTime(),
      "re-saving the same status reset the clock",
    ).toBe(first?.getTime());
  });

  it("keeps finished_at distinct from completed", async () => {
    // finished_at is the technician saying she is done; completed is the
    // receptionist closing the ticket. Keeping them apart is what stops a slow
    // front desk landing on the technician's number.
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("ceo", null);
    const bkg = await startingNow(branch.id, svc.id);

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    await setBookingStatus(bkg.id, "checked_in");
    await setBookingStatus(bkg.id, "in_progress");

    const running = await statusOf(bkg.id);
    expect(running.startedAt, "in_progress did not stamp started_at").not.toBeNull();
    expect(running.finishedAt, "a running booking already has a finish stamp").toBeNull();
  });

  it("assigns a technician on check-in, and never overwrites one already named", async () => {
    const branch = await fx.branch();
    const svc = await fx.service();
    const named = await fx.staff("technician", branch.id);
    await as("ceo", null);

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");

    const preassigned = await startingNow(branch.id, svc.id, { technicianId: named.id });
    await setBookingStatus(preassigned.id, "checked_in");
    expect(
      (await statusOf(preassigned.id)).technicianId,
      "a receptionist's override was quietly overwritten",
    ).toBe(named.id);
  });
});

describe("statuses that do not exist", () => {
  it("refuses one the enum never declared", async () => {
    const branch = await fx.branch();
    const svc = await fx.service();
    await as("ceo", null);
    const bkg = await startingNow(branch.id, svc.id);

    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    const result = await setBookingStatus(bkg.id, "refunded" as never);
    expect(result, "an undeclared status reached the database").toEqual({
      ok: false,
      error: "invalid-status",
    });
    expect((await statusOf(bkg.id)).status).toBe("confirmed");
  });

  it("refuses a booking that does not exist", async () => {
    await as("ceo", null);
    const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
    expect(
      await setBookingStatus("00000000-0000-0000-0000-000000000000", "cancelled"),
    ).toEqual({ ok: false, error: "not-found" });
  });
});
