// Cancel a booking from the customer's own history (brief §2.6).
//
// Fully automated — no receptionist in the loop — and the freed chair becomes
// bookable the instant this commits. That takes no work: `cancelled` is excluded
// from the `bookings_station_slot_unique` index, from `reserveStations`, and
// from the availability engine's conflict scan, so cancelling *is* releasing.
//
// Auth is not the booking reference alone. A reference is forwardable and stays
// valid in an inbox forever, so on its own it proves only that you know which
// booking you mean — enough to read it, not enough to end it. This wants a
// session that owns the row, or a code sent to the booking's own address; see
// lib/booking-auth.ts. The throttle below and the audit row remain, but they
// are no longer the only guards.

import { NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { cancelDeadline, cancelRefusal } from "@/lib/cancellation";
import { getSettings } from "@/lib/settings";
import { clientIp, throttled } from "@/lib/throttle";
import { creditCancelled } from "@/lib/wallet";
import { sendCancelCreditEmail } from "@/lib/wallet-email";
import { returnPackCredits } from "@/lib/packs";
import { recordAudit } from "@/lib/audit";
import { notifyCustomer } from "@/lib/notify/customer";
import { refuseBookingAction } from "@/lib/booking-auth";
import { assignIfToday } from "@/lib/assign";
import { utcToLocalDate } from "@/lib/availability";
import { OTP_LENGTH } from "@/lib/otp";
import { readBody } from "@/lib/read-body";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(4).max(20),
  // Absent on the first attempt: a guest is expected to be turned away once
  // with `otp-required`, which is the screen's cue to ask for a code.
  // A regex literal, not a template string: `\d` inside backticks is just "d",
  // which silently makes the pattern match six letter-d's and nothing else.
  otp: z.string().trim().length(OTP_LENGTH).regex(/^\d+$/).optional(),
});

export async function POST(request: Request) {
  // Tighter than the read endpoint: this one moves money and frees chairs, so
  // there is no legitimate reason to call it five times a minute.
  if (throttled(`cancel:${clientIp(request)}`, { max: 5 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  const parsed = await readBody(request, body);
  if (!parsed.ok) return parsed.res;

  const code = parsed.data.code.toUpperCase();

  const [anchor] = await db.select().from(bookings).where(eq(bookings.code, code)).limit(1);
  // No pretence that this hides whether the reference exists — POST
  // /api/my-bookings answers that openly and by design. What is guarded here is
  // the action, not the existence of the booking.
  if (!anchor) return NextResponse.json({ error: "wrong" }, { status: 401 });

  const denied = await refuseBookingAction(anchor, parsed.data.otp);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { cancel_cutoff_hours: cutoff } = await getSettings(["cancel_cutoff_hours"]);

  // A group cancels as a unit. It is one combined bill (§2.4) at a discount that
  // only exists because two people booked together, so releasing half of it
  // would leave the other guest holding a pair price for a solo appointment.
  const members = anchor.groupId
    ? await db
        .select()
        .from(bookings)
        .where(eq(bookings.groupId, anchor.groupId))
        .orderBy(asc(bookings.createdAt), asc(bookings.id))
    : [anchor];

  // Which means it has to be *cancellable* as a unit too, and that is judged on
  // every guest rather than on the one whose reference was quoted.
  //
  // Asking only the anchor split parties down the middle. One friend arrives and
  // the desk checks her in; the other cancels from her phone; the anchor is
  // still `confirmed` so the request is allowed, and the update below silently
  // passes over the guest who is already in the chair. Her friend is released,
  // she is not, and she is left alone holding a price that existed because two
  // of them booked together — the exact outcome the paragraph above forbids.
  //
  // So whoever is furthest along decides for all of them: a party with someone
  // already in a chair is the branch's to sort out, not a self-service button's.
  // The guest herself, not just her refusal: guests hold their own hours now,
  // so the deadline below is hers and not the anchor's.
  const blocked = members.find((m) => cancelRefusal(m, cutoff));
  if (blocked) {
    return NextResponse.json(
      {
        error: cancelRefusal(blocked, cutoff),
        // The customer is being refused; telling them the deadline they missed
        // is more use than telling them "no" — and quoting the anchor's would
        // name an hour that was never the one in the way.
        cancelBy: cancelDeadline(blocked, cutoff).toISOString(),
        cutoffHours: cutoff,
      },
      { status: 409 },
    );
  }

  // Guarded on status as well as id: two taps on a slow connection must not
  // produce two refunds or two credits — the second matches nothing.
  const release = (executor: Pick<typeof db, "update">) =>
    executor
      .update(bookings)
      .set({ status: "cancelled", cancelReason: "customer", updatedAt: new Date() })
      .where(
        and(
          inArray(
            bookings.id,
            members.map((m) => m.id),
          ),
          inArray(bookings.status, ["pending", "confirmed"]),
        ),
      )
      .returning({ id: bookings.id })
      .then((rows) => rows.map((r) => r.id));

  // The wallet (docs/WALLET-PLAN.md): what she paid becomes credit, never a
  // card refund, VAT included as she paid it. The release, the credit and the
  // pack credits are one transaction, so a crash leaves all of them or none.
  const { cancelled, creditedHalalas, creditsBack } = await db.transaction(async (tx) => {
    const ids = await release(tx);
    return {
      cancelled: ids,
      creditedHalalas: await creditCancelled(tx, ids, "cancel-customer"),
      creditsBack: await returnPackCredits(ids, "customer-cancelled", tx),
    };
  });
  if (cancelled.length === 0) {
    return NextResponse.json({ error: "already-cancelled" }, { status: 409 });
  }
  await sendCancelCreditEmail(cancelled);

  await recordAudit(
    { id: null, name: "customer" },
    {
      action: "cancel",
      entity: "bookings",
      entityId: anchor.id,
      diff: {
        status: { from: anchor.status, to: "cancelled" },
        creditedHalalas: { from: null, to: creditedHalalas || null },
        packCreditsReturned: { from: null, to: creditsBack || null },
      },
    },
  );

  await notifyCustomer(anchor.customerId, "booking-cancelled", { count: cancelled.length });

  // The chair came free and so did whoever was holding this hour. Anything left
  // unassigned today may now be staffable, so run the day again — it only fills
  // empty rows, so nobody loses a customer over someone else's cancellation.
  //
  // Once per floor the party sat on, not once for the anchor's. A group may be
  // spread across branches and hours now, and the chair freed at the far one is
  // exactly the one no other pass would come back for.
  const floors = new Map<string, (typeof members)[number]>();
  for (const m of members) floors.set(`${m.branchId}:${utcToLocalDate(m.startsAt)}`, m);
  for (const m of floors.values()) await assignIfToday(m.branchId, m.startsAt);

  return NextResponse.json({
    ok: true,
    cancelled: cancelled.length,
    credited: creditedHalalas,
  });
}
