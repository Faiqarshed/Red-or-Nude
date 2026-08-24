// Submitting a rating (brief §2.9).
//
// Auth is the token in the emailed link and nothing else. That is the right
// weight for what it opens: the token writes two scores and a comment onto one
// finished appointment, moves no money and reveals nothing about the customer
// beyond the service they already know they had. The guards are the throttle
// below and the single-use rule — a review is answered once.

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { reviews } from "@/lib/db/schema";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const rating = z.number().int().min(1).max(5);

const body = z.object({
  token: z.string().uuid(),
  serviceRating: rating,
  /** Skippable — plenty of customers rate the service and not the person. */
  techRating: rating.nullable().optional(),
  comment: z.string().trim().max(1000).nullable().optional(),
});

export async function POST(request: Request) {
  if (throttled(`review:${clientIp(request)}`, { max: 5 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const { token, serviceRating, techRating, comment } = parsed.data;

  // One statement, so it needs no transaction to be atomic. Guarded on
  // `submitted_at is null` as well as the token: two taps on a slow connection
  // must not overwrite the first answer with the second.
  const [row] = await db
    .update(reviews)
    .set({
      serviceRating,
      techRating: techRating ?? null,
      comment: comment?.trim() || null,
      submittedAt: new Date(),
    })
    .where(and(eq(reviews.token, token), isNull(reviews.submittedAt)))
    .returning({ id: reviews.id });

  if (!row) {
    // Already answered, or no such token. Deliberately one answer for both: a
    // caller walking the token space learns nothing from the difference.
    return NextResponse.json({ error: "already-submitted" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
