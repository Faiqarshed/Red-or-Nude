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
import { Dialog } from "@/components/admin/overlays";
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

  const [openId, setOpenId] = useState<string | null>(null);

  // Three groups, and the order is the order she works in. `hero` is whatever
  // is in front of her: the service already running if there is one, otherwise
  // the next that has not been done. A grid of equal cards made her read all
  // seven to find that out.
  const live = bookings.filter((b) => b.status !== "completed" && !b.finishedAt);
  const hero = live.find((b) => b.status === "in_progress") ?? live[0] ?? null;
  const later = live.filter((b) => b.id !== hero?.id);
  const done = bookings.filter((b) => b.status === "completed" || !!b.finishedAt);
  const open = bookings.find((b) => b.id === openId) ?? null;

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
        <div className="flex flex-col gap-7">
          {/* One card is bigger than the others because one of them is next.
              A grid of equal cards makes her read all seven to find it. */}
          {hero ? (
            <section>
              <SectionLabel>{m.nextUp}</SectionLabel>
              <NextCard
                b={hero}
                now={now}
                busy={busy === hero.id}
                m={m}
                p={p}
                statuses={t.bookings.statuses}
                lang={lang}
                onOpen={() => setOpenId(hero.id)}
                onStart={() => run(hero.id, startService)}
                onFinish={() => run(hero.id, finishService)}
              />
            </section>
          ) : null}

          {later.length > 0 ? (
            <section>
              <SectionLabel>{m.laterToday}</SectionLabel>
              <div className="flex flex-col gap-2.5">
                {later.map((b) => (
                  <LaterRow key={b.id} b={b} m={m} lang={lang} onOpen={() => setOpenId(b.id)} />
                ))}
              </div>
            </section>
          ) : null}

          {done.length > 0 ? (
            <section>
              <SectionLabel>{m.finishedCount(done.length)}</SectionLabel>
              <div className="flex flex-wrap gap-2.5">
                {done.map((b) => (
                  <DoneChip key={b.id} b={b} m={m} p={p} lang={lang} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      {/* The picture at a size she can work from. Everything on it is already
          on the card behind — this dialog adds no facts, only room. */}
      <DetailDialog
        b={open}
        now={now}
        busy={!!open && busy === open.id}
        m={m}
        p={p}
        lang={lang}
        onClose={() => setOpenId(null)}
        onStart={() => open && run(open.id, startService)}
        onFinish={() => open && run(open.id, finishService)}
      />
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2.5 text-start text-[11px] font-bold uppercase tracking-wider text-ink/40">
      {children}
    </p>
  );
}

type Copy = ReturnType<typeof useAdminI18n>["t"];

/** Which single control this booking is asking for, if any. */
function controlFor(b: MyDayBooking): "start" | "finish" | "handedOver" | "done" | null {
  if (b.status === "checked_in") return "start";
  if (b.status === "in_progress" && !b.finishedAt) return "finish";
  if (b.finishedAt && b.status !== "completed") return "handedOver";
  if (b.status === "completed") return "done";
  return null;
}

/** Minutes on her own clock: Start to Finish, or Start to now. */
function elapsed(b: MyDayBooking, now: number): number | null {
  if (!b.startedAt) return null;
  return minutesBetween(b.startedAt, b.finishedAt ? new Date(b.finishedAt).getTime() : now);
}

function NextCard({
  b,
  now,
  busy,
  m,
  p,
  statuses,
  lang,
  onOpen,
  onStart,
  onFinish,
}: {
  b: MyDayBooking;
  now: number;
  busy: boolean;
  m: Copy["myDay"];
  p: Copy["performance"];
  statuses: Copy["bookings"]["statuses"];
  lang: "ar" | "en";
  onOpen: () => void;
  onStart: () => void;
  onFinish: () => void;
}) {
  const control = controlFor(b);
  const min = elapsed(b, now);
  const startsInMin = Math.round((new Date(b.startsAt).getTime() - now) / 60_000);

  return (
    <Card
      className={cn(
        "flex flex-col gap-5 p-5 sm:flex-row sm:items-start",
        control === "start" && "border-red/25 shadow-[0_6px_22px_rgba(184,0,7,0.08)]",
        control === "finish" && "border-sky/40",
      )}
    >
      <button type="button" onClick={onOpen} className="shrink-0 self-center sm:self-start">
        <Thumb src={b.imageUrl} size="xl" />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-3 text-start">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded-full bg-red/10 px-3 py-1 text-sm font-bold tabular-nums text-red">
            {localTime(b.startsAt)}
          </span>
          <span className="text-xs tabular-nums text-ink/50">
            {control === "start" && startsInMin > 0
              ? m.startsIn(startsInMin)
              : control === "start"
                ? m.startsNow
                : null}
            {b.stationLabel ? ` ${m.station} ${b.stationLabel}` : ""}
          </span>
          <span className="ms-auto text-[11px] font-medium text-ink/45">
            {m.ticket} {b.ticketNo ?? "—"}
          </span>
        </div>

        <div>
          <h2 className="font-display text-xl font-bold text-ink">{pick(b.serviceName, lang)}</h2>
          {b.designName ? (
            <p className="mt-1 text-sm text-ink/60">{pick(b.designName, lang)}</p>
          ) : null}
        </div>

        {b.addons.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {b.addons.map((a, i) => (
              <span key={i} className="rounded-full bg-black/[0.05] px-3 py-1 text-xs text-ink/70">
                {pick(a, lang)}
              </span>
            ))}
          </div>
        ) : null}

        {b.customerName ? (
          <p className="text-sm text-ink/70">
            {m.customer}: <span className="font-medium text-ink">{b.customerName}</span>
          </p>
        ) : null}

        {b.notes ? (
          <p className="rounded-xl bg-[#b7791f]/[0.10] px-3 py-2.5 text-sm leading-relaxed text-[#8a5a06]">
            {b.notes}
          </p>
        ) : null}

        {min !== null ? (
          <p className="text-sm tabular-nums text-ink/55">
            {m.elapsed}: <span className="font-semibold text-ink">{min}</span> {p.minutes}
            {b.durationMin ? (
              <span className="text-ink/40">
                {" "}
                · {m.expected} {b.durationMin}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 sm:w-44">
        {control === "start" ? (
          <button
            onClick={onStart}
            disabled={busy}
            className="h-14 w-full rounded-2xl bg-red text-base font-bold text-white transition-colors hover:bg-red-dark disabled:bg-red/50"
          >
            {m.start}
          </button>
        ) : control === "finish" ? (
          <button
            onClick={onFinish}
            disabled={busy}
            className="h-14 w-full rounded-2xl bg-ink text-base font-bold text-white transition-colors hover:bg-ink/85 disabled:bg-ink/40"
          >
            {m.finish}
          </button>
        ) : control === "handedOver" ? (
          <Badge tone="warning">{m.waitingForDesk}</Badge>
        ) : control === "done" ? (
          <Badge tone="success">{m.done}</Badge>
        ) : (
          <Badge tone="neutral">{statuses[b.status as keyof typeof statuses]}</Badge>
        )}

        <button
          onClick={onOpen}
          className="h-11 w-full rounded-xl border border-black/10 bg-white text-sm font-medium text-ink/70 transition-colors hover:bg-black/[0.03]"
        >
          {m.openDetail}
        </button>
      </div>
    </Card>
  );
}

/** Everything after the next one: enough to recognise, not enough to act on. */
function LaterRow({
  b,
  m,
  lang,
  onOpen,
}: {
  b: MyDayBooking;
  m: Copy["myDay"];
  lang: "ar" | "en";
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="w-full text-start">
      <Card className="flex items-center gap-4 p-3.5 transition-colors hover:border-red/25">
        <span className="w-14 shrink-0 text-sm font-semibold tabular-nums text-ink">
          {localTime(b.startsAt)}
        </span>
        <Thumb src={b.imageUrl} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">
            {pick(b.serviceName, lang)}
          </span>
          <span className="block truncate text-[13px] text-ink/55">
            {[b.customerName, b.stationLabel ? `${m.station} ${b.stationLabel}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {b.durationMin ? (
          <span className="shrink-0 text-xs tabular-nums text-ink/45">{b.durationMin}</span>
        ) : null}
      </Card>
    </button>
  );
}

/** Done, and out of the way. A chip, because there is nothing left to press. */
function DoneChip({
  b,
  m,
  p,
  lang,
}: {
  b: MyDayBooking;
  m: Copy["myDay"];
  p: Copy["performance"];
  lang: "ar" | "en";
}) {
  const took =
    b.startedAt && b.finishedAt
      ? minutesBetween(b.startedAt, new Date(b.finishedAt).getTime())
      : null;

  return (
    <span className="inline-flex items-center gap-2.5 rounded-2xl border border-black/[0.06] bg-white/60 p-2 pe-3.5 text-start text-[13px] tabular-nums text-ink/55">
      <Thumb src={b.imageUrl} size="sm" className="h-7 w-7 rounded-lg" />
      {localTime(b.startsAt)} {pick(b.serviceName, lang)}
      {took !== null ? ` · ${m.took} ${took} ${p.minutes}` : ""}
    </span>
  );
}

/** The design, big, with the facts beside it and the one control underneath. */
function DetailDialog({
  b,
  now,
  busy,
  m,
  p,
  lang,
  onClose,
  onStart,
  onFinish,
}: {
  b: MyDayBooking | null;
  now: number;
  busy: boolean;
  m: Copy["myDay"];
  p: Copy["performance"];
  lang: "ar" | "en";
  onClose: () => void;
  onStart: () => void;
  onFinish: () => void;
}) {
  if (!b) return null;

  const control = controlFor(b);
  const min = elapsed(b, now);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${localTime(b.startsAt)} · ${pick(b.serviceName, lang)}`}
      className="max-w-2xl"
      footer={
        control === "start" ? (
          <button
            onClick={onStart}
            disabled={busy}
            className="h-12 w-full rounded-xl bg-red text-base font-bold text-white transition-colors hover:bg-red-dark disabled:bg-red/50"
          >
            {m.start}
          </button>
        ) : control === "finish" ? (
          <button
            onClick={onFinish}
            disabled={busy}
            className="h-12 w-full rounded-xl bg-ink text-base font-bold text-white transition-colors hover:bg-ink/85 disabled:bg-ink/40"
          >
            {m.finish}
          </button>
        ) : null
      }
    >
      <div className="flex flex-col gap-4 text-start">
        <Thumb src={b.imageUrl} size="hero" />

        {b.designName ? (
          <p className="text-sm text-ink/60">
            {m.design}: <span className="font-medium text-ink">{pick(b.designName, lang)}</span>
          </p>
        ) : null}

        {b.addons.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {b.addons.map((a, i) => (
              <span key={i} className="rounded-full bg-black/[0.05] px-3 py-1 text-xs text-ink/70">
                {pick(a, lang)}
              </span>
            ))}
          </div>
        ) : null}

        <div className="grid gap-2 rounded-xl bg-white p-4 text-sm sm:grid-cols-2">
          <p className="text-ink/55">
            {m.ticket}: <span className="font-medium tabular-nums text-ink">{b.ticketNo ?? "—"}</span>
          </p>
          {b.stationLabel ? (
            <p className="text-ink/55">
              {m.station}: <span className="font-medium text-ink">{b.stationLabel}</span>
            </p>
          ) : null}
          {b.customerName ? (
            <p className="text-ink/55">
              {m.customer}: <span className="font-medium text-ink">{b.customerName}</span>
            </p>
          ) : null}
          {min !== null ? (
            <p className="tabular-nums text-ink/55">
              {m.elapsed}: <span className="font-medium text-ink">{min}</span> {p.minutes}
            </p>
          ) : null}
        </div>

        {b.notes ? (
          <p className="rounded-xl bg-[#b7791f]/[0.10] px-4 py-3 text-sm leading-relaxed text-[#8a5a06]">
            {b.notes}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
