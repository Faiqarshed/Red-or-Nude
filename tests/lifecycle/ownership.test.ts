// Who may act on a booking, and the cancellation window.
//
// The split this file protects is the one lib/booking-auth.ts opens with:
// *reading* a booking is open, because the reference arrives in the customer's
// own inbox and the summary carries no name, phone or email; *changing* one is
// not, because cancelling moves money and rescheduling takes someone else's
// slot. Two credentials satisfy the second — a session that owns the row, or an
// OTP sent to the booking's own address — and the rule is written once because
// three routes need it.
//
// What would be easy to break: dropping the ownership equality in
// refuseBookingAction. Every route would still require a session, every test
// that only checks "signed out is refused" would stay green, and any signed-in
// customer could cancel any booking whose five-character reference they had.
// The file says so; this asserts it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, otps } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { jar, post, read, resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);
vi.mock("@/lib/otp-email", () => ({ sendOtpEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/notify", () => ({ notify: async () => {} }));

const fx = new Fixtures();
beforeEach(resetAppContext);
afterEach(() => fx.cleanup());

/** Sign the cookie jar in as this customer. */
async function signIn(customerId: string) {
  const { ACCOUNT_COOKIE, mintSession } = await import("@/lib/account/session");
  jar.set(ACCOUNT_COOKIE, await mintSession(customerId));
}

/** A confirmed booking far enough out that the cancellation window is open. */
async function bookingFor(customerId: string | null, overrides = {}) {
  const branch = await fx.branch();
  const svc = await fx.service();
  return fx.booking({
    branchId: branch.id,
    serviceId: svc.id,
    customerId,
    status: "confirmed",
    startsAt: new Date(Date.now() + 7 * 86_400_000),
    ...overrides,
  });
}

// ------------------------------------------------------------- IDOR ---------

describe("acting on someone else's booking", () => {
  it("refuses a signed-in customer holding another customer's reference", async () => {
    // The attack the file comment describes: without the ownership equality
    // this is weaker than the guest path, not stronger.
    const victim = await fx.customer({ verified: true });
    const attacker = await fx.customer({ verified: true });
    const target = await bookingFor(victim.id);

    await signIn(attacker.id);
    const { refuseBookingAction } = await import("@/lib/booking-auth");
    const refusal = await refuseBookingAction(
      { id: target.id, customerId: target.customerId },
      undefined,
    );
    expect(refusal, "any signed-in customer could act on any booking").not.toBeNull();
    expect(refusal!.error).toBe("otp-required");
  });

  it("lets the owner through with no code at all", async () => {
    const owner = await fx.customer({ verified: true });
    const target = await bookingFor(owner.id);
    await signIn(owner.id);

    const { refuseBookingAction } = await import("@/lib/booking-auth");
    expect(
      await refuseBookingAction({ id: target.id, customerId: target.customerId }, undefined),
    ).toBeNull();
  });

  it("refuses a guest who knows the reference but has no code", async () => {
    // A forwarded confirmation email must not carry the power to cancel.
    const target = await bookingFor(null);
    const { refuseBookingAction } = await import("@/lib/booking-auth");
    const refusal = await refuseBookingAction(
      { id: target.id, customerId: null },
      undefined,
    );
    expect(refusal).toEqual({ error: "otp-required", status: 401 });
  });

  it("lets a guest through with a code issued for that exact booking", async () => {
    const target = await bookingFor(null);
    const { issueOtp, bookingSubject } = await import("@/lib/otp");
    const code = await issueOtp(bookingSubject(target.id));

    const { refuseBookingAction } = await import("@/lib/booking-auth");
    expect(await refuseBookingAction({ id: target.id, customerId: null }, code)).toBeNull();
    await db.delete(otps).where(eq(otps.subject, bookingSubject(target.id)));
  });

  it("refuses a code issued for a different booking", async () => {
    // Cross-booking replay: a code the attacker legitimately holds for their
    // own appointment must not open someone else's.
    const mine = await bookingFor(null);
    const theirs = await bookingFor(null);
    const { issueOtp, bookingSubject } = await import("@/lib/otp");
    const myCode = await issueOtp(bookingSubject(mine.id));

    const { refuseBookingAction } = await import("@/lib/booking-auth");
    const refusal = await refuseBookingAction({ id: theirs.id, customerId: null }, myCode);
    expect(refusal, "a code for one booking opened another").not.toBeNull();
    expect(refusal!.error).toBe("no-code");

    await db.delete(otps).where(eq(otps.subject, bookingSubject(mine.id)));
  });

  it("refuses a signed-in customer using a stale session for a deleted account", async () => {
    const ghost = await fx.customer({ verified: true });
    const target = await bookingFor(ghost.id);
    await signIn(ghost.id);
    // The booking keeps customerId (set null on delete would orphan it), but
    // currentCustomer returns null, so the ownership branch cannot be taken.
    const { customers } = await import("@/lib/db/schema");
    await db.update(customers).set({ blocked: true }).where(eq(customers.id, ghost.id));

    const { refuseBookingAction } = await import("@/lib/booking-auth");
    const refusal = await refuseBookingAction(
      { id: target.id, customerId: target.customerId },
      undefined,
    );
    expect(refusal, "a blocked customer kept the power to cancel").not.toBeNull();
  });
});

// ------------------------------------------------- the cancellation window --

describe("the cancellation window", () => {
  const CUTOFF = 3; // hours, the brief §2.6 default
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

  it("is open outside the cutoff and shut inside it", async () => {
    const { canCancel } = await import("@/lib/cancellation");
    expect(canCancel({ startsAt: inHours(4), status: "confirmed" }, CUTOFF)).toBe(true);
    expect(canCancel({ startsAt: inHours(2), status: "confirmed" }, CUTOFF)).toBe(false);
  });

  it("is shut exactly on the deadline, never both at once", async () => {
    // "Strictly before: standing exactly on the deadline is too late, so a
    // booking is never cancellable and uncancellable in the same millisecond."
    const { canCancel, cancelDeadline } = await import("@/lib/cancellation");
    const b = { startsAt: new Date("2030-05-01T12:00:00.000Z"), status: "confirmed" };
    const deadline = cancelDeadline(b, CUTOFF);
    expect(deadline.toISOString()).toBe("2030-05-01T09:00:00.000Z");

    expect(canCancel(b, CUTOFF, new Date(deadline.getTime() - 1))).toBe(true);
    expect(canCancel(b, CUTOFF, deadline), "the deadline itself was still open").toBe(false);
    expect(canCancel(b, CUTOFF, new Date(deadline.getTime() + 1))).toBe(false);
  });

  it("gives a different reason for each way it can refuse", async () => {
    // The API reports the reason: telling someone who already cancelled that
    // their window has closed sends them hunting a deadline problem they do
    // not have.
    const { cancelRefusal } = await import("@/lib/cancellation");
    const open = { startsAt: inHours(48) };

    expect(cancelRefusal({ ...open, status: "cancelled" }, CUTOFF)).toBe("already-cancelled");
    expect(cancelRefusal({ ...open, status: "no_show" }, CUTOFF)).toBe("already-cancelled");
    expect(cancelRefusal({ ...open, status: "in_progress" }, CUTOFF)).toBe("not-cancellable");
    expect(cancelRefusal({ ...open, status: "completed" }, CUTOFF)).toBe("not-cancellable");
    expect(cancelRefusal({ ...open, status: "checked_in" }, CUTOFF)).toBe("not-cancellable");
    expect(cancelRefusal({ startsAt: inHours(1), status: "confirmed" }, CUTOFF)).toBe(
      "window-closed",
    );
    expect(cancelRefusal({ ...open, status: "confirmed" }, CUTOFF)).toBeNull();
  });

  it("lets a customer cancel an unpaid hold immediately", async () => {
    // pending is deliberately open: a customer who explicitly cancels should
    // not have to wait out booking_hold_min to see it gone from their history.
    const { cancelRefusal } = await import("@/lib/cancellation");
    expect(cancelRefusal({ startsAt: inHours(48), status: "pending" }, CUTOFF)).toBeNull();
  });

  it("refuses an appointment that has already started", async () => {
    const { canCancel } = await import("@/lib/cancellation");
    expect(canCancel({ startsAt: inHours(-1), status: "confirmed" }, CUTOFF)).toBe(false);
  });

  it("treats a zero-hour cutoff as 'up to the moment it starts'", async () => {
    const { canCancel } = await import("@/lib/cancellation");
    expect(canCancel({ startsAt: inHours(0.5), status: "confirmed" }, 0)).toBe(true);
    expect(canCancel({ startsAt: inHours(-0.5), status: "confirmed" }, 0)).toBe(false);
  });
});

// ------------------------------------------------------------ the routes ----

describe("POST /api/my-bookings — the open read", () => {
  it("finds a booking by its reference and returns no personal details", async () => {
    // Reading is open on purpose, which is only safe while the summary carries
    // nothing identifying. This asserts the second half.
    const cust = await fx.customer({ verified: true, name: "Sara Al Otaibi" });
    const target = await bookingFor(cust.id);

    const { POST } = await import("@/app/api/my-bookings/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings", { code: target.code })),
    );
    expect(status).toBe(200);
    expect(body.bookings).toHaveLength(1);

    const serialized = JSON.stringify(body);
    for (const secret of [cust.name!, cust.phone, cust.email!]) {
      expect(serialized, `the lookup leaked ${secret}`).not.toContain(secret);
    }
  });

  it("answers openly that an unknown reference is unknown", async () => {
    // Deliberate: booking-auth.ts says the action routes "need not disguise an
    // unknown reference as a refused one" precisely because this one does not.
    const { POST } = await import("@/app/api/my-bookings/route");
    const { status } = await read(
      await POST(post("http://x/api/my-bookings", { code: "RON-NOSUCH" })),
    );
    expect(status).toBe(404);
  });

  it("throttles a script walking the reference space", async () => {
    // Five characters of a 32-character alphabet is large but walkable, and the
    // prize is now someone's appointment — lib/throttle.ts says exactly this.
    const { POST } = await import("@/app/api/my-bookings/route");
    const ip = "198.51.100.7";
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await POST(post("http://x/api/my-bookings", { code: `RON-X${i}` }, { ip }));
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 429).length, "the reference space is walkable")
      .toBeGreaterThan(0);
  });
});

describe("POST /api/my-bookings/cancel", () => {
  it("refuses without a session or a code, and cancels nothing", async () => {
    const target = await bookingFor(null);
    const { POST } = await import("@/app/api/my-bookings/cancel/route");
    const { status, body } = await read(
      await POST(post("http://x/api/my-bookings/cancel", { code: target.code })),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("otp-required");

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.status, "a booking was cancelled by an unauthenticated caller").toBe("confirmed");
  });

  it("lets the owner cancel, and leaves it cancelled on a replay", async () => {
    // Run twice (Phase 10 lens 8): the second call must not un-cancel it, nor
    // report success as though it had done something.
    const owner = await fx.customer({ verified: true });
    const target = await bookingFor(owner.id);
    await signIn(owner.id);

    const { POST } = await import("@/app/api/my-bookings/cancel/route");
    const first = await read(await POST(post("http://x/api/my-bookings/cancel", { code: target.code })));
    expect(first.status).toBe(200);

    const replay = await read(await POST(post("http://x/api/my-bookings/cancel", { code: target.code })));
    expect(replay.status, "a second cancel was treated as a fresh one").not.toBe(200);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.status).toBe("cancelled");
  });

  it("refuses inside the cutoff", async () => {
    const owner = await fx.customer({ verified: true });
    const target = await bookingFor(owner.id, { startsAt: new Date(Date.now() + 3_600_000) });
    await signIn(owner.id);

    const { POST } = await import("@/app/api/my-bookings/cancel/route");
    const { status } = await read(
      await POST(post("http://x/api/my-bookings/cancel", { code: target.code })),
    );
    expect(status).not.toBe(200);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.status, "a booking inside the cutoff was cancelled anyway").toBe("confirmed");
  });

  it("refuses an attacker signed in as someone else", async () => {
    const victim = await fx.customer({ verified: true });
    const attacker = await fx.customer({ verified: true });
    const target = await bookingFor(victim.id);
    await signIn(attacker.id);

    const { POST } = await import("@/app/api/my-bookings/cancel/route");
    const { status } = await read(
      await POST(post("http://x/api/my-bookings/cancel", { code: target.code })),
    );
    expect(status).toBe(401);

    const [row] = await db.select().from(bookings).where(eq(bookings.id, target.id));
    expect(row.status).toBe("confirmed");
  });
});
