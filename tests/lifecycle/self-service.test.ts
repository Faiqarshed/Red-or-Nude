// The two self-service routes the customer's own history offers besides cancel:
// moving an appointment, and asking what a refill would cost.
//
// Cancel is covered by ownership.test.ts, which explains the credential all
// three share. What is different here is what each route is allowed to give
// away. Reschedule takes someone else's chair, so it is checked against the
// appointment the customer *has* — an appointment two hours away is the salon's
// to move, not theirs — and against the lead time, because the picker hiding a
// slot is not the same as the server refusing it. Refill is the only endpoint
// that reveals anything beyond a booking's own summary, which is why the
// reference alone has never been enough for it.
//
// What would be easy to break: checking the cancellation window against the
// *destination* instead of the origin. Every "you cannot move it three hours
// before" test would stay green, and a customer would be able to walk an
// appointment that starts in ten minutes out to next week — releasing a chair
// the salon had already staffed, at no notice, which is exactly what the cutoff
// exists to prevent.
//
// Register: docs/_testing/requirements-lifecycle.md §4 (reschedule) and §5
// (refill).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, bookings, otps } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { jar, post, read, resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);
vi.mock("@/lib/notify", () => ({ notify: async () => {} }));

const fx = new Fixtures();
beforeEach(resetAppContext);
afterEach(() => fx.cleanup());

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Sign the cookie jar in as this customer. */
async function signIn(customerId: string) {
  const { ACCOUNT_COOKIE, mintSession } = await import("@/lib/account/session");
  jar.set(ACCOUNT_COOKIE, await mintSession(customerId));
}

/**
 * A branch, a service and one confirmed booking a week out — far enough that
 * the three-hour cancellation window is open, and not today, so the live
 * assignment run stays out of the way.
 */
async function scene(opts: { stationCount?: number; refillDays?: number } = {}) {
  const branch = await fx.branch({ stationCount: opts.stationCount ?? 2 });
  const svc = await fx.service({ durationMin: 60, refillDays: opts.refillDays ?? 0 });
  const cust = await fx.customer({ verified: true });
  return { branch, svc, cust };
}

const later = (ms: number) => new Date(Date.now() + ms);

// ============================================ POST /api/my-bookings/reschedule

describe("POST /api/my-bookings/reschedule — the credential", () => {
  it("refuses a caller with neither session nor code, and moves nothing", async () => {
    const { branch, svc, cust } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
    });

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: later(14 * DAY).toISOString(),
        }),
      ),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("otp-required");

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.startsAt.getTime(), "an unauthenticated caller moved a booking").toBe(
      target.startsAt.getTime(),
    );
  });

  it("refuses an attacker signed in as someone else holding the reference", async () => {
    // IDOR: the reference is forwardable, so a session that is not the owner's
    // must be worth no more than no session at all.
    const { branch, svc, cust: victim } = await scene();
    const attacker = await fx.customer({ verified: true });
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: victim.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
    });
    await signIn(attacker.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: later(14 * DAY).toISOString(),
        }),
      ),
    );
    expect(status).toBe(401);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.startsAt.getTime(), "a stranger moved someone else's appointment").toBe(
      target.startsAt.getTime(),
    );
  });

  it("lets a guest through with a code issued for that exact booking", async () => {
    const { branch, svc } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: null,
      status: "confirmed",
      startsAt: later(7 * DAY),
    });
    const { issueOtp, bookingSubject } = await import("@/lib/otp");
    const code = await issueOtp(bookingSubject(target.id));

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: later(14 * DAY).toISOString(),
          otp: code,
        }),
      ),
    );
    expect(status).toBe(200);
    await db.delete(otps).where(eq(otps.subject, bookingSubject(target.id)));
  });

  it("refuses an unknown reference as `wrong`, not as a 404", async () => {
    // Deliberate: the action is guarded, not the existence of the booking —
    // POST /api/my-bookings answers that openly.
    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: "RON-NOSUCH",
          startsAt: later(14 * DAY).toISOString(),
        }),
      ),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("wrong");
  });
});

describe("POST /api/my-bookings/reschedule — what it will accept", () => {
  it("refuses a body that is not JSON at all", async () => {
    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings/reschedule", "{ not json")),
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid-json");
  });

  it("refuses a start time that is not an ISO datetime", async () => {
    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    for (const startsAt of ["tomorrow", "2030-05-01", "", "2030-13-45T00:00:00.000Z"]) {
      const { status } = await read(
        await POST(post("http://x/api/my-bookings/reschedule", { code: "RON-AAAAA", startsAt })),
      );
      expect(status, `\`${startsAt}\` was accepted as an appointment time`).toBe(400);
    }
  });

  it("refuses a code shorter than a reference and an otp that is not six digits", async () => {
    const { OTP_LENGTH } = await import("@/lib/otp");
    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const startsAt = later(14 * DAY).toISOString();

    for (const body of [
      { code: "RON", startsAt },
      { code: "R".repeat(21), startsAt },
      { code: "RON-AAAAA", startsAt, otp: "12345a".slice(0, OTP_LENGTH) },
      { code: "RON-AAAAA", startsAt, otp: "1".repeat(OTP_LENGTH + 1) },
    ]) {
      const { status } = await read(
        await POST(post("http://x/api/my-bookings/reschedule", body)),
      );
      expect(status, `${JSON.stringify(body)} passed validation`).toBe(400);
    }
  });

  it("throttles a script walking the reference space with move attempts", async () => {
    // Tighter than the read endpoint at 5/min: moving a booking takes someone
    // else's chair, so there is no legitimate reason to try it six times.
    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const ip = "198.51.100.21";
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await POST(
        post(
          "http://x/api/my-bookings/reschedule",
          { code: `RON-Y${i}`, startsAt: later(14 * DAY).toISOString() },
          { ip },
        ),
      );
      seen.push(res.status);
    }
    expect(seen[0], "the first attempt was throttled").not.toBe(429);
    expect(seen.filter((s) => s === 429).length, "move attempts are unthrottled")
      .toBeGreaterThan(0);
  });
});

describe("POST /api/my-bookings/reschedule — the window and the lead time", () => {
  it("judges the window by the appointment they have, not the one they want", async () => {
    // The heart of this route. An appointment an hour away is inside the
    // three-hour cutoff, so it is the salon's to move — even though the
    // destination is a fortnight out and perfectly bookable.
    const { branch, svc, cust } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(HOUR),
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: later(14 * DAY).toISOString(),
        }),
      ),
    );
    expect(status).toBe(409);
    expect(body.error).toBe("window-closed");
    // Being refused is more use with the deadline that was missed attached.
    expect(body.cutoffHours).toBe(3);
    expect(new Date(body.cancelBy).getTime()).toBe(target.startsAt.getTime() - 3 * HOUR);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.startsAt.getTime(), "an appointment inside the cutoff was moved").toBe(
      target.startsAt.getTime(),
    );
  });

  it("refuses to move an already-cancelled booking, with its own reason", async () => {
    const { branch, svc, cust } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "cancelled",
      startsAt: later(7 * DAY),
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: later(14 * DAY).toISOString(),
        }),
      ),
    );
    expect(status).toBe(409);
    expect(body.error, "a cancelled booking was moved back to life").toBe("already-cancelled");
  });

  it("refuses a destination in the past, whatever the picker showed", async () => {
    // booking_lead_time_min defaults to 0 — "book the chair you can see" — so
    // the floor this guards is the past itself, and a hand-crafted request is
    // the only way to reach it.
    const { branch, svc, cust } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: new Date(Date.now() - DAY).toISOString(),
        }),
      ),
    );
    expect(status).toBe(409);
    expect(body.error).toBe("too-soon");
    // The salon's own notice period, whatever it is set to — the refusal is
    // useless to the screen without the number it was measured against.
    expect(typeof body.leadTimeMin, "the refusal did not say how much notice is needed").toBe(
      "number",
    );

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.startsAt.getTime(), "an appointment was moved into last week").toBe(
      target.startsAt.getTime(),
    );
  });
});

describe("POST /api/my-bookings/reschedule — the move itself", () => {
  it("moves the appointment and reports only the new time", async () => {
    // The new chair is deliberately not in the response: the customer is told
    // their time, and the table is on the ticket they already hold.
    const { branch, svc, cust } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
      stationId: branch.stations[0].id,
    });
    await signIn(cust.id);
    const to = later(14 * DAY);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: to.toISOString(),
        }),
      ),
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort(), "the response gave away the chair").toEqual([
      "ok",
      "startsAt",
    ]);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.startsAt.getTime()).toBe(to.getTime());
    // The duration travels with the appointment.
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(
      target.endsAt.getTime() - target.startsAt.getTime(),
    );
  });

  it("moves no money: same service, same total, same ticket number", async () => {
    // Nothing is charged and nothing is refunded, so a move must not disturb
    // the bill or hand the customer a new place in the queue.
    const { branch, svc, cust } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
      ticketNo: "A7",
      servicePriceHalalas: 25_000,
      subtotalHalalas: 25_000,
      vatHalalas: 3_261,
      totalHalalas: 25_000,
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    await POST(
      post("http://x/api/my-bookings/reschedule", {
        code: target.code,
        startsAt: later(14 * DAY).toISOString(),
      }),
    );

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.ticketNo, "the move issued a new ticket number").toBe("A7");
    expect(row.totalHalalas).toBe(25_000);
    expect(row.serviceId).toBe(svc.id);
    expect(row.code).toBe(target.code);
    expect(row.vatHalalas).toBe(3_261);
    expect(row.status, "a move changed where the booking was in its lifecycle").toBe("confirmed");
  });

  it("re-picks the chair rather than insisting on the old one", async () => {
    // She had chair 2 on Tuesday; on Thursday chair 2 is taken and chair 1 is
    // free. Keeping the old chair would refuse a slot that is genuinely open.
    const { branch, svc, cust } = await scene({ stationCount: 2 });
    const to = later(14 * DAY);
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
      stationId: branch.stations[1].id,
    });
    await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      startsAt: to,
      stationId: branch.stations[1].id,
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: to.toISOString(),
        }),
      ),
    );
    expect(status, "a free chair was refused because it was not the old one").toBe(200);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.stationId).toBe(branch.stations[0].id);
  });

  it("refuses a slot with no free chair and leaves the original where it was", async () => {
    const { branch, svc, cust } = await scene({ stationCount: 1 });
    const to = later(14 * DAY);
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
      stationId: branch.stations[0].id,
    });
    await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      status: "confirmed",
      startsAt: to,
      stationId: branch.stations[0].id,
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status, body } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: target.code,
          startsAt: to.toISOString(),
        }),
      ),
    );
    expect(status).toBe(409);
    expect(body.error).toBe("slot-taken");

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.startsAt.getTime(), "a refused move still moved the booking").toBe(
      target.startsAt.getTime(),
    );
    expect(row.stationId).toBe(branch.stations[0].id);
  });

  it("hands the technician back, because she may already have someone at the new time", async () => {
    // Emptied inside the same transaction. Keeping a name that is now
    // double-booked would look like a decision and be a clash.
    const { branch, svc, cust } = await scene();
    const tech = await fx.staff("technician", branch.id);
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
      technicianId: tech.id,
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    await POST(
      post("http://x/api/my-bookings/reschedule", {
        code: target.code,
        startsAt: later(14 * DAY).toISOString(),
      }),
    );

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.technicianId, "a moved booking kept a technician nobody re-checked").toBeNull();
  });

  it("moves a group as a unit, each guest keeping her own duration", async () => {
    // §2.4: every guest starting at the same moment is an invariant, so moving
    // one member and not the other would make a booking that could never have
    // been made in the first place.
    const { branch, svc, cust } = await scene({ stationCount: 2 });
    const groupId = crypto.randomUUID();
    const from = later(7 * DAY);
    const anchor = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: from,
      endsAt: new Date(from.getTime() + 60 * 60_000),
      groupId,
    });
    const companion = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: from,
      endsAt: new Date(from.getTime() + 90 * 60_000),
      groupId,
    });
    await signIn(cust.id);
    const to = later(14 * DAY);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    const { status } = await read(
      await POST(
        post("http://x/api/my-bookings/reschedule", {
          code: anchor.code,
          startsAt: to.toISOString(),
        }),
      ),
    );
    expect(status).toBe(200);

    const [movedAnchor] = await db.select().from(bookings).where(eq(bookings.id, anchor.id));
    const [movedCompanion] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, companion.id));

    expect(movedAnchor.startsAt.getTime()).toBe(to.getTime());
    expect(movedCompanion.startsAt.getTime(), "half a group was left behind").toBe(to.getTime());
    expect(movedAnchor.endsAt.getTime() - movedAnchor.startsAt.getTime()).toBe(60 * 60_000);
    expect(
      movedCompanion.endsAt.getTime() - movedCompanion.startsAt.getTime(),
      "a guest's appointment was silently shortened by the move",
    ).toBe(90 * 60_000);
    expect(movedAnchor.stationId).not.toBe(movedCompanion.stationId);
  });

  it("records who moved it, as the customer rather than a member of staff", async () => {
    const { branch, svc, cust } = await scene();
    const target = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(7 * DAY),
    });
    await signIn(cust.id);
    const to = later(14 * DAY);

    const { POST } = await import("@/app/api/my-bookings/reschedule/route");
    await POST(
      post("http://x/api/my-bookings/reschedule", {
        code: target.code,
        startsAt: to.toISOString(),
      }),
    );

    const trail = await db.select().from(auditLog).where(eq(auditLog.entityId, target.id));
    expect(trail, "a self-service move left no trail").toHaveLength(1);
    expect(trail[0].action).toBe("reschedule");
    expect(trail[0].entity).toBe("bookings");
    expect(trail[0].actorName).toBe("customer");
    expect(trail[0].actorId, "the customer was logged as a member of staff").toBeNull();
    expect(trail[0].diff!.startsAt).toEqual({
      from: target.startsAt.toISOString(),
      to: to.toISOString(),
    });

    // Written by the code under test against a booking this fixture owns.
    await db.delete(auditLog).where(eq(auditLog.entityId, target.id));
  });
});

// =============================================== the refill window — lib/refill

describe("the refill window", () => {
  const base = {
    startsAt: new Date("2026-05-01T12:00:00.000Z"),
    status: "completed",
    refillDays: 30,
    alreadyRefilled: false,
    isRefill: false,
  };
  const at = (iso: string) => new Date(iso);

  it("offers nothing on a service that carries no refill", async () => {
    const { refillDaysLeft, refillWindowEnd } = await import("@/lib/refill");
    const none = { ...base, refillDays: 0 };
    expect(refillDaysLeft(none, at("2026-05-02T12:00:00.000Z"))).toBe(0);
    expect(refillWindowEnd(none), "a service with no refill was given a deadline").toBeNull();
  });

  it("waits until the customer has actually sat in the chair", async () => {
    const { refillDaysLeft } = await import("@/lib/refill");
    const now = at("2026-05-01T09:00:00.000Z"); // three hours before the appointment
    expect(refillDaysLeft({ ...base, status: "confirmed" }, now)).toBe(0);
    expect(refillDaysLeft({ ...base, status: "pending" }, now)).toBe(0);
    // `completed` is the salon pressing End; a past `confirmed` covers staff who
    // never got round to it. She sat in the chair either way.
    const after = at("2026-05-02T12:00:00.000Z");
    expect(refillDaysLeft({ ...base, status: "confirmed" }, after)).toBe(29);
    expect(refillDaysLeft({ ...base, status: "completed" }, after)).toBe(29);
  });

  it("gives no second refill to a booking that was itself one", async () => {
    // Without this a discounted booking every 30 days would mean never paying
    // full price.
    const { refillDaysLeft } = await import("@/lib/refill");
    expect(refillDaysLeft({ ...base, isRefill: true }, at("2026-05-02T12:00:00.000Z"))).toBe(0);
    expect(
      refillDaysLeft({ ...base, alreadyRefilled: true }, at("2026-05-02T12:00:00.000Z")),
    ).toBe(0);
  });

  it("counts the last partial day as a day, and shuts on the second it lapses", async () => {
    const { refillDaysLeft, refillWindowEnd } = await import("@/lib/refill");
    const endsAt = refillWindowEnd(base)!;
    expect(endsAt.toISOString()).toBe("2026-05-31T12:00:00.000Z");

    // An hour of window left still reads "1 day", never 0.
    expect(refillDaysLeft(base, new Date(endsAt.getTime() - HOUR))).toBe(1);
    expect(refillDaysLeft(base, new Date(endsAt.getTime() - 1))).toBe(1);
    // Standing exactly on the deadline is too late.
    expect(refillDaysLeft(base, endsAt), "the deadline itself was still open").toBe(0);
    expect(refillDaysLeft(base, new Date(endsAt.getTime() + 1))).toBe(0);
  });

  it("takes the discount off the service line and rounds to whole halalas", async () => {
    const { refillPriceHalalas } = await import("@/lib/refill");
    expect(refillPriceHalalas(25_000, 50)).toBe(12_500);
    // 33% of 25,001 is 8250.33 — the customer pays whole halalas, never a third.
    expect(Number.isInteger(refillPriceHalalas(25_001, 33))).toBe(true);
    expect(refillPriceHalalas(25_001, 33)).toBe(16_751);
  });

  it("clamps a nonsense discount rather than paying the customer to come in", async () => {
    const { refillPriceHalalas } = await import("@/lib/refill");
    expect(refillPriceHalalas(25_000, 150), "a 150% discount owed the customer money").toBe(0);
    expect(refillPriceHalalas(25_000, -20), "a negative discount charged a surcharge").toBe(
      25_000,
    );
    expect(refillPriceHalalas(25_000, 0)).toBe(25_000);
    expect(refillPriceHalalas(25_000, 100)).toBe(0);
  });
});

describe("which bookings have spent their window — claimedWindows", () => {
  it("counts a live refill and hands the window back when one is cancelled", async () => {
    // The window is claimed by a refill that still exists. A cancelled or
    // no-show refill returns it, exactly as bookings_refill_of_unique has it.
    const { branch, svc, cust } = await scene({ refillDays: 30 });
    const parent = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "completed",
      startsAt: new Date(Date.now() - DAY),
    });
    const child = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(2 * DAY),
      refillOfBookingId: parent.id,
    });

    const { claimedWindows } = await import("@/lib/bookings");
    expect((await claimedWindows([parent.id])).has(parent.id)).toBe(true);

    await db.update(bookings).set({ status: "cancelled" }).where(eq(bookings.id, child.id));
    expect(
      (await claimedWindows([parent.id])).has(parent.id),
      "a cancelled refill kept the window it never used",
    ).toBe(false);

    await db.update(bookings).set({ status: "no_show" }).where(eq(bookings.id, child.id));
    expect((await claimedWindows([parent.id])).has(parent.id)).toBe(false);
  });

  it("asks nothing of the database for an empty list", async () => {
    const { claimedWindows } = await import("@/lib/bookings");
    expect((await claimedWindows([])).size).toBe(0);
  });
});

// =============================================== POST /api/my-bookings/refill

describe("POST /api/my-bookings/refill", () => {
  /** A served appointment a day ago, with a live refill window. */
  async function served(customerId: string | null, refillDays = 30) {
    const branch = await fx.branch();
    const svc = await fx.service({ priceHalalas: 25_000, durationMin: 60, refillDays });
    return {
      svc,
      booking: await fx.booking({
        branchId: branch.id,
        serviceId: svc.id,
        customerId,
        status: "completed",
        startsAt: new Date(Date.now() - DAY),
      }),
    };
  }

  it("refuses the reference alone — this is the one route it was never enough for", async () => {
    // The attack: a forwarded confirmation email carries a reference, and this
    // endpoint reveals more than the booking's own summary does.
    const cust = await fx.customer({ verified: true });
    const { booking } = await served(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code })),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("otp-required");
    expect(body.refill, "the offer leaked to a caller with no credential").toBeUndefined();
  });

  it("refuses a signed-in stranger holding the reference", async () => {
    const victim = await fx.customer({ verified: true });
    const attacker = await fx.customer({ verified: true });
    const { booking } = await served(victim.id);
    await signIn(attacker.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code })),
    );
    expect(status).toBe(401);
    expect(body.refill).toBeUndefined();
  });

  it("answers the owner with no code at all", async () => {
    // The session already proves more than an emailed digit string does.
    const cust = await fx.customer({ verified: true });
    const { booking } = await served(cust.id);
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code })),
    );
    expect(status).toBe(200);
    expect(body.refill.daysLeft).toBe(29);
    expect(body.refill.bookUrl).toBe(`/booking?refill=${booking.code}`);
    // 50% off 250.00 SAR, the salon's default refill discount.
    expect(body.refill.priceSar).toBe(125);
    expect(new Date(body.refill.expiresAt).getTime()).toBe(
      booking.startsAt.getTime() + 30 * DAY,
    );
  });

  it("answers a guest holding a code for that exact booking", async () => {
    const { booking } = await served(null);
    const { issueOtp, bookingSubject } = await import("@/lib/otp");
    const code = await issueOtp(bookingSubject(booking.id));

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code, otp: code })),
    );
    expect(status).toBe(200);
    expect(body.refill.daysLeft).toBe(29);
    await db.delete(otps).where(eq(otps.subject, bookingSubject(booking.id)));
  });

  it("refuses an unknown reference as `wrong`", async () => {
    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: "RON-NOSUCH" })),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("wrong");
  });

  it("finds the booking whatever case the customer typed the reference in", async () => {
    const cust = await fx.customer({ verified: true });
    const { booking } = await served(cust.id);
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { status } = await read(
      await POST(
        post("http://x/api/my-bookings/refill", { code: `  ${booking.code.toLowerCase()}  ` }),
      ),
    );
    expect(status, "a reference typed in lower case was not found").toBe(200);
  });

  it("says zero days and offers no link on a service with no refill", async () => {
    // Zero days *is* the "no offer" signal — there is no separate flag, so the
    // link has to disappear with it or the two can disagree.
    const cust = await fx.customer({ verified: true });
    const { booking } = await served(cust.id, 0);
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code })),
    );
    expect(body.refill.daysLeft).toBe(0);
    expect(body.refill.bookUrl, "a lapsed offer still linked to the booking page").toBeNull();
    expect(body.refill.expiresAt).toBeNull();
  });

  it("says zero days on an appointment that has not happened yet", async () => {
    const cust = await fx.customer({ verified: true });
    const branch = await fx.branch();
    const svc = await fx.service({ refillDays: 30 });
    const booking = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(2 * DAY),
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code })),
    );
    expect(body.refill.daysLeft, "a refill was offered before the appointment happened").toBe(0);
    expect(body.refill.bookUrl).toBeNull();
  });

  it("says zero days once the window has been spent on a refill", async () => {
    const cust = await fx.customer({ verified: true });
    const { svc, booking } = await served(cust.id);
    const [parent] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    await fx.booking({
      branchId: parent.branchId,
      serviceId: svc.id,
      customerId: cust.id,
      status: "confirmed",
      startsAt: later(2 * DAY),
      refillOfBookingId: booking.id,
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code })),
    );
    expect(body.refill.daysLeft, "one window paid for two refills").toBe(0);
    expect(body.refill.bookUrl).toBeNull();
  });

  it("says zero days on a booking that is itself a refill", async () => {
    const cust = await fx.customer({ verified: true });
    const { svc, booking: original } = await served(cust.id);
    const [parent] = await db.select().from(bookings).where(eq(bookings.id, original.id));
    const theRefill = await fx.booking({
      branchId: parent.branchId,
      serviceId: svc.id,
      customerId: cust.id,
      status: "completed",
      startsAt: new Date(Date.now() - HOUR),
      refillOfBookingId: original.id,
    });
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: theRefill.code })),
    );
    expect(body.refill.daysLeft, "refills chained into a permanent discount").toBe(0);
  });

  it("refuses a body that is not JSON, and an otp that is not six digits", async () => {
    const { OTP_LENGTH } = await import("@/lib/otp");
    const { POST } = await import("@/app/api/my-bookings/refill/route");

    const bad = await read(await POST(post("http://x/api/my-bookings/refill", "{ nope")));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid-json");

    for (const otp of ["1".repeat(OTP_LENGTH - 1), "1".repeat(OTP_LENGTH + 1), "abcdef"]) {
      const { status } = await read(
        await POST(post("http://x/api/my-bookings/refill", { code: "RON-AAAAA", otp })),
      );
      expect(status, `\`${otp}\` passed as a code`).toBe(400);
    }
  });

  it("throttles a script harvesting offers, at the read endpoint's budget", async () => {
    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const ip = "198.51.100.34";
    const seen: number[] = [];
    for (let i = 0; i < 13; i++) {
      const res = await POST(
        post("http://x/api/my-bookings/refill", { code: `RON-Z${i}` }, { ip }),
      );
      seen.push(res.status);
    }
    expect(seen[0]).not.toBe(429);
    expect(seen.filter((s) => s === 429).length, "the refill offer is unthrottled")
      .toBeGreaterThan(0);
  });

  it("reveals nothing about the customer, only the offer", async () => {
    // This route reads more of the booking than any other, so what it prints
    // back is a privacy boundary as much as the lookup's shape is.
    const cust = await fx.customer({
      verified: true,
      name: "Noura Al Harbi",
      email: "noura.refill@example.test",
    });
    const { booking } = await served(cust.id);
    await signIn(cust.id);

    const { POST } = await import("@/app/api/my-bookings/refill/route");
    const { body } = await read(
      await POST(post("http://x/api/my-bookings/refill", { code: booking.code })),
    );
    const serialized = JSON.stringify(body);
    for (const secret of [cust.name!, cust.email!, cust.phone, booking.id]) {
      expect(serialized, `the refill offer leaked ${secret}`).not.toContain(secret);
    }
  });
});
