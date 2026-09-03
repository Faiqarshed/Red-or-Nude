// Public booking creation — the hold, not the sale.
//
// This reserves the chair(s) and writes the rows as `pending`. Nothing is
// confirmed and no ticket number exists until POST /api/payments/confirm
// succeeds. An abandoned hold is swept back out automatically.
//
// The body is members-shaped so one guest and two go through the same route:
// a group is simply two members with one start time.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { stations } from "@/lib/db/schema";
import { createBookings } from "@/lib/bookings";
import { clientIp, throttled } from "@/lib/throttle";
import { currentCustomer } from "@/lib/account/guard";

export const dynamic = "force-dynamic";

const member = z.object({
  /** Whose chair this is, when it is not the person paying. See BookingMember. */
  guestName: z.string().trim().max(120).nullable().optional(),
  serviceId: z.string().uuid(),
  addonIds: z.array(z.string().uuid()).max(20).default([]),
  removalTypeId: z.string().uuid().nullable().optional(),
  designId: z.string().uuid().nullable().optional(),
});

const body = z.object({
  branchId: z.string().uuid(),
  // Every guest on one bill starts at the same moment — that is what makes it a
  // group booking rather than two bookings that happen to be on one card.
  startsAt: z.string().datetime(),
  members: z.array(member).min(1).max(2),
  customer: z.object({
    name: z.string().trim().max(120).optional(),
    // Saudi mobile numbers, with or without country code.
    phone: z.string().trim().regex(/^(\+?966|0)?5\d{8}$/, "invalid-phone"),
    // Required on the web, unlike a walk-in, for two independent reasons: it
    // carries the booking reference that is the only key to /my-bookings, and
    // it is where the invoice is sent the moment the charge clears. Walk-ins go
    // through createBookings directly and may still have no address.
    email: z.string().trim().email("invalid-email").max(200),
    lang: z.enum(["ar", "en"]).optional(),
  }),
  /** Set by the refill button in the customer's booking history. */
  refillOfCode: z.string().trim().max(20).nullable().optional(),
  /** An occasion discount code typed at checkout (brief §2.10). */
  promoCode: z.string().trim().max(40).nullable().optional(),
  /**
   * A loyalty reward rung the customer ticked (brief §2.8), in points.
   *
   * Note what is *not* here: whose points. That comes from the session cookie
   * below and never from this body — a customer id in a request is a customer
   * id anyone can edit, and there is a wallet on the other side of it. Someone
   * signed out who posts this is simply ignored.
   */
  redeemPoints: z.number().int().positive().nullable().optional(),
  /**
   * Set only by the station QR flow (brief §2.7), pinning the booking to the
   * chair the customer is already sitting in.
   *
   * A token, never a raw station id: the id is guessable-adjacent and appears in
   * other responses, so accepting one here would let anyone pin any chair — and
   * pinning is how you deny a chair to the customers who would otherwise be
   * offered it. The token is resolved server-side below and only ever from an
   * active station.
   */
  stationToken: z.string().uuid().nullable().optional(),
  notes: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  // Locks every chair at the branch while it reserves one, so keep this low.
  if (throttled(`booking:${clientIp(request)}`, { max: 10 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const { stationToken, ...data } = parsed.data;

  /**
   * No appointment in the past.
   *
   * `startsAt` arrives from the body and is only checked for being a valid
   * datetime. Everything downstream asks one question — is a chair free across
   * this window — and a chair is very free at four o'clock yesterday morning,
   * so a crafted POST wrote real rows onto real technicians' days for times the
   * slot picker would never have offered.
   *
   * Guarded here rather than in `createBookings`, which must keep accepting a
   * past start because its direct callers rely on it: `scripts/check-booking.ts`
   * pins "no-show: freed chair is immediately rebookable", and the chair a
   * no-show frees is on a slot that has already begun. The admin walk-in path
   * reaches that library directly through a Server Action and never through
   * this route, so guarding the route leaves it untouched.
   *
   * (Not via `leadTimeMin`. `computeDay` blocks a past slot unconditionally and
   * `leadTimeMin: 0` only relaxes `too-soon` — lib/availability.ts keeps the two
   * blockers apart on purpose. The staff exemption is a different mechanism
   * from this one; the reason the guard sits here is the direct library caller,
   * not the availability grid.)
   *
   * TWO GRACES, because two flows freeze `startsAt` at very different distances
   * from the moment it is submitted.
   *
   *   • The calendar picks a slot minutes-to-weeks ahead, so the only honest
   *     lateness is the submit race — chosen at 14:00, confirmed at 14:00:03.
   *     Two minutes covers that and cannot reach a slot that meaningfully passed.
   *
   *   • The station QR add-on (brief §2.7) freezes `startsAt` when the sticker
   *     is scanned: the current appointment's projected finish, or `now` when
   *     the chair is empty (app/(site)/station/[token]/page.tsx). Nothing
   *     refreshes it while the customer picks a service and fills in the payment
   *     form, so by submit time it is routinely minutes old and legitimately so.
   *     Two minutes would refuse ordinary customers standing in the salon.
   *
   * Keyed on the token being present, not valid — an unknown or retired one is
   * refused a few lines below, so a made-up token buys the wider window and then
   * a 404.
   *
   * Only the start is checked. Opening hours, closures and an appointment that
   * would run past closing are the same class of hole and are still open —
   * see docs/_testing/known-bugs-booking.md BUG-BOOK-001.
   */
  const SUBMIT_GRACE_MS = 2 * 60_000;
  const STATION_GRACE_MS = 60 * 60_000;
  const grace = stationToken ? STATION_GRACE_MS : SUBMIT_GRACE_MS;
  if (new Date(data.startsAt).getTime() < Date.now() - grace) {
    return NextResponse.json({ error: "slot-in-past" }, { status: 400 });
  }

  let stationId: string | null = null;
  if (stationToken) {
    const [station] = await db
      .select({ id: stations.id })
      .from(stations)
      .where(
        and(
          eq(stations.qrToken, stationToken),
          eq(stations.branchId, data.branchId),
          // A retired chair's sticker stops working the moment it is retired,
          // rather than quietly booking a table nobody is standing at.
          eq(stations.active, true),
        ),
      )
      .limit(1);

    // An unknown or retired token is not a reason to silently fall back to any
    // free chair: the customer asked for *this* one because they are sitting in
    // it, and a booking at a different table is not what they agreed to.
    if (!station) return NextResponse.json({ error: "unknown-station" }, { status: 404 });
    stationId = station.id;
  }

  // Read here, in the request, and handed down as a trusted value — lib/bookings
  // has no access to cookies and shouldn't grow any. Null for a guest checkout,
  // which is still the ordinary case: an account is optional (brief §2.8).
  const customer = await currentCustomer();

  const result = await createBookings({
    ...data,
    customerId: customer?.id ?? null,
    stationId,
    source: "web",
    // The other half of the start-time guard above. That one refuses the past;
    // this refuses a moment the branch is not open for — a closed weekday, an
    // hour before opening, a service that would run past closing, or an Eid
    // closure. Set here and nowhere else: the counter's own callers reach
    // createBookings directly and must keep being able to seat somebody into a
    // slot the public could never have picked.
    enforceOpeningHours: true,
    // The whole point: a web booking holds the chair but is not a booking until
    // it has been paid for.
    status: "pending",
  });

  if (!result.ok) {
    // 409 for a lost race: the UI should refresh the slots and let the customer
    // pick again, rather than showing a generic failure. A lapsed refill window
    // is the same shape of problem — what they were looking at is no longer on
    // offer — so it gets 409 too.
    //
    // `refill-window` is different: the offer stands, the date is simply outside
    // it. That is a 400 — the request was wrong, not the world. A refused promo
    // code is the same shape of problem, and carries the reason so the checkout
    // can say which of the six it was rather than "invalid code".
    const status =
      result.error === "slot-taken" || result.error === "refill-expired"
        ? 409
        : result.error === "blocked"
          ? 403
          : 400;
    return NextResponse.json(
      {
        error: result.error,
        promoReason: result.promoReason,
        minTotalHalalas: result.minTotalHalalas,
        // A refused reward carries the real balance back, so a checkout showing
        // a stale one can correct itself instead of offering the rung again.
        rewardReason: result.rewardReason,
        pointsBalance: result.pointsBalance,
      },
      { status },
    );
  }

  return NextResponse.json(
    {
      groupId: result.groupId,
      totalHalalas: result.totalHalalas,
      pointsSpent: result.pointsSpent,
      bookings: result.bookings.map((b) => ({ id: b.id, code: b.code })),
    },
    { status: 201 },
  );
}
