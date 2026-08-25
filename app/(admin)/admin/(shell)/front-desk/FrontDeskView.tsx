"use client";

// The receptionist's whole panel (brief §3.1).
//
// Three bands, top to bottom: today's numbers, the ticket box, the floor. The
// ticket box is autofocused and takes enter, because the customer is standing
// there and the answer to "what's your ticket number?" should need one hand.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState, PageHeader, StatCard, Badge, Button } from "@/components/admin/ui";
import { STATUS_TONE, type BookingStatus } from "../bookings/BookingsView";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { UTC_OFFSET_HOURS } from "@/lib/time";
import { cn } from "@/lib/cn";
import type { FrontDeskData, FrontDeskRow, TechnicianOption } from "./data";
import { assignTechnician, checkInTicket, closeTicket, findTicket, type TicketMatch } from "./actions";

function localTime(iso: string): string {
  return new Date(new Date(iso).getTime() + UTC_OFFSET_HOURS * 3600_000)
    .toISOString()
    .slice(11, 16);
}

/** The technician has pressed Done and the ticket is still open. */
function readyToClose(r: FrontDeskRow): boolean {
  return !!r.finishedAt && r.status !== "completed";
}

export default function FrontDeskView({
  data,
  branchId,
}: {
  data: FrontDeskData;
  branchId: string;
}) {
  const { t, lang } = useAdminI18n();
  const f = t.frontDesk;
  const router = useRouter();

  const [ticket, setTicket] = useState("");
  const [match, setMatch] = useState<TicketMatch | null>(null);
  const [chosenTech, setChosenTech] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());

  // Two jobs, one interval. A technician pressing Done elsewhere in the salon
  // has to show up here without anyone reloading — the page is force-dynamic,
  // so a refresh is the whole mechanism. And `now` has to move, or a customer
  // found at 13:59 for a 14:00 slot would sit behind a disabled button until
  // someone thought to search again.
  //
  // ponytail: polling, not push. 20 seconds is well inside "she's still drying
  // her hands"; swap in a websocket only if that ever stops being true.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, 20_000);
    return () => clearInterval(id);
  }, [router]);

  /** Server-side is the rule; this only decides what the desk is shown. */
  const tooEarly = (booking: TicketMatch) =>
    now < new Date(booking.checkInOpensAt).getTime();

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setMatch(null);
    setChosenTech("");
    if (!ticket.trim()) return;

    setBusy(true);
    const res = await findTicket(branchId, ticket);
    setBusy(false);

    if (!res.ok) {
      setError(f.notFound);
      return;
    }
    if (res.booking.status === "checked_in" || res.booking.status === "in_progress") {
      setError(f.alreadyIn);
      setMatch(res.booking);
      return;
    }
    if (res.booking.status !== "confirmed") {
      setError(f.notCheckable);
      setMatch(res.booking);
      return;
    }
    // She is here before her slot. Shown rather than hidden, with the time she
    // can be checked in, so the receptionist can tell her something useful.
    if (tooEarly(res.booking)) {
      setError(`${f.tooEarly} ${localTime(res.booking.checkInOpensAt)}`);
    }
    setMatch(res.booking);
  }

  async function doCheckIn() {
    if (!match) return;
    setBusy(true);
    setError(null);
    const res = await checkInTicket(match.id, chosenTech || null);
    setBusy(false);

    if (!res.ok) {
      setError(
        res.error === "already-checked-in"
          ? f.alreadyIn
          : res.error === "too-early"
            ? `${f.tooEarly} ${localTime(match.checkInOpensAt)}`
            : f.failed,
      );
      return;
    }
    // Cleared, focused, ready for the next customer. Nobody should have to
    // reach for the mouse between two people in a queue.
    setMatch(null);
    setTicket("");
    inputRef.current?.focus();
    router.refresh();
  }

  async function doClose(id: string) {
    setBusy(true);
    const res = await closeTicket(id);
    setBusy(false);
    if (!res.ok) setError(f.failed);
    router.refresh();
  }

  async function doReassign(id: string, technicianId: string) {
    if (!technicianId) return;
    setBusy(true);
    const res = await assignTechnician(id, technicianId);
    setBusy(false);
    if (!res.ok) setError(f.failed);
    router.refresh();
  }

  // Ready-to-close first: it is the only row that needs a decision from her.
  const rows = [...data.rows].sort((a, b) => {
    const diff = Number(readyToClose(b)) - Number(readyToClose(a));
    return diff !== 0 ? diff : a.startsAt.localeCompare(b.startsAt);
  });

  return (
    <>
      <PageHeader title={f.title} subtitle={f.subtitle} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={f.statCompleted} value={data.stats.finished} />
        <StatCard label={f.statInService} value={data.stats.inService} />
        <StatCard label={f.statWaiting} value={data.stats.waiting} />
        <StatCard label={f.statUpcoming} value={data.stats.upcoming} />
      </div>

      <Card className="mb-6 p-5">
        <form onSubmit={search} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1 text-start">
            <label htmlFor="ticket" className="mb-1.5 block text-xs font-medium text-ink/60">
              {f.ticketLabel}
            </label>
            <input
              id="ticket"
              ref={inputRef}
              autoFocus
              autoComplete="off"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder={f.ticketPlaceholder}
              className="h-16 w-full rounded-2xl border border-black/10 bg-white px-4 text-center font-display text-3xl font-extrabold uppercase tracking-wider text-ink outline-none focus:border-sky focus:ring-2 focus:ring-sky/20"
            />
          </div>
          <Button type="submit" disabled={busy} className="h-16 px-8 text-base">
            {f.search}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="mt-3 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-sm text-red">
            {error}
          </p>
        ) : null}

        {match && match.status === "confirmed" ? (
          <div className="mt-4 rounded-2xl border border-black/10 bg-cream/60 p-4 text-start">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-display text-lg font-bold text-ink">
                  {match.customerName ?? "—"}
                </p>
                <p className="text-sm text-ink/60">
                  {pick(match.serviceName, lang)} · {localTime(match.startsAt)}
                </p>
              </div>
              <Badge tone="info">{match.ticketNo}</Badge>
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="min-w-[180px] flex-1">
                <label htmlFor="tech" className="mb-1.5 block text-xs font-medium text-ink/60">
                  {f.technician}
                </label>
                <TechSelect
                  id="tech"
                  value={chosenTech}
                  onChange={setChosenTech}
                  options={data.technicians}
                  autoLabel={f.autoAssigned}
                />
              </div>
              <Button
                onClick={doCheckIn}
                disabled={busy || tooEarly(match)}
                className="h-12 px-8 text-base"
              >
                {f.checkIn}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title={f.today} />
        ) : (
          <ul className="divide-y divide-black/[0.06]">
            {rows.map((r) => {
              const ready = readyToClose(r);
              return (
                <li
                  key={r.id}
                  className={cn(
                    "flex flex-wrap items-center gap-3 px-4 py-3 text-start",
                    ready && "bg-[#fdf0dc]",
                  )}
                >
                  <span className="w-14 shrink-0 font-display text-lg font-extrabold text-red">
                    {r.ticketNo ?? "—"}
                  </span>
                  <span className="w-12 shrink-0 text-xs tabular-nums text-ink/50">
                    {localTime(r.startsAt)}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {r.customerName ?? "—"}
                    </span>
                    <span className="block truncate text-xs text-ink/50">
                      {pick(r.serviceName, lang)}
                      {r.stationLabel ? ` · ${r.stationLabel}` : ""}
                    </span>
                  </span>

                  {r.status === "checked_in" || r.status === "in_progress" ? (
                    <TechSelect
                      value={r.technicianId ?? ""}
                      onChange={(v) => doReassign(r.id, v)}
                      options={data.technicians}
                      autoLabel={f.noneFree}
                      className="w-36"
                    />
                  ) : (
                    <span className="w-36 shrink-0 truncate text-xs text-ink/50">
                      {r.technicianName ?? ""}
                    </span>
                  )}

                  {ready ? (
                    <Button size="sm" onClick={() => doClose(r.id)} disabled={busy}>
                      {f.close}
                    </Button>
                  ) : (
                    <Badge tone={STATUS_TONE[r.status as BookingStatus] ?? "neutral"}>
                      {t.bookings.statuses[r.status as keyof typeof t.bookings.statuses]}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

function TechSelect({
  id,
  value,
  onChange,
  options,
  autoLabel,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: TechnicianOption[];
  autoLabel: string;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-12 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink outline-none focus:border-sky focus:ring-2 focus:ring-sky/20",
        className,
      )}
    >
      <option value="">{autoLabel}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
