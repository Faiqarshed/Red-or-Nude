// "Your next customer is in half an hour" — sent to the assigned technician.
//
// NOT scheduled in vercel.json. It wants a quarter-hourly run, and Vercel's
// Hobby plan refuses any cron more frequent than once a day — the deployment
// fails outright on `*/15 * * * *`, taking the morning assignment job down with
// it. Until the project is on Pro, drive this from outside instead:
//
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/tech-reminders
//
// from any scheduler that can fire every 15 minutes (GitHub Actions, cron-job.org,
// a box you already own). Unscheduled, the technician still learns about her
// customer at check-in — she just loses the half-hour of warning.
//
// The window (`assign_notify_min`) must stay comfortably wider than the gap
// between runs, or an appointment can fall between two firings and be missed.
//
// Sent once, ever: `tech_notified_at` is stamped after the mail, and check-in
// stamps it too, so a customer who arrives early never costs her technician a
// second copy of the same message.

import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { notifyTechnician } from "@/lib/assign";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // A cron endpoint is a public URL; without this anyone could mail the salon's
  // staff on demand.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { assign_notify_min: windowMin } = await getSettings(["assign_notify_min"]);
  const now = new Date();
  const until = new Date(now.getTime() + windowMin * 60_000);

  const due = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "confirmed"),
        isNotNull(bookings.technicianId),
        isNull(bookings.techNotifiedAt),
        // Not the ones already past: a slot that started before this run went by
        // unassigned or unnoticed, and a late "starting soon" helps nobody.
        gte(bookings.startsAt, now),
        lte(bookings.startsAt, until),
      ),
    );

  for (const row of due) {
    // Stamped first. notifyTechnician never throws, so a failure there is a
    // missing nudge — while a failure *after* an unstamped send would mail the
    // same technician again every quarter hour until her customer arrives.
    await db
      .update(bookings)
      .set({ techNotifiedAt: new Date() })
      .where(eq(bookings.id, row.id));

    await notifyTechnician(row.id);
  }

  return NextResponse.json({ ok: true, sent: due.length });
}
