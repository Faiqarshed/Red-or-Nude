// Everything the receptionist's screen shows (brief §3.1).
//
// One day, one branch. Ticket numbers restart daily per branch, which is exactly
// what makes a bare "A12" unambiguous at the desk — and why every query here is
// bounded the same way.

import "server-only";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, staff, stations, type Localized } from "@/lib/db/schema";
import { riyadhDayRange } from "@/lib/time";
import { offOn } from "@/lib/assign";

export type FrontDeskRow = {
  id: string;
  ticketNo: string | null;
  startsAt: string;
  /** Needed to tell whether two of the day's bookings collide. */
  endsAt: string;
  status: string;
  finishedAt: string | null;
  serviceName: Localized | null;
  stationLabel: string | null;
  customerName: string | null;
  technicianId: string | null;
  technicianName: string | null;
};

export type TechnicianOption = {
  id: string;
  name: string;
  /**
   * Not in today (staff_time_off).
   *
   * Whether she is *free* is deliberately not here: that depends on which
   * booking you are looking at, so the screen works it out per row against the
   * day it already has. "Busy" is a fact about a slot, not about a person.
   */
  off: boolean;
};

export type FrontDeskData = {
  rows: FrontDeskRow[];
  technicians: TechnicianOption[];
  stats: { finished: number; inService: number; waiting: number; upcoming: number };
};

export async function loadFrontDesk(branchId: string): Promise<FrontDeskData> {
  const { start, end } = riyadhDayRange();

  const [rows, technicians, off] = await Promise.all([
    db
      .select({
        id: bookings.id,
        ticketNo: bookings.ticketNo,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        finishedAt: bookings.finishedAt,
        serviceName: bookings.serviceName,
        stationLabel: stations.label,
        customerName: customers.name,
        technicianId: bookings.technicianId,
        technicianName: staff.name,
      })
      .from(bookings)
      .leftJoin(stations, eq(stations.id, bookings.stationId))
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .leftJoin(staff, eq(staff.id, bookings.technicianId))
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



  // Counted here rather than in four more round trips: the day's rows are
  // already in memory and a salon books tens of appointments a day, not
  // thousands.
  const now = Date.now();
  const stats = { finished: 0, inService: 0, waiting: 0, upcoming: 0 };
  for (const r of rows) {
    if (r.status === "completed") stats.finished++;
    else if (r.status === "in_progress" || r.status === "checked_in") stats.inService++;
    else if (r.status === "confirmed") {
      // Split on whether she is due yet: "waiting" is who reception should be
      // looking for right now, "upcoming" is the rest of the day.
      if (new Date(r.startsAt).getTime() <= now) stats.waiting++;
      else stats.upcoming++;
    }
  }

  return {
    rows: rows.map((r) => ({
      ...r,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
    technicians: technicians.map((tech) => ({ ...tech, off: off.has(tech.id) })),
    stats,
  };
}
