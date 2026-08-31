"use client";

// The technician's whole panel (brief §3.2).
//
// One card per booking, one button per card, and the ticket number bigger than
// anything else because confirming it with the customer is the entire point of
// pressing Start. No drawer to open and nothing to filter: a technician has wet
// hands and thirty seconds.
//
// The period tabs at the top change the whole screen, not only her figures.
// "Today" is the board she works from and is always today's bookings — "my day"
// would mean nothing otherwise. Seven and thirty days are a different question,
// "what have I finished", so they render the history list instead: same numbers
// above, a record rather than a board below, and nothing left to press.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardHeader, EmptyState, PageHeader, StatCard, Badge, Thumb } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { formatDuration, localTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { PeriodKey, TechnicianStats } from "@/lib/performance";
import type { MyDayBooking, MyPastService } from "./data";
import { finishService, startService } from "./actions";

function minutesBetween(fromIso: string, to: number): number {
  return Math.max(0, Math.round((to - new Date(fromIso).getTime()) / 60000));
}

/**
 * What she has already finished, newest first, under a heading per day.
 *
 * Grouped rather than flat because thirty days is a few hundred rows, and a
 * technician looking for "that ombré on Tuesday" navigates by day before she
 * navigates by anything else.
 *
 * Read-only by construction: there is no action on a service that is over, and
 * offering one would only raise the question of what it does.
 */
function HistoryList({
  rows,
  lang,
  title,
  empty,
  took,
}: {
  rows: MyPastService[];
  lang: "ar" | "en";
  title: string;
  empty: string;
  took: string;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title={empty} />
      </Card>
    );
  }

  // Already sorted newest-first by the query, so the first time a day appears
  // is where its heading goes — no second sort, and no Map to keep in order.
  const days: { day: string; items: MyPastService[] }[] = [];
  for (const row of rows) {
    const last = days[days.length - 1];
    if (last?.day === row.day) last.items.push(row);
    else days.push({ day: row.day, items: [row] });
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} subtitle={`${rows.length}`} />
      <div>
        {days.map(({ day, items }) => (
          <section key={day}>
            <h3
              className="sticky top-0 border-b border-black/[0.06] bg-cream/95 px-4 py-2 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45 backdrop-blur"
              dir="ltr"
            >
              {day}
            </h3>
            <ul className="divide-y divide-black/[0.04]">
              {items.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3 text-start">
                  <span className="w-12 shrink-0 text-xs tabular-nums text-ink/45" dir="ltr">
                    {localTime(r.startsAt)}
                  </span>
                  <Thumb src={r.imageUrl} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {pick(r.serviceName, lang)}
                    </span>
                    <span className="block truncate text-xs text-ink/50">
                      {[r.designName ? pick(r.designName, lang) : null, r.customerName]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-end">
                    <span className="block text-xs font-medium tabular-nums text-ink">
                      {took} {formatDuration(r.tookMin * 60_000, lang)}
                    </span>
                    <span className="block text-[11px] text-ink/40">{r.ticketNo ?? "—"}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Card>
  );
}

export default function MyDayView({
  bookings,
  history,
  stats,
  period,
}: {
  bookings: MyDayBooking[];
  /** Populated only for the 7- and 30-day periods; today renders the board. */
  history: MyPastService[];
  /** Null when she has finished nothing in the period — a new hire, or a quiet week. */
  stats: TechnicianStats | null;
  period: PeriodKey;
}) {
  const { t, lang } = useAdminI18n();
  const m = t.myDay;
  const p = t.performance;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One clock for every card, ticking once a minute. A timer per card would be
  // the same number rendered from more setIntervals.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  async function run(id: string, fn: (id: string) => Promise<{ ok: boolean }>) {
    setBusy(id);
    setError(null);
    const res = await fn(id);
    if (!res.ok) setError(m.failed);
    setBusy(null);
  }

  const tabs: [PeriodKey, string][] = [
    ["today", p.periodToday],
    ["7", p.period7],
    ["30", p.period30],
  ];

  return (
    <>
      <PageHeader
        title={m.title}
        subtitle={m.subtitle}
        action={
          <div className="flex gap-1 rounded-xl bg-black/[0.04] p-1">
            {tabs.map(([key, label]) => (
              <Link
                key={key}
                href={`/admin?period=${key}`}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  period === key ? "bg-white text-ink shadow-sm" : "text-ink/55 hover:text-ink",
                )}
              >
                {label}
              </Link>
            ))}
          </div>
        }
      />

      {/* Her own numbers, for the period above. Nobody else's — this is the same
          query the CEO's performance screen runs, narrowed to one technician. */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={p.services} value={stats?.services ?? 0} />
        <StatCard
          label={p.avgService}
          value={stats ? `${stats.avgServiceMin} ${p.minutes}` : "—"}
        />
        <StatCard
          label={p.avgExpected}
          value={
            stats?.avgVsExpectedMin == null
              ? "—"
              : `${Math.abs(stats.avgVsExpectedMin)} ${p.minutes} ${
                  stats.avgVsExpectedMin <= 0 ? p.faster : p.slower
                }`
          }
        />
        <StatCard
          label={m.totalWorked}
          value={stats ? `${stats.totalServiceMin} ${p.minutes}` : "—"}
        />
      </div>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl bg-red/[0.07] px-4 py-3 text-sm text-red">
          {error}
        </p>
      ) : null}

      {/* The tabs above change what this screen *is*, not just its numbers.
          Today is a board she works from, so it keeps the cards with Start and
          Finish on them. Seven and thirty days are a record of work already
          done — there is nothing left to press, so they read as a list. */}
      {period !== "today" ? (
        <HistoryList rows={history} lang={lang} title={m.historyTitle} empty={m.historyEmpty} took={m.took} />
      ) : bookings.length === 0 ? (
        <Card>
          <EmptyState title={m.empty} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {bookings.map((b) => {
            const waiting = b.status === "checked_in";
            const running = b.status === "in_progress" && !b.finishedAt;
            const handedOver = !!b.finishedAt && b.status !== "completed";

            const minutes = b.startedAt
              ? minutesBetween(b.startedAt, b.finishedAt ? new Date(b.finishedAt).getTime() : now)
              : null;

            return (
              <Card
                key={b.id}
                className={cn(
                  "flex flex-col gap-4 p-5",
                  waiting && "ring-2 ring-red/25",
                  running && "ring-2 ring-sky/30",
                )}
              >
                <div className="flex items-start justify-between gap-3 text-start">
                  <div>
                    <p className="text-[11px] font-medium text-ink/50">{m.ticket}</p>
                    <p className="font-display text-4xl font-extrabold leading-none text-red">
                      {b.ticketNo ?? "—"}
                    </p>
                  </div>
                  <div className="text-end">
                    <p className="font-display text-lg font-bold tabular-nums text-ink">
                      {localTime(b.startsAt)}
                    </p>
                    {b.stationLabel ? (
                      <p className="text-xs text-ink/50">
                        {m.station} {b.stationLabel}
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* Picture first, then the words for it. She is looking for the
                    shape she is about to paint, and finds it faster than she
                    reads "Almond — Ombré". The text stays: the image narrows the
                    card down, it does not identify it. */}
                <div className="flex items-start gap-3 text-start text-sm">
                  <Thumb src={b.imageUrl} size="md" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium text-ink">{pick(b.serviceName, lang)}</p>
                    {b.addons.length > 0 ? (
                      <p className="text-xs text-ink/55">
                        {b.addons.map((a) => pick(a, lang)).join(" · ")}
                      </p>
                    ) : null}
                    {b.designName ? (
                      <p className="text-xs text-ink/55">
                        {m.design}: {pick(b.designName, lang)}
                      </p>
                    ) : null}
                    {b.customerName ? (
                      <p className="text-xs text-ink/55">
                        {m.customer}: {b.customerName}
                      </p>
                    ) : null}
                  </div>
                </div>

                {b.notes ? (
                  <p className="rounded-lg bg-black/[0.03] px-2 py-1.5 text-start text-xs text-ink/70">
                    {b.notes}
                  </p>
                ) : null}

                {minutes !== null ? (
                  <p className="text-start text-xs text-ink/55 tabular-nums">
                    {m.elapsed}: <span className="font-semibold text-ink">{minutes}</span>{" "}
                    {t.performance.minutes}
                    {b.durationMin ? (
                      <span className="text-ink/40">
                        {" "}
                        · {m.expected} {b.durationMin}
                      </span>
                    ) : null}
                  </p>
                ) : null}

                {/* Exactly one control, whichever the state calls for. */}
                {waiting ? (
                  <div className="mt-auto space-y-2">
                    <p className="text-start text-xs text-ink/50">{m.confirmTicket}</p>
                    <button
                      onClick={() => run(b.id, startService)}
                      disabled={busy === b.id}
                      className="h-14 w-full rounded-2xl bg-red text-base font-bold text-white transition-colors hover:bg-red-dark disabled:bg-red/50"
                    >
                      {m.start}
                    </button>
                  </div>
                ) : running ? (
                  <button
                    onClick={() => run(b.id, finishService)}
                    disabled={busy === b.id}
                    className="mt-auto h-14 w-full rounded-2xl bg-ink text-base font-bold text-white transition-colors hover:bg-ink/85 disabled:bg-ink/40"
                  >
                    {m.finish}
                  </button>
                ) : handedOver ? (
                  <Badge tone="warning" className="mt-auto self-start">
                    {m.waitingForDesk}
                  </Badge>
                ) : b.status === "completed" ? (
                  <Badge tone="success" className="mt-auto self-start">
                    {m.done}
                  </Badge>
                ) : (
                  <Badge tone="neutral" className="mt-auto self-start">
                    {t.bookings.statuses[b.status as keyof typeof t.bookings.statuses]}
                  </Badge>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
