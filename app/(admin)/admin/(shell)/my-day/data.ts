// What a technician needs to know about today, and nothing else.
//
// Notably absent: every price column. Technicians don't see revenue — the same
// line the capability matrix draws, and the same reason components/admin/nav.ts
// keeps them out of the reviews screen.

import "server-only";
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bookings,
  customers,
  designs,
  removalTypes,
  services,
  stations,
  type Localized,
} from "@/lib/db/schema";
import { riyadhDateKey, riyadhDayRange } from "@/lib/time";
import { mediaUrl } from "@/lib/storage";
import { addonLinesFor, NO_LINES, type Treat } from "@/lib/admin/addon-lines";
import { performedFilter, periodRange, type PeriodKey } from "@/lib/performance";

export type MyDayBooking = {
  id: string;
  ticketNo: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  serviceName: Localized | null;
  designName: Localized | null;
  /** Nail work bought alongside the service. Pills, as before. */
  addons: Localized[];
  /**
   * Coffee and treats, kept apart from the add-ons above.
   *
   * The salon's actual complaint: she is the one who fetches these, and until
   * now they arrived in the same grey row as the nail add-ons with nothing to
   * say one was a drink. A technician reading "gel removal, hot coffee" as one
   * list has to know the catalogue to tell which is which.
   */
  treats: Treat[];
  /** Taking the old set off comes before the service, so she needs to know. */
  removal: Localized | null;
  stationLabel: string | null;
  /** First name only — all a technician needs to greet her by. */
  customerName: string | null;
  notes: string | null;
  /** What the service is *meant* to take, for the timer to sit against. */
  durationMin: number | null;
  /**
   * The design she is about to paint, falling back to the service's own picture.
   *
   * Resolved through mediaUrl here rather than in the view: storage keys are a
   * server concern, and MyDayView is a client component.
   */
  imageUrl: string | null;
};

export type { Treat };

/**
 * One service she has already done, for the 7- and 30-day views. Everything
 * the day's card carries, so a row opens into the same detail dialog.
 */
export type MyPastService = MyDayBooking & {
  /** `YYYY-MM-DD` in Riyadh, so the list can group under a day heading. */
  day: string;
  /** started_at → finished_at, in minutes. Her own clock, not the ticket's. */
  tookMin: number;
};

/**
 * Her bookings in a window, with everything the card and the dialog show.
 *
 * Shared by the day board and the history so the two cannot drift apart on
 * what a technician is told about a booking.
 */
async function loadTechBookings(technicianId: string, where: SQL | undefined, newestFirst: boolean) {
  const rows = await db
    .select({
      id: bookings.id,
      ticketNo: bookings.ticketNo,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      startedAt: bookings.startedAt,
      finishedAt: bookings.finishedAt,
      serviceName: bookings.serviceName,
      designName: designs.name,
      // Named from the catalogue: bookings snapshot the removal's price but not
      // its name.
      removal: removalTypes.name,
      stationLabel: stations.label,
      customerName: sql<string | null>`coalesce(${bookings.customerName}, ${customers.name})`,
      notes: bookings.notes,
      durationMin: services.durationMin,
      // Both joins are already here for the name and the duration, so these are
      // two more columns rather than two more queries.
      designImage: designs.image,
      serviceImage: services.image,
    })
    .from(bookings)
    .leftJoin(stations, eq(stations.id, bookings.stationId))
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .leftJoin(designs, eq(designs.id, bookings.designId))
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(removalTypes, eq(removalTypes.id, bookings.removalTypeId))
    .where(and(eq(bookings.technicianId, technicianId), where))
    .orderBy(newestFirst ? desc(bookings.startsAt) : asc(bookings.startsAt));

  if (rows.length === 0) return [];

  // A separate query: joining add-ons onto `bookings` would fan each booking
  // into a row per add-on. The shared loader selects no price — see the header.
  const lines = await addonLinesFor(rows.map((r) => r.id));

  return rows.map(
    (r): MyDayBooking => ({
      id: r.id,
      ticketNo: r.ticketNo,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      status: r.status,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      serviceName: r.serviceName,
      designName: r.designName,
      ...(lines.get(r.id) ?? NO_LINES),
      removal: r.removal,
      stationLabel: r.stationLabel,
      customerName: r.customerName?.trim().split(/\s+/)[0] ?? null,
      notes: r.notes,
      durationMin: r.durationMin ?? null,
      // Design first: it is the specific thing on this customer's hands. The
      // service picture is the generic stand-in when no design was chosen.
      imageUrl: mediaUrl(r.designImage ?? r.serviceImage),
    }),
  );
}

/**
 * What she has finished, most recent first.
 *
 * Shares `periodRange` and `performedFilter` with lib/performance.ts, which is
 * what makes the "services" tile above this list count exactly the rows in it.
 *
 * Prices stay out, same as loadMyDay — a technician's screen has never shown
 * revenue and this is not the place to start.
 */
export async function loadMyHistory(
  technicianId: string,
  period: PeriodKey,
): Promise<MyPastService[]> {
  const { start, end } = periodRange(period);
  // Newest first: "what did I just do" is asked far more often than "what did
  // I do a month ago", and the answer should not be at the bottom.
  const rows = await loadTechBookings(
    technicianId,
    and(gte(bookings.startsAt, start), lt(bookings.startsAt, end), performedFilter()),
    true,
  );
  return rows.map((b) => ({
    ...b,
    day: riyadhDateKey(new Date(b.startsAt)),
    // Both are non-null by performedFilter, but the types don't know that.
    tookMin: Math.max(
      0,
      Math.round(
        (new Date(b.finishedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime()) / 60_000,
      ),
    ),
  }));
}

export async function loadMyDay(technicianId: string): Promise<MyDayBooking[]> {
  const { start, end } = riyadhDayRange();
  return loadTechBookings(technicianId, and(gte(bookings.startsAt, start), lt(bookings.startsAt, end)), false);
}
