// What a technician needs to know about today, and nothing else.
//
// Notably absent: every price column. Technicians don't see revenue — the same
// line the capability matrix draws, and the same reason components/admin/nav.ts
// keeps them out of the reviews screen.

import "server-only";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bookingAddons,
  bookings,
  customers,
  designs,
  services,
  stations,
  type Localized,
} from "@/lib/db/schema";
import { riyadhDateKey, riyadhDayRange } from "@/lib/time";
import { mediaUrl } from "@/lib/storage";
import { performedFilter, periodRange, type PeriodKey } from "@/lib/performance";

export type MyDayBooking = {
  id: string;
  ticketNo: string | null;
  startsAt: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  serviceName: Localized | null;
  designName: Localized | null;
  addons: Localized[];
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

/** One service she has already done, for the 7- and 30-day views. */
export type MyPastService = {
  id: string;
  ticketNo: string | null;
  /** `YYYY-MM-DD` in Riyadh, so the list can group under a day heading. */
  day: string;
  startsAt: string;
  serviceName: Localized | null;
  designName: Localized | null;
  customerName: string | null;
  imageUrl: string | null;
  /** started_at → finished_at, in minutes. Her own clock, not the ticket's. */
  tookMin: number;
};

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

  const rows = await db
    .select({
      id: bookings.id,
      ticketNo: bookings.ticketNo,
      startsAt: bookings.startsAt,
      startedAt: bookings.startedAt,
      finishedAt: bookings.finishedAt,
      serviceName: bookings.serviceName,
      designName: designs.name,
      customerName: sql<string | null>`coalesce(${bookings.customerName}, ${customers.name})`,
      designImage: designs.image,
      serviceImage: services.image,
    })
    .from(bookings)
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .leftJoin(designs, eq(designs.id, bookings.designId))
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        eq(bookings.technicianId, technicianId),
        gte(bookings.startsAt, start),
        lt(bookings.startsAt, end),
        performedFilter(),
      ),
    )
    // Newest first: "what did I just do" is asked far more often than "what did
    // I do a month ago", and the answer should not be at the bottom.
    .orderBy(desc(bookings.startsAt));

  return rows.map((r) => ({
    id: r.id,
    ticketNo: r.ticketNo,
    day: riyadhDateKey(r.startsAt),
    startsAt: r.startsAt.toISOString(),
    serviceName: r.serviceName,
    designName: r.designName,
    customerName: r.customerName?.trim().split(/\s+/)[0] ?? null,
    imageUrl: mediaUrl(r.designImage ?? r.serviceImage),
    // Both are non-null by performedFilter, but the types don't know that.
    tookMin: Math.max(
      0,
      Math.round(((r.finishedAt?.getTime() ?? 0) - (r.startedAt?.getTime() ?? 0)) / 60_000),
    ),
  }));
}

export async function loadMyDay(technicianId: string): Promise<MyDayBooking[]> {
  const { start, end } = riyadhDayRange();

  const rows = await db
    .select({
      id: bookings.id,
      ticketNo: bookings.ticketNo,
      startsAt: bookings.startsAt,
      status: bookings.status,
      startedAt: bookings.startedAt,
      finishedAt: bookings.finishedAt,
      serviceName: bookings.serviceName,
      designName: designs.name,
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
    .where(
      and(
        eq(bookings.technicianId, technicianId),
        gte(bookings.startsAt, start),
        lt(bookings.startsAt, end),
      ),
    )
    .orderBy(asc(bookings.startsAt));

  if (rows.length === 0) return [];

  // One extra query rather than a join: joining add-ons would fan each booking
  // into a row per add-on, and re-collapsing them is more code than this.
  const addonRows = await db
    .select({ bookingId: bookingAddons.bookingId, name: bookingAddons.name })
    .from(bookingAddons)
    .where(
      inArray(
        bookingAddons.bookingId,
        rows.map((r) => r.id),
      ),
    );

  const addonsFor = new Map<string, Localized[]>();
  for (const a of addonRows) {
    if (!a.name) continue;
    const list = addonsFor.get(a.bookingId) ?? [];
    list.push(a.name);
    addonsFor.set(a.bookingId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    ticketNo: r.ticketNo,
    startsAt: r.startsAt.toISOString(),
    status: r.status,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    serviceName: r.serviceName,
    designName: r.designName,
    addons: addonsFor.get(r.id) ?? [],
    stationLabel: r.stationLabel,
    customerName: r.customerName?.trim().split(/\s+/)[0] ?? null,
    notes: r.notes,
    durationMin: r.durationMin ?? null,
    // Design first: it is the specific thing on this customer's hands. The
    // service picture is the generic stand-in when no design was chosen.
    imageUrl: mediaUrl(r.designImage ?? r.serviceImage),
  }));
}
