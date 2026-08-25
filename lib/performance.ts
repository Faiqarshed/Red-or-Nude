// How long the floor is taking (brief §3.2).
//
// One query, two readers: /admin/performance shows every technician at a branch,
// and a technician's own screen shows only her. Same arithmetic either way —
// there is no version of "average service time" that should differ depending on
// who is looking at it.
//
// **No money here.** The commission rule has not been stated by the client, and
// a guessed payroll formula is a dispute rather than a feature. These are the
// numbers it will be calculated from; when the rule arrives it is one function
// over this output, with no schema change and no new screen.

import "server-only";
import { and, asc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, services, staff } from "@/lib/db/schema";
import { riyadhDayRange } from "@/lib/time";

/** Days of history *before* today. "today" is today alone. */
const PERIOD_DAYS = { today: 0, "7": 6, "30": 29 } as const;

export type PeriodKey = keyof typeof PERIOD_DAYS;

export function isPeriodKey(value: unknown): value is PeriodKey {
  return value === "today" || value === "7" || value === "30";
}

export type TechnicianStats = {
  id: string;
  name: string;
  services: number;
  /** started_at → finished_at, the technician's own number. */
  avgServiceMin: number;
  /** checked_in_at → started_at: the salon's waiting time, not hers. */
  avgWaitMin: number | null;
  /** Signed: negative is faster than the service's expected duration. */
  avgVsExpectedMin: number | null;
  /** Minutes actually worked over the period — the raw figure for commission. */
  totalServiceMin: number;
};

/**
 * `branchId` null means every branch (the CEO). `technicianId` narrows to one
 * person, which is how a technician reads her own numbers without being handed
 * everyone else's.
 */
export async function loadTechnicianStats(opts: {
  period: PeriodKey;
  branchId?: string | null;
  technicianId?: string | null;
}): Promise<TechnicianStats[]> {
  const { start: todayStart, end } = riyadhDayRange();
  const start = new Date(todayStart.getTime() - PERIOD_DAYS[opts.period] * 86_400_000);

  const rows = await db
    .select({
      technicianId: bookings.technicianId,
      technicianName: staff.name,
      checkedInAt: bookings.checkedInAt,
      startedAt: bookings.startedAt,
      finishedAt: bookings.finishedAt,
      durationMin: services.durationMin,
    })
    .from(bookings)
    .innerJoin(staff, eq(staff.id, bookings.technicianId))
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        opts.branchId ? eq(bookings.branchId, opts.branchId) : undefined,
        opts.technicianId ? eq(bookings.technicianId, opts.technicianId) : undefined,
        gte(bookings.startsAt, start),
        lt(bookings.startsAt, end),
        // A service nobody started or finished has no duration to report on.
        isNotNull(bookings.startedAt),
        isNotNull(bookings.finishedAt),
      ),
    )
    .orderBy(asc(staff.name));

  // Aggregated in JS rather than SQL: a salon finishes tens of services a day,
  // so even the 30-day view is a few hundred rows, and the arithmetic stays
  // readable next to what it means.
  type Acc = TechnicianStats & { waitSamples: number; expectedSamples: number };
  const byTech = new Map<string, Acc>();

  for (const r of rows) {
    if (!r.technicianId || !r.startedAt || !r.finishedAt) continue;

    const serviceMin = (r.finishedAt.getTime() - r.startedAt.getTime()) / 60000;
    const waitMin = r.checkedInAt
      ? (r.startedAt.getTime() - r.checkedInAt.getTime()) / 60000
      : null;

    const acc =
      byTech.get(r.technicianId) ??
      ({
        id: r.technicianId,
        name: r.technicianName,
        services: 0,
        avgServiceMin: 0,
        avgWaitMin: null,
        avgVsExpectedMin: null,
        totalServiceMin: 0,
        waitSamples: 0,
        expectedSamples: 0,
      } as Acc);

    // Running totals live in the same fields; divided through below.
    acc.services += 1;
    acc.avgServiceMin += serviceMin;
    acc.totalServiceMin += serviceMin;

    // Averaged over the rows that *have* the figure, not over every service —
    // a booking with no check-in stamp must not drag a wait average toward zero.
    if (waitMin !== null) {
      acc.avgWaitMin = (acc.avgWaitMin ?? 0) + waitMin;
      acc.waitSamples += 1;
    }
    if (r.durationMin) {
      acc.avgVsExpectedMin = (acc.avgVsExpectedMin ?? 0) + (serviceMin - r.durationMin);
      acc.expectedSamples += 1;
    }

    byTech.set(r.technicianId, acc);
  }

  return [...byTech.values()]
    .map(({ waitSamples, expectedSamples, ...s }) => ({
      ...s,
      avgServiceMin: Math.round(s.avgServiceMin / s.services),
      totalServiceMin: Math.round(s.totalServiceMin),
      avgWaitMin: waitSamples === 0 ? null : Math.round((s.avgWaitMin ?? 0) / waitSamples),
      avgVsExpectedMin:
        expectedSamples === 0 ? null : Math.round((s.avgVsExpectedMin ?? 0) / expectedSamples),
    }))
    .sort((a, b) => b.services - a.services);
}
