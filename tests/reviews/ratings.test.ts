// Asking for a rating, and answering one (brief §2.9).
//
// `scripts/check-reviews.ts` already pins the score range and the email itself —
// both languages, the five star links, the token in every one of them, and
// customer text escaped before it lands in HTML. This file does not repeat any
// of that. It covers the two things that script cannot see, both of which are
// races the schema comment names out loud:
//
//   • `reviews_booking_unique` exists "because a read-based check could be
//     raced by both" — two receptionists pressing End on the same ticket at the
//     same instant. The invitation is decided by the insert, not by a lookup.
//   • the answer is guarded on `submitted_at is null` as well as the token, so
//     two taps on a slow connection cannot overwrite the first answer with the
//     second.
//
// And the token itself. It is deliberately *not* the booking code: the code is
// forwarded and printed on the ticket, and this one opens a write. A caller
// walking the token space is told nothing — an unanswered token they do not
// hold and an answered one they do look identical from outside.
//
// What would be easy to break: dropping `isNull(reviews.submittedAt)` from the
// update. Every single-request test stays green, and the last person to tap the
// link — or anyone who kept the email — silently replaces the rating.
//
// Register: docs/_testing/requirements-jobs.md — REQ-REV-200…209, 240…253,
// 270…275.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, reviews } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { post, read, resetAppContext } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);

/** Every message the invitation tried to send, instead of sending it. */
const outbox: any[] = [];
let mailResult: { ok: boolean; reason?: string } = { ok: true };
vi.mock("@/lib/email", () => ({
  sendMail: async (input: unknown) => {
    outbox.push(input);
    return mailResult;
  },
}));

const fx = new Fixtures();
beforeEach(() => {
  resetAppContext();
  outbox.length = 0;
  mailResult = { ok: true };
});
afterEach(async () => {
  // Unstubbed here rather than at the end of the one case that stubs, so a
  // failing assertion cannot leak an environment variable into the next file.
  vi.unstubAllEnvs();
  await fx.cleanup();
});

/** A finished appointment, ready to be asked about. */
async function finished(over: Partial<typeof bookings.$inferInsert> = {}) {
  const branch = await fx.branch();
  const svc = await fx.service();
  const cust = await fx.customer({ verified: true, name: "Sara Al Otaibi" });
  const booking = await fx.booking({
    branchId: branch.id,
    serviceId: svc.id,
    customerId: cust.id,
    status: "completed",
    startsAt: new Date(Date.now() - 2 * 3_600_000),
    serviceName: { ar: "تركيب كامل", en: "Full set" },
    ...over,
  });
  return { branch, svc, cust, booking };
}

/** Invite, then hand back the row the invitation created. */
async function inviteFor(bookingId: string) {
  const { inviteReview } = await import("@/lib/reviews/invite");
  const outcome = await inviteReview(bookingId);
  const [row] = await db.select().from(reviews).where(eq(reviews.bookingId, bookingId));
  return { outcome, review: row };
}

// ================================================== the invitation, and its race

describe("inviting a rating", () => {
  it("creates one row and sends one email when the ticket is closed", async () => {
    const { booking, cust } = await finished();
    const { outcome, review } = await inviteFor(booking.id);

    expect(outcome).toEqual({ sent: true });
    expect(review.submittedAt, "a review was born already answered").toBeNull();
    expect(review.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe(cust.email);
    expect(outbox[0].tags).toEqual(["review-invite"]);
  });

  it("survives two receptionists pressing End at the same instant", async () => {
    // The race reviews_booking_unique exists for. A read-then-insert would let
    // both calls past the check and mail the customer twice; the constraint
    // settles it, and the loser gets no row back and sends nothing.
    const { booking } = await finished();
    const { inviteReview } = await import("@/lib/reviews/invite");

    const outcomes = await Promise.all([inviteReview(booking.id), inviteReview(booking.id)]);

    const sent = outcomes.filter((o) => o.sent);
    expect(sent, "one End press produced two invitations").toHaveLength(1);
    expect(outcomes.filter((o) => !o.sent && o.reason === "already-invited")).toHaveLength(1);

    const rows = await db.select().from(reviews).where(eq(reviews.bookingId, booking.id));
    expect(rows, "the same appointment was invited twice").toHaveLength(1);
    expect(outbox, "the customer was emailed twice about one visit").toHaveLength(1);
  });

  it("sends nothing the second time the ticket is closed", async () => {
    // The sequential half of the same rule: a retried action, or a receptionist
    // pressing End again ten minutes later.
    const { booking } = await finished();
    const { inviteReview } = await import("@/lib/reviews/invite");

    expect(await inviteReview(booking.id)).toEqual({ sent: true });
    expect(await inviteReview(booking.id)).toEqual({ sent: false, reason: "already-invited" });

    const rows = await db.select().from(reviews).where(eq(reviews.bookingId, booking.id));
    expect(rows).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it("still records the invitation for a walk-in with no address", async () => {
    // The row is the difference between a low response rate and a low invite
    // rate — it says this appointment was never asked, rather than never
    // answered.
    const branch = await fx.branch();
    const svc = await fx.service();
    const walkIn = await fx.customer({ email: null, name: "Counter" });
    const booking = await fx.booking({
      branchId: branch.id,
      serviceId: svc.id,
      customerId: walkIn.id,
      status: "completed",
      source: "walk_in",
      startsAt: new Date(Date.now() - 2 * 3_600_000),
    });

    const { outcome, review } = await inviteFor(booking.id);
    expect(outcome).toEqual({ sent: false, reason: "no-email" });
    expect(review, "the appointment nobody could ask was not recorded").toBeTruthy();
    expect(outbox, "a customer with no address was emailed anyway").toHaveLength(0);
  });

  it("writes to the customer in her own language, both of them", async () => {
    const en = await finished();
    await db.update(customers).set({ lang: "en" }).where(eq(customers.id, en.cust.id));
    await inviteFor(en.booking.id);
    expect(outbox[0].html).toContain('dir="ltr"');

    outbox.length = 0;
    const ar = await finished();
    await db.update(customers).set({ lang: "ar" }).where(eq(customers.id, ar.cust.id));
    await inviteFor(ar.booking.id);
    // A missing ar half is a blank screen for the primary audience, not a
    // fallback. The `?? "ar"` fallback in invite.ts is not exercised here and
    // cannot be: `customers.lang` is notNull with an `ar` default, and the
    // left-join null case leaves earlier as `no-email`.
    expect(outbox[0].html).toContain('dir="rtl"');
    expect(outbox[0].subject.length).toBeGreaterThan(0);
  });

  it("takes the reply address from the environment, never from the booking", async () => {
    // Attack: a reply-to taken from data would let a customer name where the
    // salon's replies go.
    vi.stubEnv("MAIL_REPLY_TO", "salon@example.test");
    const { booking } = await finished({ notes: "reply-to: attacker@example.test" });
    await inviteFor(booking.id);
    expect(outbox[0].replyTo).toBe("salon@example.test");
  });

  it("never throws into the receptionist's End press, whatever the mail does", async () => {
    // Deliberately total: the appointment is closed and the money is long since
    // taken by the time this runs.
    const { booking } = await finished();
    mailResult = { ok: false, reason: "failed" };

    const { outcome, review } = await inviteFor(booking.id);
    expect(outcome).toEqual({ sent: false, reason: "failed" });
    // The row survives an undelivered invitation, so nothing re-invites and
    // double-mails when the outage clears.
    expect(review, "a mail failure took the review row with it").toBeTruthy();
  });

  it("reports a missing mail configuration as its own outcome", async () => {
    const { booking } = await finished();
    mailResult = { ok: false, reason: "not-configured" };
    const { outcome } = await inviteFor(booking.id);
    expect(outcome).toEqual({ sent: false, reason: "not-configured" });
  });

  // @characterization — undocumented, pins behaviour as of 2026-09-03.
  // REQ-REV-206 lists `not-found` among the outcomes, but the insert runs
  // before the booking is read, so an unknown id trips the foreign key first
  // and is caught as `failed`. Harmless — nothing calls this with an id it did
  // not just finish — and worth pinning so a reordering shows up in the diff.
  it("answers an unknown booking with `failed`, not `not-found`", async () => {
    const { inviteReview } = await import("@/lib/reviews/invite");
    const outcome = await inviteReview(crypto.randomUUID());
    expect(outcome).toEqual({ sent: false, reason: "failed" });
    expect(outbox).toHaveLength(0);
  });
});

// ================================================================ POST /api/reviews

describe("POST /api/reviews — answering", () => {
  /** An invited, unanswered review. */
  async function invited(over: Partial<typeof bookings.$inferInsert> = {}) {
    const scene = await finished(over);
    const { review } = await inviteFor(scene.booking.id);
    return { ...scene, review };
  }

  it("records the answer and says so once", async () => {
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    const { status, body } = await read(
      await POST(
        post("http://x/api/reviews", {
          token: review.token,
          serviceRating: 5,
          techRating: 4,
          comment: "  Lovely work  ",
        }),
      ),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    expect(row.serviceRating).toBe(5);
    expect(row.techRating).toBe(4);
    expect(row.comment, "the comment was stored with the customer's whitespace").toBe(
      "Lovely work",
    );
    expect(row.submittedAt, "an answered review was left looking unanswered").not.toBeNull();
  });

  it("lets the customer rate the service and skip the technician", async () => {
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    const { status } = await read(
      await POST(post("http://x/api/reviews", { token: review.token, serviceRating: 3 })),
    );
    expect(status).toBe(200);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    expect(row.serviceRating).toBe(3);
    // Skipping is not the same as rating her zero.
    expect(row.techRating).toBeNull();
  });

  it("stores an empty comment as nothing at all", async () => {
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");
    await POST(
      post("http://x/api/reviews", { token: review.token, serviceRating: 4, comment: "   " }),
    );

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    expect(row.comment, "an empty box was stored as an empty comment").toBeNull();
  });

  it("refuses a score outside one to five rather than clamping it", async () => {
    // A 0 that silently becomes a 1 is a complaint recorded as praise.
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    for (const serviceRating of [0, 6, -1, 2.5, "5", null]) {
      const { status } = await read(
        await POST(post("http://x/api/reviews", { token: review.token, serviceRating })),
      );
      expect(status, `${serviceRating} was accepted as a score`).toBe(400);
    }
    // The same range applies to the technician, and 0 is still not a score.
    for (const techRating of [0, 6, 2.5]) {
      const { status } = await read(
        await POST(
          post("http://x/api/reviews", { token: review.token, serviceRating: 5, techRating }),
        ),
      );
      expect(status).toBe(400);
    }

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    expect(row.submittedAt, "a refused answer was still recorded").toBeNull();
  });

  it("refuses a missing score, a token that is not a uuid, and an essay", async () => {
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    for (const body of [
      { token: review.token },
      { serviceRating: 5 },
      { token: "not-a-uuid", serviceRating: 5 },
      { token: review.token, serviceRating: 5, comment: "x".repeat(1001) },
    ]) {
      const { status, body: out } = await read(await POST(post("http://x/api/reviews", body)));
      expect(status, `${JSON.stringify(body).slice(0, 60)} passed validation`).toBe(400);
      expect(out.error).toBe("invalid");
    }

    const bad = await read(await POST(post("http://x/api/reviews", "{ not json")));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid-json");
  });

  it("accepts a comment of exactly a thousand characters", async () => {
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");
    const { status } = await read(
      await POST(
        post("http://x/api/reviews", {
          token: review.token,
          serviceRating: 5,
          comment: "x".repeat(1000),
        }),
      ),
    );
    expect(status, "the last allowed character was refused").toBe(200);
  });

  it("keeps a comment written in Arabic, with emoji, exactly as it was typed", async () => {
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");
    const comment = "خدمة ممتازة 💅 والفريق لطيف";
    await POST(post("http://x/api/reviews", { token: review.token, serviceRating: 5, comment }));

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    expect(row.comment).toBe(comment);
  });
});

describe("POST /api/reviews — the token is the whole credential", () => {
  async function invited() {
    const scene = await finished();
    const { review } = await inviteFor(scene.booking.id);
    return { ...scene, review };
  }

  it("refuses the booking code and the booking id, which the customer already holds", async () => {
    // Attack: the reference on the ticket and in every forwarded confirmation
    // must not open a write. The token is its own random value for exactly this
    // reason — same reasoning as stations.qr_token.
    const { review, booking } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    const byCode = await read(
      await POST(post("http://x/api/reviews", { token: booking.code, serviceRating: 1 })),
    );
    expect(byCode.status, "the printed booking reference opened a review").toBe(400);

    const byId = await read(
      await POST(post("http://x/api/reviews", { token: booking.id, serviceRating: 1 })),
    );
    expect(byId.status, "the booking's own id opened a review").toBe(409);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    expect(row.serviceRating).toBeNull();
    expect(row.submittedAt).toBeNull();
  });

  it("tells a caller walking the token space nothing at all", async () => {
    // An unanswered review someone does not hold and an answered one they do
    // must be indistinguishable from outside — otherwise the endpoint confirms
    // which guesses are real tokens.
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    const stranger = await read(
      await POST(
        post("http://x/api/reviews", { token: crypto.randomUUID(), serviceRating: 5 }),
      ),
    );
    await POST(post("http://x/api/reviews", { token: review.token, serviceRating: 5 }));
    const answered = await read(
      await POST(post("http://x/api/reviews", { token: review.token, serviceRating: 1 })),
    );

    expect(stranger.status).toBe(409);
    expect(answered.status).toBe(409);
    expect(answered.body, "a walked token could be told from an answered one").toEqual(
      stranger.body,
    );
    expect(stranger.body.error).toBe("already-submitted");
  });

  it("does not let a second answer overwrite the first", async () => {
    // Reload the link, or tap it again a week later: still read-only.
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    await POST(
      post("http://x/api/reviews", {
        token: review.token,
        serviceRating: 5,
        comment: "Delighted",
      }),
    );
    const second = await read(
      await POST(
        post("http://x/api/reviews", {
          token: review.token,
          serviceRating: 1,
          comment: "Actually, terrible",
        }),
      ),
    );
    expect(second.status).toBe(409);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    expect(row.serviceRating, "the first answer was overwritten").toBe(5);
    expect(row.comment).toBe("Delighted");
  });

  it("takes exactly one of two taps fired at the same instant", async () => {
    // The double-click persona: two submissions in flight at once, guarded on
    // `submitted_at is null` rather than by a read.
    const { review } = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    // Both requests are in flight before either is read — an `await` inside the
    // array would run the first to completion and quietly make this the
    // sequential test above.
    const [a, b] = await Promise.all([
      POST(post("http://x/api/reviews", { token: review.token, serviceRating: 5, comment: "A" })),
      POST(post("http://x/api/reviews", { token: review.token, serviceRating: 1, comment: "B" })),
    ]).then((rs) => Promise.all(rs.map(read)));

    const codes = [a.status, b.status].sort();
    expect(codes, "both taps were recorded as answers").toEqual([200, 409]);

    const [row] = await db.select().from(reviews).where(eq(reviews.id, review.id));
    // Whichever won, the stored answer is one whole answer and not a mix of the
    // two: the comment and the score have to come from the same tap.
    expect(
      { comment: row.comment, serviceRating: row.serviceRating },
      "the two taps were interleaved into one answer",
    ).toEqual(row.comment === "A" ? { comment: "A", serviceRating: 5 } : { comment: "B", serviceRating: 1 });
  });

  it("leaves every other appointment's review alone", async () => {
    // Negative space: a submission touches one row, not the table.
    const mine = await invited();
    const theirs = await invited();
    const { POST } = await import("@/app/api/reviews/route");

    await POST(post("http://x/api/reviews", { token: mine.review.token, serviceRating: 2 }));

    const [other] = await db.select().from(reviews).where(eq(reviews.id, theirs.review.id));
    expect(other.serviceRating, "one answer wrote to someone else's review").toBeNull();
    expect(other.submittedAt).toBeNull();
  });

  it("throttles a script walking the token space", async () => {
    const { POST } = await import("@/app/api/reviews/route");
    const ip = "198.51.100.55";
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await POST(
        post(
          "http://x/api/reviews",
          { token: crypto.randomUUID(), serviceRating: 5 },
          { ip },
        ),
      );
      seen.push(res.status);
    }
    expect(seen[0]).not.toBe(429);
    expect(seen.filter((s) => s === 429).length, "the token space is walkable").toBeGreaterThan(0);
  });
});

// ==================================================== what reaches the browser
//
// REQ-REV-270…275 (`/review/[token]`, including the Phase 6.6 RSC payload
// check) are **N/A at this layer**. The page is a `.tsx` Server Component and
// this suite has no JSX transform — vitest.config.mts configures no React
// plugin, deliberately, because nothing else here renders components. Importing
// the page fails to parse before any assertion runs.
//
// The select it feeds the client component is explicit (`columns` named one by
// one, no whole-row pass-through), which is the property REQ-REV-275 asks for,
// but nothing here asserts it. It needs a component harness, which is a change
// to the shared config and so is the coordinator's call, not this file's.
