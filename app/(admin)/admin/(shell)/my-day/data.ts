// What a technician needs to know about today, and nothing else.
//
// Notably absent: every price column. Technicians don't see revenue — the same
// line the capability matrix draws, and the same reason components/admin/nav.ts
// keeps them out of the reviews screen.

import "server-only";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
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
import { riyadhDayRange } from "@/lib/time";

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
};

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
      customerName: customers.name,
      notes: bookings.notes,
      durationMin: services.durationMin,
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
  }));
}
