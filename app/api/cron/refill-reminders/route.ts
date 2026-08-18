// Daily nudge before a refill window closes.
//
// Nothing schedules this yet — it sends through the notify seam, which is a log
// driver until a real provider is configured, so there is nothing to schedule
// for. Wire the Vercel cron entry at the same time as the provider; see
// docs/REFILL-AND-GIFT-CARDS.md.

import { NextResponse } from "next/server";
import { and, eq, gte, inArray, lt, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, services } from "@/lib/db/schema";
import { notify } from "@/lib/notify";
import { refillState } from "@/lib/refill";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

export async function GET(request: Request) {
  // A cron endpoint is a public URL; without this anyone could make the salon
  // message its whole customer list.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const settings = await getSettings(["refill_reminder_days"]);
  const now = new Date();

  // Windows closing `reminderDays` from now. Working backwards from the closing
  // date to a range of appointment days lets the database do the filtering:
  // a window closes at startsAt + refillDays, so we want the bookings whose
  // appointment was refillDays - reminderDays ago. Since refillDays varies per
  // service, scan the widest plausible span and let refillState() decide.
  const oldest = new Date(now.getTime() - 365 * DAY_MS);

  const rows = await db
    .select({
      id: bookings.id,
      code: bookings.code,
      startsAt: bookings.startsAt,
      status: bookings.status,
      serviceName: bookings.serviceName,
      refillOfBookingId: bookings.refillOfBookingId,
      refillDays: services.refillDays,
      email: customers.email,
      phone: customers.phone,
      lang: customers.lang,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        inArray(bookings.status, ["completed", "confirmed"]),
        gte(bookings.startsAt, oldest),
        lt(bookings.startsAt, now),
      ),
    );

  const claimed = new Set(
    rows.length
      ? (
          await db
            .select({ parent: bookings.refillOfBookingId })
            .from(bookings)
            .where(
              and(
                inArray(
                  bookings.refillOfBookingId,
                  rows.map((r) => r.id),
                ),
                notInArray(bookings.status, ["cancelled", "no_show"]),
              ),
            )
        ).map((r) => r.parent)
      : [],
  );

  let sent = 0;

  for (const row of rows) {
    const state = refillState(
      {
        startsAt: row.startsAt,
        status: row.status,
        refillDays: row.refillDays,
        alreadyRefilled: claimed.has(row.id),
        isRefill: Boolean(row.refillOfBookingId),
      },
      now,
    );

    // Exactly the cohort whose window closes on the reminder day. Run daily and
    // every booking is nudged once.
    //
    // ponytail: a missed run means that day's cohort gets no reminder at all.
    // Add a `reminder_sent_at` column and a range check if that ever matters.
    if (!state.eligible || state.daysLeft !== settings.refill_reminder_days) continue;

    const data = {
      code: row.code,
      serviceName: row.serviceName,
      daysLeft: state.daysLeft,
      bookingUrl: "/my-bookings",
    };

    // Whichever way the salon can reach them. Both are no-ops without a driver.
    if (row.email) {
      await notify({
        channel: "email",
        to: row.email,
        template: "refill-reminder",
        lang: row.lang ?? "ar",
        data,
      });
      sent++;
    }
    if (row.phone) {
      await notify({
        channel: "whatsapp",
        to: row.phone,
        template: "refill-reminder",
        lang: row.lang ?? "ar",
        data,
      });
      sent++;
    }
  }

  return NextResponse.json({ scanned: rows.length, sent });
}
