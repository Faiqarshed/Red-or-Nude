// Public booking creation — the hold, not the sale.
//
// This reserves the chair(s) and writes the rows as `pending`. Nothing is
// confirmed and no ticket number exists until POST /api/payments/confirm
// succeeds. An abandoned hold is swept back out automatically.
//
// The body is members-shaped so one guest and two go through the same route:
// a group is simply two members with one start time.

import { NextResponse } from "next/server";
import { z } from "zod";
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
    // Required on the web, unlike a walk-in: this is where the booking
    // reference is sent, and that reference is the only key to /my-bookings.
    email: z.string().trim().email("invalid-email"),
    lang: z.enum(["ar", "en"]).optional(),
  }),
  /** Set by the refill button in the customer's booking history. */
  refillOfCode: z.string().trim().max(20).nullable().optional(),
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

  const result = await createBookings({
    ...parsed.data,
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
    const status =
      result.error === "slot-taken" || result.error === "refill-expired"
        ? 409
        : result.error === "blocked"
          ? 403
          : 400;
    return NextResponse.json({ error: result.error }, { status });
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
