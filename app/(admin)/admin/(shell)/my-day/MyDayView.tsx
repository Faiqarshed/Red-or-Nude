"use client";

// The technician's whole panel (brief §3.2).
//
// One card per booking, one button per card, and the ticket number bigger than
// anything else because confirming it with the customer is the entire point of
// pressing Start. No drawer to open and nothing to filter: a technician has wet
// hands and thirty seconds.
//
// The period tabs at the top change only her own figures, never the cards. The
// cards are always today — "my day" would mean nothing otherwise.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, EmptyState, PageHeader, StatCard, Badge } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { UTC_OFFSET_HOURS } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { PeriodKey, TechnicianStats } from "@/lib/performance";
import type { MyDayBooking } from "./data";
import { finishService, startService } from "./actions";

/** Riyadh wall clock, HH:MM. */
function localTime(iso: string): string {
  return new Date(new Date(iso).getTime() + UTC_OFFSET_HOURS * 3600_000)
    .toISOString()
    .slice(11, 16);
}

function minutesBetween(fromIso: string, to: number): number {
  return Math.max(0, Math.round((to - new Date(fromIso).getTime()) / 60000));
}

export default function MyDayView({
  bookings,
  stats,
  period,
}: {
  bookings: MyDayBooking[];
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

      {bookings.length === 0 ? (
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

                <div className="space-y-1 text-start text-sm">
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
                  {b.notes ? (
                    <p className="rounded-lg bg-black/[0.03] px-2 py-1.5 text-xs text-ink/70">
                      {b.notes}
                    </p>
                  ) : null}
                </div>

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
