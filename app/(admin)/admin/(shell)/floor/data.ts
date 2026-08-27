// Who is on the floor today, and what each of them is holding.
//
// The screen for a technician going home mid-shift: mark her out, then hand her
// remaining customers to whoever is still here. The front desk answers "who is
// this customer's technician"; this answers "what happens to this technician's
// customers", which is the same day read the other way round.

import "server-only";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, staff, type Localized } from "@/lib/db/schema";
import { offOn } from "@/lib/assign";
import { riyadhDayRange } from "@/lib/time";

export type FloorBooking = {
  id: string;
  ticketNo: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  serviceName: Localized | null;
  customerName: string | null;
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

export async function loadFloor(branchId: string): Promise<FloorData> {
  const { start, end } = riyadhDayRange();

  const [rows, technicians, off] = await Promise.all([
    db
      .select({
        id: bookings.id,
        ticketNo: bookings.ticketNo,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        serviceName: bookings.serviceName,
        customerName: customers.name,
        technicianId: bookings.technicianId,
      })
      .from(bookings)
      .leftJoin(customers, eq(customers.id, bookings.customerId))
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

    offOn(),
  ]);

  const day: FloorBooking[] = rows.map((r) => ({
    ...r,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
  }));

  return {
    technicians: technicians.map((tech) => ({
      id: tech.id,
      name: tech.name,
      off: off.has(tech.id),
      bookings: day.filter((b) => b.technicianId === tech.id),
    })),
    rows: day,
  };
}
