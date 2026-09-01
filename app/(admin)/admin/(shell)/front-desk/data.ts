// Everything the receptionist's screen shows (brief §3.1).
//
// One day, one branch. Ticket numbers restart daily per branch, which is exactly
// what makes a bare "A12" unambiguous at the desk — and why every query here is
// bounded the same way.

import "server-only";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bookingAddons,
  bookings,
  customers,
  designs,
  services,
  staff,
  stations,
  type Localized,
} from "@/lib/db/schema";
import { riyadhDayRange } from "@/lib/time";
import { offOn } from "@/lib/assign";
import { sweepNoShows } from "@/lib/bookings";
import { getSettings } from "@/lib/settings";
import { halalasToSar } from "@/lib/money";
import { mediaUrl } from "@/lib/storage";
import type { BookingStatus } from "../bookings/BookingsView";

/**
 * One of today's bookings, wide enough to be a `BookingRow`.
 *
 * The extra columns are not decoration. The desk's answer to "which chair, and
 * who is doing it" was four facts, and everything else about the booking needed
 * a second screen. Being structurally a `BookingRow` is what lets the detail
 * panel be ../bookings/BookingDrawer rather than a second one written here that
 * would drift from it.
 */
export type FrontDeskRow = {
  id: string;
  code: string;
  ticketNo: string | null;
  startsAt: string;
  /** Needed to tell whether two of the day's bookings collide. */
  endsAt: string;
  status: BookingStatus;
  source: "web" | "walk_in" | "phone";
  /**
   * The technician's own two timestamps, so the desk can show what the service
   * actually took. `startedAt` is Start being pressed, `finishedAt` is Finish —
   * neither is the ticket being closed, which happens here and later.
   * `checkedInAt` is the desk's own, and the start of the salon's waiting time.
   */
  checkedInAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  serviceName: Localized | null;
  addons: Localized[];
  /** What the service is *meant* to take, for the running timer to sit against. */
  durationMin: number | null;
  stationId: string | null;
  stationLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  noShowNote: string | null;
  totalSar: number;
  technicianId: string | null;
  technicianName: string | null;
  /** The chosen design, else the service's own picture. May be null. */
  imageUrl: string | null;
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
  /**
   * `no_show_grace_min`, so the Late lane knows the rule it is displaying.
   * Without it the lane counted any past-start booking as late for ever, while
   * the sweep below had already decided at twenty minutes that nobody came.
   */
  graceMin: number;
  /** `checkin_early_min`, so the drawer can count down to the unlock. */
  checkinEarlyMin: number;
  stats: { finished: number; inService: number; waiting: number; upcoming: number };
};

/**
 * A salon with no branches configured yet. Beside the type it satisfies, so a
 * field added above cannot be forgotten in the two pages that render this.
 */
export const NO_BRANCH: FrontDeskData = {
  rows: [],
  technicians: [],
  graceMin: 0,
  checkinEarlyMin: 0,
  stats: { finished: 0, inService: 0, waiting: 0, upcoming: 0 },
};

export async function loadFrontDesk(branchId: string): Promise<FrontDeskData> {
  const { start, end } = riyadhDayRange();

  // Give back the chairs of customers who never arrived, before reading the day
  // back. Here rather than in the two pages that call this: a receptionist lands
  // on the desk at /admin as well as at /admin/front-desk, and a sweep on one of
  // those routes is a screen still showing "127 min late" on the other. This was
  // the only booking screen missing it.
  await sweepNoShows(branchId);

  const [settings, rows, technicians, off] = await Promise.all([
    getSettings(["no_show_grace_min", "checkin_early_min"]),

    db
      .select({
        id: bookings.id,
        code: bookings.code,
        ticketNo: bookings.ticketNo,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        status: bookings.status,
        source: bookings.source,
        checkedInAt: bookings.checkedInAt,
        startedAt: bookings.startedAt,
        finishedAt: bookings.finishedAt,
        serviceName: bookings.serviceName,
        durationMin: services.durationMin,
        stationId: bookings.stationId,
        stationLabel: stations.label,
        customerName: customers.name,
        customerPhone: customers.phone,
        notes: bookings.notes,
        noShowNote: bookings.noShowNote,
        totalHalalas: bookings.totalHalalas,
        technicianId: bookings.technicianId,
        technicianName: staff.name,
        // The row's *name* stays denormalised on the booking — that is the name
        // as sold, and it must not change under a finished appointment when the
        // catalogue is edited. The picture has no such duty, so it comes from
        // the live catalogue rows via two more joins.
        designImage: designs.image,
        serviceImage: services.image,
      })
      .from(bookings)
      .leftJoin(stations, eq(stations.id, bookings.stationId))
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .leftJoin(staff, eq(staff.id, bookings.technicianId))
      .leftJoin(designs, eq(designs.id, bookings.designId))
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

    offOn(),
  ]);

  // One extra query rather than a join: joining add-ons would fan each booking
  // into a row per add-on, and re-collapsing them is more code than this.
  const addonRows = rows.length
    ? await db
        .select({ bookingId: bookingAddons.bookingId, name: bookingAddons.name })
        .from(bookingAddons)
        .where(
          inArray(
            bookingAddons.bookingId,
            rows.map((r) => r.id),
          ),
        )
    : [];

  const addonsFor = new Map<string, Localized[]>();
  for (const a of addonRows) {
    if (!a.name) continue;
    addonsFor.set(a.bookingId, [...(addonsFor.get(a.bookingId) ?? []), a.name]);
  }

  // Counted here rather than in four more round trips: the day's rows are
  // already in memory and a salon books tens of appointments a day, not
  // thousands.
  const now = Date.now();
  const stats = { finished: 0, inService: 0, waiting: 0, upcoming: 0 };
  for (const r of rows) {
    if (r.status === "completed") stats.finished++;
    else if (r.status === "in_progress" || r.status === "checked_in") stats.inService++;
    else if (r.status === "confirmed") {
      // Split on whether the appointment is due yet: "waiting" is who reception
      // should be looking for right now, "upcoming" is the rest of the day.
      if (new Date(r.startsAt).getTime() <= now) stats.waiting++;
      else stats.upcoming++;
    }
  }

  return {
    rows: rows.map(({ designImage, serviceImage, totalHalalas, ...r }) => ({
      ...r,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      checkedInAt: r.checkedInAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      addons: addonsFor.get(r.id) ?? [],
      totalSar: halalasToSar(totalHalalas),
      // Destructured out above rather than spread through: the two raw storage
      // keys are a server detail, and the client only ever needs the resolved
      // URL. Spreading would ship both to the browser unused.
      imageUrl: mediaUrl(designImage ?? serviceImage),
    })),
    technicians: technicians.map((tech) => ({ ...tech, off: off.has(tech.id) })),
    graceMin: settings.no_show_grace_min,
    checkinEarlyMin: settings.checkin_early_min,
    stats,
  };
}
