// Public availability lookup for the booking calendar.
//
// ?branchId=…&month=2026-07&duration=90  → which days have any free slot
// ?branchId=…&date=2026-07-24&duration=90 → the slots for one day

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDayAvailability, getMonthAvailability } from "@/lib/availability";

export const dynamic = "force-dynamic";

const query = z.object({
  branchId: z.string().uuid(),
  duration: z.coerce.number().int().min(5).max(600).default(60),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = query.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid-query" }, { status: 400 });
  }
  const { branchId, duration, date, month } = parsed.data;

  try {
    if (date) {
      const slots = await getDayAvailability(branchId, date, duration);
      // freeStationIds is internal scheduling detail — the browser doesn't need
      // to know which chair it would get.
      return NextResponse.json({
        slots: slots.map(({ time, startsAt, available }) => ({ time, startsAt, available })),
      });
    }

    if (month) {
      const [year, m] = month.split("-").map(Number);
      return NextResponse.json({ days: await getMonthAvailability(branchId, year, m, duration) });
    }

    return NextResponse.json({ error: "date-or-month-required" }, { status: 400 });
  } catch (err) {
    console.error("[availability] failed", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
