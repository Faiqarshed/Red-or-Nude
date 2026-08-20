// Public availability lookup for the booking calendar.
//
// ?branchId=…&month=2026-07&duration=90  → which days have any free slot
// ?branchId=…&date=2026-07-24&duration=90 → the slots for one day
// ?…&walkIn=1                             → staff only; ignores the lead time

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDayAvailability, getMonthAvailability } from "@/lib/availability";
import { sweepNoShows } from "@/lib/bookings";
import { getSettings } from "@/lib/settings";
import { currentStaff } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const query = z.object({
  branchId: z.string().uuid(),
  duration: z.coerce.number().int().min(5).max(600).default(60),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  // How many chairs must be free at once — 2 when booking for a pair.
  guests: z.coerce.number().int().min(1).max(2).default(1),
  /**
   * The receptionist is seating someone who is already here, so the booking lead
   * time does not apply. Requested by the walk-in drawer only.
   *
   * An exact "1", not z.coerce.boolean() — that treats every non-empty string as
   * true, so `walkIn=0` and `walkIn=false` would both switch it on.
   */
  walkIn: z.literal("1").optional(),
});

export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = query.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid-query" }, { status: 400 });
  }
  const { branchId, duration, date, month, guests, walkIn } = parsed.data;

  try {
    // Chairs whose customer never checked in are free again, and this is the
    // query the walk-in drawer runs to find them. Without it, a page left open
    // since morning offers a stale grid.
    const { no_show_grace_min: grace } = await getSettings(["no_show_grace_min"]);
    await sweepNoShows(branchId, grace);

    // The flag is a request, not a permission. `currentStaff()` returns null for
    // the public, so an ordinary visitor passing walkIn=1 gets the normal lead
    // time — otherwise anyone could book a slot starting five minutes from now.
    const leadTimeMin = walkIn && (await currentStaff()) ? 0 : undefined;

    if (date) {
      const slots = await getDayAvailability(
        branchId,
        date,
        duration,
        new Date(),
        guests,
        leadTimeMin,
      );
      // freeStationIds is internal scheduling detail — the browser doesn't need
      // to know which chair it would get.
      return NextResponse.json({
        slots: slots.map(({ time, startsAt, available }) => ({ time, startsAt, available })),
      });
    }

    if (month) {
      const [year, m] = month.split("-").map(Number);
      return NextResponse.json({
        days: await getMonthAvailability(branchId, year, m, duration, new Date(), guests),
      });
    }

    return NextResponse.json({ error: "date-or-month-required" }, { status: 400 });
  } catch (err) {
    console.error("[availability] failed", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
