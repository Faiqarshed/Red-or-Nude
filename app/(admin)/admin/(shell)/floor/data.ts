// Who is on the floor for a day, and what each of them is holding.
//
// The screen for a technician going home mid-shift: mark her out, then hand her
// remaining customers to whoever is still here. The front desk answers "who is
// this customer's technician"; this answers "what happens to this technician's
// customers", which is the same day read the other way round.
//
// `day` exists so /admin/technicians can ask the same question about last
// Tuesday. Today's team never passes it. One loader rather than two, because a
// second query over the same join would be the same day counted two ways.

import "server-only";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, services, staff, stations, type Localized } from "@/lib/db/schema";
import { offOn } from "@/lib/assign";
import { sweepNoShows } from "@/lib/bookings";
import { riyadhDayRange } from "@/lib/time";
import type { BookingStatus } from "../bookings/BookingsView";

export type FloorBooking = {
  id: string;
  ticketNo: string | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  serviceName: Localized | null;
  customerName: string | null;
  stationLabel: string | null;
  /** Her own clock: Start, and Finish. Neither is the ticket being closed. */
  startedAt: string | null;
  finishedAt: string | null;
  /** What the service is meant to take, for a running timer to sit against. */
  durationMin: number | null;
  technicianId: string | null;
};

export type FloorTechnician = {
  id: string;
  name: string;
  /** Marked out for today — by this screen, or as leave under Staff. */
  off: boolean;
  bookings: FloorBooking[];
};

export type FloorData = {
  technicians: FloorTechnician[];
  /** The whole day, so the screen can tell who is free across a given slot. */
  rows: FloorBooking[];
};

export async function loadFloor(branchId: string, day?: Date): Promise<FloorData> {
  const { start, end } = riyadhDayRange(day);

  // Same reason as the front desk: a booking nobody checked in to still reads as
  // upcoming until something releases the chair, and this screen is one of the
  // places staff look. Bounded to the last few days by the sweep itself, so it
  // is a no-op when `day` is historical.
  await sweepNoShows(branchId);

  const [rows, technicians, off] = await Promise.all([
    db
      .select({
        id: bookings.id,
        ticketNo: bookings.ticketNo,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        serviceName: bookings.serviceName,
        customerName: sql<string | null>`coalesce(${bookings.customerName}, ${customers.name})`,
        stationLabel: stations.label,
        startedAt: bookings.startedAt,
        finishedAt: bookings.finishedAt,
        durationMin: services.durationMin,
        technicianId: bookings.technicianId,
      })
      .from(bookings)
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .leftJoin(stations, eq(stations.id, bookings.stationId))
      .leftJoin(services, eq(services.id, bookings.serviceId))
      .where(
        and(
          eq(bookings.branchId, branchId),
          gte(bookings.startsAt, start),
          lt(bookings.startsAt, end),
        ),
      )
      .orderBy(asc(bookings.startsAt)),

    db
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(
        and(eq(staff.active, true), eq(staff.role, "technician"), eq(staff.branchId, branchId)),
      )
      .orderBy(asc(staff.name)),

    offOn(day),
  ]);

  const dayRows: FloorBooking[] = rows.map((r) => ({
    ...r,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));

  return {
    technicians: technicians.map((tech) => ({
      id: tech.id,
      name: tech.name,
      off: off.has(tech.id),
      bookings: dayRows.filter((b) => b.technicianId === tech.id),
    })),
    rows: dayRows,
  };
}
