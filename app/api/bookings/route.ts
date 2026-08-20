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

export const dynamic = "force-dynamic";

const member = z.object({
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

  const result = await createBookings({
    ...data,
    stationId,
    source: "web",
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
      },
      { status },
    );
  }

  return NextResponse.json(
    {
      groupId: result.groupId,
      totalHalalas: result.totalHalalas,
      bookings: result.bookings.map((b) => ({ id: b.id, code: b.code })),
    },
    { status: 201 },
  );
}
