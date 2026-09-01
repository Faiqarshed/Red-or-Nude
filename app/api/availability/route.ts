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
    // `walkIn` is a request, not a permission: currentStaff() returns null for
    // the public, so an ordinary visitor passing walkIn=1 is treated as one.
    // Otherwise anyone could book a slot starting five minutes from now.
    const staff = walkIn ? await currentStaff() : null;

    if (staff) {
      // Chairs whose customer never checked in are free again, and this is the
      // query the walk-in drawer runs to find them — a page left open since
      // morning would otherwise offer a stale grid.
      //
      // Only on the staff path. The public cannot use a released chair anyway:
      // the slot it frees is always in the past, and the lead time hides it. So
      // sweeping for them would be a write on every calendar click for nothing.
      await sweepNoShows(branchId);
    }

    if (date) {
      const slots = await getDayAvailability(
        branchId,
        date,
        duration,
        new Date(),
        guests,
        staff ? 0 : undefined,
      );
      // freeStationIds is internal scheduling detail — the browser doesn't need
      // to know which chair it would get. `blockedBy` is not that: it is the
      // reason the picker has to show, and without it every unbookable slot
      // renders as "taken" whether the chairs were free or not.
      //
      // `leadTimeMin` rides along so the picker can state the rule exactly. It
      // cannot be inferred from the slots — the first bookable one is wherever
      // the grid happens to fall after the cutoff, which is a different number.
      // Zero for staff, who are exempt, and the picker then says nothing.
      const { booking_lead_time_min } = await getSettings(["booking_lead_time_min"]);
      return NextResponse.json({
        leadTimeMin: staff ? 0 : booking_lead_time_min,
        slots: slots.map(({ time, startsAt, available, blockedBy }) => ({
          time,
          startsAt,
          available,
          blockedBy,
        })),
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
