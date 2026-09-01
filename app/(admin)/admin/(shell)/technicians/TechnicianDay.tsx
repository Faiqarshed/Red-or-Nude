"use client";

// One technician's day, as a list and as five numbers.
//
// Two screens ask for this and they ask for the same thing: /admin/floor, where
// the question is "what is she holding right now", and /admin/technicians, where
// it is "what did she do on the 14th". Written once, because a day that counted
// differently depending on which screen was open would be worse than either.
//
// Read-only by construction. Acting on a booking is the front desk's job, and
// the reassignment picker that /admin/floor puts under a technician who has gone
// home is a different question with its own controls.

import { useEffect, useState } from "react";
import { Badge } from "@/components/admin/ui";
import { STATUS_TONE } from "../bookings/BookingsView";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { formatDuration, localTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { FloorBooking } from "../floor/data";

/**
 * A clock both card screens read, ticking once a minute.
 *
 * A running service counts up, so the figures have to move. One interval per
 * screen rather than one per card: it is the same second either way.
 */
export function useDayClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Which cards are unfolded. Several at once — both screens are comparisons. */
export function useToggleSet(): [Set<string>, (id: string) => void] {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return [
    open,
    (id) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
  ];
}

/**
 * The day in five figures, off rows already in memory.
 *
 * `minutesWorked` is her own clock — Start to Finish — and counts only what she
 * has actually finished. A service still running has no duration yet, and
 * guessing one from the wall clock would make the number move every time the
 * page refreshed.
 */
export function countDay(rows: FloorBooking[]) {
  let done = 0;
  let inService = 0;
  let noShow = 0;
  let minutesWorked = 0;

  for (const b of rows) {
    if (b.status === "no_show") noShow++;
    else if (b.finishedAt || b.status === "completed") done++;
    else if (b.status === "checked_in" || b.status === "in_progress") inService++;

    if (b.startedAt && b.finishedAt) {
      minutesWorked += (new Date(b.finishedAt).getTime() - new Date(b.startedAt).getTime()) / 60_000;
    }
  }

  return {
    booked: rows.length,
    done,
    inService,
    noShow,
    minutesWorked: Math.round(minutesWorked),
    // Averaged over what she finished, not over the day: a technician with two
    // services and four no-shows has not averaged a third of her usual time.
    avgMin: done === 0 ? 0 : Math.round(minutesWorked / done),
  };
}

/**
 * The counts as a row of chips.
 *
 * Booked always shows, because a technician with nothing on is a fact worth
 * stating. Everything after it appears as the day produces it: services finish,
 * so the minutes and the average arrive at the end rather than sitting at zero
 * all morning telling nobody anything.
 */
export function DayCounts({ rows }: { rows: FloorBooking[] }) {
  const { t } = useAdminI18n();
  const c = countDay(rows);

  const chips: [string, number, string, boolean][] = [
    [t.technicians.booked, c.booked, "text-ink/60", true],
    [t.technicians.done, c.done, "text-[#1f7a4d]", c.done > 0],
    [t.technicians.inService, c.inService, "text-sky", c.inService > 0],
    [t.technicians.noShow, c.noShow, "text-red", c.noShow > 0],
    // The two that only mean something once there is finished work to measure.
    [t.technicians.minutesWorked, c.minutesWorked, "text-ink/45", c.done > 0],
    [t.technicians.avgEach, c.avgMin, "text-ink/45", c.done > 1],
  ];

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
      {chips
        .filter(([, , , show]) => show)
        .map(([label, n, tone]) => (
          <span key={label} className={tone}>
            <span className="font-semibold">{n}</span> {label}
          </span>
        ))}
    </span>
  );
}

export default function TechnicianDay({ rows, now }: { rows: FloorBooking[]; now: number }) {
  const { t, lang } = useAdminI18n();

  // Every booking, from the moment it is on the books. Filtering to finished
  // work made a technician with a full afternoon read as an empty day, which is
  // the opposite of what either screen is for — the figures that only matter
  // afterwards are in DayCounts above, and they arrive on their own.
  if (rows.length === 0) {
    return (
      <p className="border-t border-black/[0.06] px-4 py-4 text-start text-xs text-ink/45">
        {t.technicians.noBookings}
      </p>
    );
  }

  return (
    // The row is wide and phones are not. Scrolling it inside its own box beats
    // wrapping every cell, which turns a scannable list into paragraphs.
    <div className="overflow-x-auto border-t border-black/[0.06]">
      <ul className="min-w-[600px] divide-y divide-black/[0.04]">
        {rows.map((b) => {
          // Finished is settled; running counts up off the same `now` the whole
          // screen shares, so nothing here starts its own interval.
          const tookMs =
            b.startedAt && b.finishedAt
              ? new Date(b.finishedAt).getTime() - new Date(b.startedAt).getTime()
              : null;
          const runningMs = b.startedAt && !b.finishedAt ? now - new Date(b.startedAt).getTime() : null;
          // One comparison for both branches: over is over, running or done.
          const over = b.durationMin ? (tookMs ?? runningMs ?? 0) > b.durationMin * 60_000 : false;

          return (
            <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-start">
              <span className="w-12 shrink-0 font-display text-sm font-extrabold text-red">
                {b.ticketNo ?? "—"}
              </span>
              <span className="w-24 shrink-0 text-xs tabular-nums text-ink/50" dir="ltr">
                {localTime(b.startsAt)}–{localTime(b.endsAt)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{b.customerName ?? "—"}</span>
                <span className="block truncate text-xs text-ink/50">
                  {[pick(b.serviceName, lang), b.stationLabel].filter(Boolean).join(" · ")}
                </span>
              </span>
              {/* The number that matters once the service is over. Red when it
                  ran past the duration the service is sold as. */}
              <span className="w-28 shrink-0 text-end text-xs tabular-nums">
                {tookMs !== null ? (
                  <span
                    className={cn("font-semibold", over ? "text-red" : "text-ink/60")}
                  >
                    {t.frontDesk.took} {formatDuration(tookMs, lang)}
                  </span>
                ) : runningMs !== null ? (
                  <span className={cn(over ? "text-red" : "text-sky")}>
                    {formatDuration(runningMs, lang)}
                  </span>
                ) : null}
              </span>
              <Badge tone={STATUS_TONE[b.status]}>{t.bookings.statuses[b.status]}</Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
