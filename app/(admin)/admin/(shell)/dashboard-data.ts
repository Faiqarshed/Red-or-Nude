// What the owner's and the manager's home screen shows.
//
// Its own module for the same reason my-day and front-desk have one: /admin
// renders four different screens depending on who signed in, and three query
// blocks inline would make that page the file nobody wants to touch.
//
// Everything here is scoped by `branchIds` — the CEO gets every branch, an
// admin the one he belongs to. The scope is applied in the query, never by
// hiding a number the page already fetched.

import "server-only";
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bookings,
  branchHours,
  branches,
  customers,
  reviews,
  services,
  staff,
  stations,
  type Localized,
} from "@/lib/db/schema";
import { riyadhDateKey, riyadhDayRange, riyadhWeekday } from "@/lib/time";
import { mediaUrl } from "@/lib/storage";
import { offOn } from "@/lib/assign";
import { loadTechnicianStats, type TechnicianStats } from "@/lib/performance";

/** How many days of history the sparkline and the no-show count look back. */
const WEEK = 7;

/**
 * A booking that sold: the chair is spoken for and the money is in.
 *
 * `confirmed` is the line, because confirmBookingPayment is what sets it — this
 * salon takes payment before the appointment exists, so a confirmed booking is
 * a paid one. Everything past it was confirmed on the way through.
 *
 * `pending` is an unpaid hold that may never become anything. `cancelled` was
 * refunded. `no_show` is money the salon may well have kept, but whether a
 * missed appointment counts as takings is a policy question rather than a
 * technical one — add it here the day the salon says so.
 *
 * Used for the takings and for utilisation, deliberately the same list: the
 * chair-time sold and the money charged for it should never disagree.
 *
 * Deliberately not `occupies()` from lib/slots: that answers "is somebody in
 * this chair *right now*", so it excludes `completed`. This is the opposite
 * question — a finished service is exactly the chair-time that sold.
 */
const SOLD = ["confirmed", "checked_in", "in_progress", "completed"];

export type BranchToday = {
  id: string;
  name: Localized;
  bookings: number;
  revenueHalalas: number;
  utilisationPct: number;
  techniciansIn: number;
};

export type TopService = {
  id: string;
  name: Localized | null;
  imageUrl: string | null;
  count: number;
  revenueHalalas: number;
};

/**
 * Something a person has to decide about.
 *
 * Structured rather than pre-worded: the view is bilingual, so the copy belongs
 * with the other copy in lib/admin/strings.ts and the numbers belong here.
 */
export type Attention =
  | { kind: "unassigned"; count: number; startsAt: string[] }
  | { kind: "lowReview"; rating: number; customer: string | null; service: Localized | null }
  | { kind: "onLeave"; names: string[] };

export type DashboardData = {
  revenue: {
    todayHalalas: number;
    /** Null when there is no comparable day — a salon open less than a week. */
    deltaPct: number | null;
    week: number[];
  };
  utilisation: { pct: number; soldMin: number; capacityMin: number };
  counts: { today: number; upcoming: number; noShowsWeek: number };
  branches: BranchToday[];
  topServices: TopService[];
  technicians: TechnicianStats[];
  attention: Attention[];
};

/** "10:00:00" → minutes since midnight. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export async function loadDashboard(branchIds: string[]): Promise<DashboardData> {
  const { start, end } = riyadhDayRange();
  const weekAgo = new Date(start.getTime() - WEEK * 24 * 60 * 60 * 1000);
  const inScope = inArray(bookings.branchId, branchIds);

  const [window, today, chairs, hours, branchRows, technicians, lowReview, off, upcoming, techStats] =
    await Promise.all([
      // One pass over the last eight days answers three questions: what today
      // took, what the same weekday took a week ago, and the shape of the week
      // between them. Bucketing in JS rather than grouping in SQL keeps the
      // Riyadh calendar day out of the query — the same reason offOn compares
      // date strings instead of doing timezone arithmetic.
      db
        .select({
          startsAt: bookings.startsAt,
          status: bookings.status,
          totalHalalas: bookings.totalHalalas,
        })
        .from(bookings)
        .where(and(inScope, gte(bookings.startsAt, weekAgo), lt(bookings.startsAt, end))),

      // Today in detail. Utilisation, the branch table, the top services and
      // the unassigned warning all read this one result.
      db
        .select({
          branchId: bookings.branchId,
          startsAt: bookings.startsAt,
          endsAt: bookings.endsAt,
          status: bookings.status,
          totalHalalas: bookings.totalHalalas,
          technicianId: bookings.technicianId,
          serviceId: bookings.serviceId,
          serviceName: bookings.serviceName,
          serviceImage: services.image,
        })
        .from(bookings)
        .leftJoin(services, eq(services.id, bookings.serviceId))
        .where(and(inScope, gte(bookings.startsAt, start), lt(bookings.startsAt, end)))
        .orderBy(asc(bookings.startsAt)),

      db
        .select({ branchId: stations.branchId })
        .from(stations)
        .where(and(inArray(stations.branchId, branchIds), eq(stations.active, true))),

      db
        .select({ branchId: branchHours.branchId, opens: branchHours.opens, closes: branchHours.closes })
        .from(branchHours)
        .where(
          and(
            inArray(branchHours.branchId, branchIds),
            eq(branchHours.weekday, riyadhWeekday(start)),
            eq(branchHours.closed, false),
          ),
        ),

      db
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(inArray(branches.id, branchIds))
        .orderBy(asc(branches.sort)),

      db
        .select({ id: staff.id, name: staff.name, branchId: staff.branchId })
        .from(staff)
        .where(
          and(eq(staff.role, "technician"), eq(staff.active, true), inArray(staff.branchId, branchIds)),
        )
        .orderBy(asc(staff.name)),

      // The worst thing a customer said lately. One row: a list of complaints
      // belongs on /admin/reviews, and this panel is "what needs you now".
      db
        .select({
          serviceRating: reviews.serviceRating,
          techRating: reviews.techRating,
          serviceName: bookings.serviceName,
          customerName: sql<string | null>`coalesce(${bookings.customerName}, ${customers.name})`,
        })
        .from(reviews)
        .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
        .leftJoin(customers, eq(customers.id, bookings.customerId))
        .where(
          and(
            inScope,
            gte(reviews.submittedAt, weekAgo),
            or(lte(reviews.serviceRating, 2), lte(reviews.techRating, 2)),
          ),
        )
        .orderBy(desc(reviews.submittedAt))
        .limit(1),

      offOn(start),

      db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(inScope, gte(bookings.startsAt, end), eq(bookings.status, "confirmed"))),

      loadTechnicianStats({
        period: "today",
        branchId: branchIds.length === 1 ? branchIds[0] : null,
      }),
    ]);

  // ---------------------------------------------------------------- money ---

  const byDay = new Map<string, number>();
  let noShowsWeek = 0;
  for (const row of window) {
    if (row.status === "no_show") noShowsWeek++;
    // Not `completed`: that is reception closing the ticket, which happens hours
    // after the customer paid and sometimes not until the next morning. Counting
    // it left the takings reading zero all day with a full salon.
    if (!SOLD.includes(row.status)) continue;
    const key = riyadhDateKey(row.startsAt);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(row.totalHalalas ?? 0));
  }

  const week: number[] = [];
  for (let i = WEEK - 1; i >= 0; i--) {
    week.push(byDay.get(riyadhDateKey(new Date(start.getTime() - i * 24 * 60 * 60 * 1000))) ?? 0);
  }
  const todayHalalas = week[week.length - 1];
  const lastWeek = byDay.get(riyadhDateKey(weekAgo)) ?? 0;

  // A percentage against zero is infinity, and "up ∞%" on a salon's first
  // Tuesday is worse than saying nothing.
  const deltaPct = lastWeek > 0 ? Math.round(((todayHalalas - lastWeek) / lastWeek) * 100) : null;

  // ---------------------------------------------------------- the branches ---

  const chairsPer = new Map<string, number>();
  for (const c of chairs) chairsPer.set(c.branchId, (chairsPer.get(c.branchId) ?? 0) + 1);

  const openMinPer = new Map<string, number>();
  for (const h of hours) openMinPer.set(h.branchId, Math.max(0, toMinutes(h.closes) - toMinutes(h.opens)));

  const techsPer = new Map<string, number>();
  for (const t of technicians) {
    if (!t.branchId || off.has(t.id)) continue;
    techsPer.set(t.branchId, (techsPer.get(t.branchId) ?? 0) + 1);
  }

  const soldMinPer = new Map<string, number>();
  const bookingsPer = new Map<string, number>();
  const revenuePer = new Map<string, number>();
  const unassigned: Date[] = [];
  const serviceTotals = new Map<string, TopService>();

  for (const b of today) {
    bookingsPer.set(b.branchId, (bookingsPer.get(b.branchId) ?? 0) + 1);

    // One pass, one rule: a booking that sold contributes both its money and
    // its chair-time, so the branch table can never show takings against an
    // occupancy figure that disagrees about which bookings were real.
    if (SOLD.includes(b.status)) {
      revenuePer.set(b.branchId, (revenuePer.get(b.branchId) ?? 0) + Number(b.totalHalalas ?? 0));
      const min = Math.max(0, (b.endsAt.getTime() - b.startsAt.getTime()) / 60000);
      soldMinPer.set(b.branchId, (soldMinPer.get(b.branchId) ?? 0) + min);
    }

    // Confirmed and nobody on it. `pending` is an unpaid hold and is not yet
    // anybody's problem; anything past confirmed already has someone.
    if (b.status === "confirmed" && !b.technicianId) unassigned.push(b.startsAt);

    if (b.serviceId && b.status !== "cancelled" && b.status !== "no_show") {
      const row = serviceTotals.get(b.serviceId) ?? {
        id: b.serviceId,
        name: b.serviceName,
        imageUrl: mediaUrl(b.serviceImage),
        count: 0,
        revenueHalalas: 0,
      };
      row.count++;
      row.revenueHalalas += Number(b.totalHalalas ?? 0);
      serviceTotals.set(b.serviceId, row);
    }
  }

  const capacityOf = (id: string) => (chairsPer.get(id) ?? 0) * (openMinPer.get(id) ?? 0);
  const pctOf = (sold: number, capacity: number) =>
    capacity > 0 ? Math.round((sold / capacity) * 100) : 0;

  const branchList: BranchToday[] = branchRows.map((b) => ({
    id: b.id,
    name: b.name,
    bookings: bookingsPer.get(b.id) ?? 0,
    revenueHalalas: revenuePer.get(b.id) ?? 0,
    utilisationPct: pctOf(soldMinPer.get(b.id) ?? 0, capacityOf(b.id)),
    techniciansIn: techsPer.get(b.id) ?? 0,
  }));

  const soldMin = Math.round([...soldMinPer.values()].reduce((a, b) => a + b, 0));
  const capacityMin = branchIds.reduce((a, id) => a + capacityOf(id), 0);

  // ------------------------------------------------------------ attention ---

  const attention: Attention[] = [];

  if (unassigned.length) {
    attention.push({
      kind: "unassigned",
      count: unassigned.length,
      startsAt: unassigned.slice(0, 3).map((d) => d.toISOString()),
    });
  }

  const worst = lowReview[0];
  if (worst) {
    const ratings = [worst.serviceRating, worst.techRating].filter(
      (r): r is number => typeof r === "number",
    );
    attention.push({
      kind: "lowReview",
      rating: Math.min(...ratings),
      customer: worst.customerName,
      service: worst.serviceName,
    });
  }

  const away = technicians.filter((t) => off.has(t.id)).map((t) => t.name);
  if (away.length) attention.push({ kind: "onLeave", names: away });

  return {
    revenue: { todayHalalas, deltaPct, week },
    utilisation: { pct: pctOf(soldMin, capacityMin), soldMin, capacityMin },
    counts: { today: today.length, upcoming: upcoming.length, noShowsWeek },
    branches: branchList,
    topServices: [...serviceTotals.values()]
      .sort((a, b) => b.revenueHalalas - a.revenueHalalas)
      .slice(0, 5),
    technicians: techStats,
    attention,
  };
}
