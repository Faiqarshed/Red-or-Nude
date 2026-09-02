"use client";

// The receptionist's whole panel (brief §3.1).
//
// Three bands, top to bottom: today's numbers, the ticket box, the floor. The
// ticket box is autofocused and takes enter, because the customer is standing
// there and the answer to "what's your ticket number?" should need one hand.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Users } from "lucide-react";
import { Card, EmptyState, PageHeader, Badge, BranchFilter, Button, Thumb } from "@/components/admin/ui";
import { STATUS_TONE } from "../bookings/BookingsView";
import BookingDrawer, { BookingFacts } from "../bookings/BookingDrawer";
import { serviceClock } from "@/lib/booking-clock";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { formatCountdown, formatDuration, localTime } from "@/lib/time";
import { cn } from "@/lib/cn";
import { busyDuring } from "@/lib/slots";
import type { Localized } from "@/lib/db/schema";
import type { FrontDeskData, FrontDeskRow, TechnicianOption } from "./data";
import {
  assignTechnician,
  checkInTicket,
  closeTicket,
  findTicket,
  type TicketMatch,
} from "./actions";

/** The technician has pressed Done and the ticket is still open. */
function readyToClose(r: FrontDeskRow): boolean {
  return !!r.finishedAt && r.status !== "completed";
}

/** How far ahead the desk is actually preparing. */
const ARRIVING_WINDOW_MS = 30 * 60_000;

type Lane = "arriving" | "late" | "service" | "ready";

/**
 * Which lane a row belongs in, or null for the rest of the day.
 *
 * The lanes are the receptionist's next four actions in the order she takes
 * them, not a breakdown of statuses — she is standing up, glancing between
 * customers, and "who do I deal with next" is the only question the top of this
 * screen should answer. Everything already settled — cancelled, no-show, a
 * closed ticket, an appointment at six — is in no lane on purpose: that is the
 * day's record, and the record is the list underneath.
 *
 * `graceMin` is `no_show_grace_min`, and it is here because this lane used to
 * disagree with the rule it was displaying. Past the grace the salon has
 * released the chair and the customer is a no-show, not a late arrival — so a
 * two-hour-old booking sat in Late behind a Check in button that would refuse
 * it. The sweep in loadFrontDesk settles it on the server; this keeps the lane
 * honest in the twenty seconds between two refreshes.
 */
function laneOf(r: FrontDeskRow, now: number, graceMin: number): Lane | null {
  if (readyToClose(r)) return "ready";
  if (r.status === "checked_in" || r.status === "in_progress") return "service";
  if (r.status !== "confirmed") return null;

  const starts = new Date(r.startsAt).getTime();
  if (starts < now) return now - starts <= graceMin * 60_000 ? "late" : null;
  return starts - now <= ARRIVING_WINDOW_MS ? "arriving" : null;
}

const LANE_STYLE = {
  arriving: { dot: "bg-[#b7791f]", head: "bg-[#b7791f]/[0.08]", text: "text-[#8a5a06]", card: "" },
  late: { dot: "bg-red", head: "bg-red/[0.06]", text: "text-red", card: "border-red/25" },
  service: { dot: "bg-sky", head: "bg-sky/10", text: "text-[#2c6a88]", card: "" },
  ready: { dot: "bg-[#1f7a4d]", head: "bg-[#1f7a4d]/[0.08]", text: "text-[#1f7a4d]", card: "border-[#1f7a4d]/25" },
} as const;

/**
 * Whose technician can no longer be changed, and why.
 *
 * Two different reasons, kept apart because the desk needs different things from
 * them:
 *
 * - **done** — she pressed Finish, so the row is now a record of who did the
 *   work. Reassigning would move a completed service onto someone who never
 *   touched it, and /admin/performance reads its timings per technician from
 *   exactly these rows. Keyed on `finishedAt` rather than the status, because
 *   those part company on purpose: the technician finishes, and the ticket stays
 *   open until reception closes it.
 * - **no-show** — nobody came. There is no work to give anybody, and the answer
 *   is a new appointment rather than a different technician, so the message says
 *   so instead of leaving the desk to guess.
 *
 * Null means the row is still editable.
 */
function techLockReason(r: FrontDeskRow): "done" | "no-show" | null {
  if (r.status === "no_show") return "no-show";
  if (r.finishedAt || r.status === "completed" || r.status === "cancelled") return "done";
  return null;
}

export default function FrontDeskView({
  data,
  branchId,
  branchOptions = [],
  canSetStatus,
  canReschedule,
}: {
  data: FrontDeskData;
  branchId: string;
  /** Empty for anyone pinned. A desk is one place, so there is no "all". */
  branchOptions?: { id: string; name: Localized }[];
  /** What the drawer may offer beyond reading. */
  canSetStatus: boolean;
  canReschedule: boolean;
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
  /** The booking whose detail drawer is open, if any. */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Whether the search result has its full detail unfolded. */
  const [showFacts, setShowFacts] = useState(false);

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

  /** How long the desk still has to wait, worded for whoever is reading. */
  const opensIn = (booking: TicketMatch) =>
    formatCountdown(new Date(booking.checkInOpensAt).getTime() - now, lang);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setMatch(null);
    setChosenTech("");
    setShowFacts(false);
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
    // No setError for "she's early" any more. That froze a countdown into state
    // at the moment of the search, so a desk that waited would still be reading
    // "in 24 minutes" twenty-four minutes later. It is derived below instead,
    // off the same `now` that ticks the button, and stays true on its own.
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
            ? `${f.tooEarly} ${localTime(match.checkInOpensAt)} · ${opensIn(match)}`
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

  /**
   * Check in from a lane, without going through the ticket box.
   *
   * The same server action the ticket box calls, so the same rules apply — the
   * "not before her slot" window included. No button is disabled ahead of it:
   * the server owns that rule, and a refusal here is a sentence she can read
   * rather than a control that silently does nothing.
   */
  async function doCheckInRow(id: string) {
    setBusy(true);
    setError(null);
    const res = await checkInTicket(id);
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error === "already-checked-in"
          ? f.alreadyIn
          : res.error === "too-early"
            ? f.notCheckable
            : f.failed,
      );
    }
    router.refresh();
  }

  async function doClose(id: string) {
    setBusy(true);
    const res = await closeTicket(id);
    setBusy(false);
    if (!res.ok) setError(f.failed);
    router.refresh();
  }

  // Only ever *to* somebody. Clearing a technician is not on offer here: an
  // empty technician is how the screen says "this booking arrived after the
  // morning run", and a receptionist emptying one by hand would forge that
  // signal.
  async function doReassign(id: string, technicianId: string) {
    if (!technicianId) return;
    setBusy(true);
    const res = await assignTechnician(id, technicianId);
    setBusy(false);
    // "Already finished" is the one a person can make sense of: she finished
    // between this page's last refresh and the click. Saying so beats "try
    // again", which invites exactly the retry that will fail the same way.
    if (!res.ok) {
      setError(
        res.error === "no-show"
          ? f.techNoShow
          : res.error === "already-finished"
            ? f.techLocked
            : f.failed,
      );
    }
    router.refresh();
  }

  // The found ticket is one of today's rows, which is where its hours live —
  // TicketMatch carries the start but not the end.
  const matchRow = match ? (data.rows.find((r) => r.id === match.id) ?? null) : null;

  // Split the day into the four lanes and the remainder. Chronological within
  // each: the lane already says how urgent it is, so ordering by anything else
  // inside one would be a second, quieter opinion about the same thing.
  const byLane: Record<Lane, FrontDeskRow[]> = { arriving: [], late: [], service: [], ready: [] };
  const rest: FrontDeskRow[] = [];
  for (const r of [...data.rows].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const lane = laneOf(r, now, data.graceMin);
    if (lane) byLane[lane].push(r);
    else rest.push(r);
  }

  const open = data.rows.find((r) => r.id === openId) ?? null;

  return (
    <>
      <PageHeader
        title={f.title}
        subtitle={f.subtitle}
        action={
          <BranchFilter
            branchId={branchId}
            options={branchOptions}
            allLabel={t.topbar.allBranches}
            lang={lang}
            allowAll={false}
            onChange={(id) =>
              router.push(id ? `/admin/front-desk?branch=${id}` : "/admin/front-desk")
            }
          />
        }
      />

      {/* The four lanes, before the ticket box: what is in front of her beats
          what she might look up. Counts live on the lane headings rather than
          in a row of tiles above them — the same four numbers, said once. */}
      <div className="mb-6 grid gap-4 xl:grid-cols-2">
        {(["arriving", "late", "service", "ready"] as const).map((lane) => (
          <LaneCard
            key={lane}
            lane={lane}
            title={
              lane === "arriving"
                ? f.laneArriving
                : lane === "late"
                  ? f.laneLate
                  : lane === "service"
                    ? f.laneInService
                    : f.laneReady
            }
            rows={byLane[lane]}
            empty={f.laneEmpty}
          >
            {(r) => (
              <LaneRow
                r={r}
                lane={lane}
                now={now}
                graceMin={data.graceMin}
                f={f}
                lang={lang}
                busy={busy}
                onOpen={() => setOpenId(r.id)}
                onCheckIn={() => doCheckInRow(r.id)}
                onClose={() => doClose(r.id)}
              />
            )}
          </LaneCard>
        ))}
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

        {/* Rendered for any booking that was found, not only a checkable one.
            The desk asks this box questions it cannot check anyone in for —
            "where is she meant to be sitting", "who has her" — and answering
            those with nothing but an error was the whole complaint. The check-in
            controls below are what stay conditional. */}
        {match && matchRow ? (
          <div className="mt-4 rounded-2xl border border-black/10 bg-cream/60 p-3 text-start">
            {/* One line, not three blocks. Chair and technician are the two
                things said out loud across the counter, so they sit on the same
                row as the name rather than in tiles below it — the whole panel
                has to fit above the fold with the Check in button, or the desk
                scrolls with somebody standing there.

                From the day's rows rather than the ticket lookup: findTicket is
                scoped to today at this branch, which is the same set, so all of
                this comes free instead of widening TicketMatch. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Thumb src={matchRow.imageUrl} size="sm" />
              <div className="min-w-0">
                <p className="truncate font-display text-base font-bold text-ink">
                  {matchRow.customerName ?? "—"}
                </p>
                <p className="truncate text-xs text-ink/55">
                  {pick(matchRow.serviceName, lang)} · {localTime(matchRow.startsAt)}
                </p>
              </div>

              <span className="ms-auto flex flex-wrap items-center gap-x-4 gap-y-1">
                <HeadFact label={t.bookings.station} value={matchRow.stationLabel} />
                <HeadFact
                  label={f.technician}
                  value={matchRow.technicianName}
                  fallback={f.unassignedShort}
                />
                <Badge tone="info">{matchRow.ticketNo}</Badge>
              </span>
            </div>

            {/* One reference, two guests. The desk finds this out here or she
                finds it out from the customer standing in front of her asking
                where her friend's appointment went. Each is still checked in on
                her own — they may be with different technicians. */}
            {match.party.length > 0 ? (
              <div className="mt-3 rounded-xl border border-sky/40 bg-sky/[0.07] px-3 py-2.5 text-start">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-[#2c6a88]">
                  <Users className="h-3.5 w-3.5" strokeWidth={2} />
                  {f.partyWith}
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {match.party.map((p) => (
                    <li key={p.id} className="text-sm text-ink">
                      {p.name ?? "—"}
                      {p.ticketNo ? (
                        <span className="ms-2 text-xs tabular-nums text-ink/45" dir="ltr">
                          {p.ticketNo}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-ink/50">{f.partyHint}</p>
              </div>
            ) : null}

            {/* Derived, not stored — see the note in search(). Re-rendered every
                20s with `now`, so the number counts down on its own. */}
            {matchRow.status === "confirmed" && tooEarly(match) ? (
              <p className="mt-2 rounded-xl bg-[#b7791f]/12 px-3 py-1.5 text-start text-xs text-[#8a5a06]">
                {f.tooEarly} <span dir="ltr">{localTime(match.checkInOpensAt)}</span> ·{" "}
                {opensIn(match)}
              </p>
            ) : null}

            {matchRow.status === "confirmed" ? (
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <div className="min-w-[180px] flex-1">
                  <label htmlFor="tech" className="mb-1.5 block text-xs font-medium text-ink/60">
                    {f.changeTech}
                  </label>
                  <TechSelect
                    id="tech"
                    value={chosenTech}
                    onChange={setChosenTech}
                    options={data.technicians}
                    busyIds={busyDuring(data.rows, matchRow)}
                    // The empty option is a real choice here: it means "leave it
                    // to check-in", which is what happens for a walk-in. It names
                    // whoever already has the booking, because "Assigned
                    // automatically" on a row that was assigned this morning
                    // reads as though nobody has it.
                    emptyLabel={
                      matchRow.technicianName
                        ? `${f.autoAssigned} (${matchRow.technicianName})`
                        : f.autoAssigned
                    }
                    allowEmpty
                  />
                </div>
                <Button
                  onClick={doCheckIn}
                  disabled={busy || tooEarly(match)}
                  className="h-12 px-8 text-base"
                >
                  {/* The wait goes on the button, not only in the notice above:
                      this is what the receptionist is looking at when she
                      wonders why she cannot press it. */}
                  {tooEarly(match) ? `${f.checkIn} · ${opensIn(match)}` : f.checkIn}
                </Button>
              </div>
            ) : null}

            {/* The rest of the booking — code, phone, add-ons, total, timings —
                one click away rather than always on screen. Folded by default
                because none of it is what the desk reads while checking someone
                in, and unfolded it pushed the button below the fold. Same block
                the drawer shows, so the two can never disagree. */}
            <button
              type="button"
              onClick={() => setShowFacts((v) => !v)}
              aria-expanded={showFacts}
              className="mt-3 flex items-center gap-1 text-xs font-medium text-ink/50 hover:text-ink"
            >
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", showFacts && "rotate-180")}
                strokeWidth={2}
              />
              {f.detailTitle}
            </button>

            {showFacts ? (
              <div className="mt-2">
                <BookingFacts booking={matchRow} now={now} />
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="border-b border-black/[0.06] px-4 py-3">
          <p className="text-sm font-semibold text-ink">{f.today}</p>
        </div>

        {rest.length === 0 ? (
          <EmptyState title={t.common.none} />
        ) : (
          <ul className="divide-y divide-black/[0.06]">
            {rest.map((r) => {
              const ready = readyToClose(r);
              const lockReason = techLockReason(r);
              const { runningMs, tookMs } = serviceClock(r, now);
              const clockMs = runningMs ?? tookMs;
              return (
                <li
                  key={r.id}
                  className={cn(
                    "flex flex-wrap items-center gap-3 px-4 py-3 text-start",
                    ready && "bg-[#fdf0dc]",
                  )}
                >
                  {/* A button rather than a click on the whole row: the
                      technician picker and the Close button live on the same
                      line, and a row-wide handler would fire underneath them.
                      Same split the customer's own booking card uses. */}
                  <button
                    type="button"
                    onClick={() => setOpenId(r.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-start"
                  >
                    <span className="w-14 shrink-0 font-display text-lg font-extrabold text-red">
                      {r.ticketNo ?? "—"}
                    </span>
                    <span className="w-12 shrink-0 text-xs tabular-nums text-ink/50">
                      {localTime(r.startsAt)}
                    </span>

                    <Thumb src={r.imageUrl} size="sm" />

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {r.customerName ?? "—"}
                      </span>
                      <span className="block truncate text-xs text-ink/50">
                        {pick(r.serviceName, lang)}
                        {r.stationLabel ? ` · ${r.stationLabel}` : ""}
                      </span>

                      {/* How long she has been here — see lib/booking-clock.ts. */}
                      {clockMs !== null ? (
                        <span
                          className={cn(
                            "mt-0.5 block text-[11px] tabular-nums",
                            runningMs !== null ? "text-sky" : "text-ink/45",
                          )}
                        >
                          {runningMs !== null ? f.running : f.took} {formatDuration(clockMs, lang)}
                        </span>
                      ) : null}
                    </span>
                  </button>

                  {/* On every row of the day, not only the ones already checked
                      in: the morning run assigns before anyone arrives, so the
                      desk has to be able to move a technician beforehand too.
                      Once the work is done — or nobody turned up for it — the
                      name is a record, not a setting. See techLockReason. */}
                  {lockReason ? (
                    <span
                      className="w-36 shrink-0 truncate text-xs text-ink/50"
                      title={lockReason === "no-show" ? f.techNoShow : f.techLocked}
                    >
                      {/* A no-show has no technician worth naming: whoever was
                          pencilled in never served anyone. Saying so beats a
                          name that reads like a record of work done. */}
                      {lockReason === "no-show" ? f.techNoShowShort : (r.technicianName ?? "")}
                    </span>
                  ) : (
                    <TechSelect
                      value={r.technicianId ?? ""}
                      onChange={(v) => doReassign(r.id, v)}
                      options={data.technicians}
                      // Against *this* booking's hours, not the wall clock.
                      busyIds={busyDuring(data.rows, r)}
                      emptyLabel={f.unassigned}
                      // Nobody can be un-assigned by hand — see doReassign.
                      allowEmpty={false}
                      className="w-36"
                    />
                  )}

                  {ready ? (
                    <Button size="sm" onClick={() => doClose(r.id)} disabled={busy}>
                      {f.close}
                    </Button>
                  ) : (
                    <Badge tone={STATUS_TONE[r.status]}>{t.bookings.statuses[r.status]}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* The bookings screen's own drawer, not a second one written here. Both
          flags come down from the page: the desk holds bookings.reschedule, so
          it gets the picker and can move an appointment a customer is ringing
          about, but not the status buttons — overwriting the record is the
          owner's. Check-in and closing a ticket are its own buttons, above. */}
      <BookingDrawer
        booking={open}
        // The lookup panel above names the party while she is at the counter;
        // this is the same party in the drawer, where each member is a button
        // that opens them. Same fact, two jobs: one tells her, one gets her there.
        partners={
          open?.groupId ? data.rows.filter((r) => r.groupId === open.groupId && r.id !== open.id) : []
        }
        canSetStatus={canSetStatus}
        canReschedule={canReschedule}
        // Never from the desk, whoever is signed in. Deleting is a records job
        // done on the bookings screen with the whole day in front of you, not a
        // button within reach of a queue at the counter.
        canDelete={false}
        checkinEarlyMin={data.checkinEarlyMin}
        branchId={branchId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          setOpenId(null);
          router.refresh();
        }}
      />
    </>
  );
}

/** One of the two answers the counter needs, said in as little space as it fits. */
function HeadFact({
  label,
  value,
  fallback = "—",
}: {
  label: string;
  value: string | null;
  fallback?: string;
}) {
  return (
    <span className="whitespace-nowrap text-xs text-ink/50">
      {label}{" "}
      <span className="font-display text-base font-bold text-ink">{value || fallback}</span>
    </span>
  );
}

/**
 * Pick a technician for one booking.
 *
 * Whoever cannot take *this* slot is greyed out rather than merely labelled:
 * a list where every name is selectable and half of them are annotated leaves
 * the receptionist doing the collision check in her head, at the desk, with a
 * customer in front of her.
 *
 * The one who currently holds the booking is never disabled — a row must be
 * able to render its own value.
 */
export function TechSelect({
  id,
  value,
  onChange,
  options,
  busyIds,
  omitId,
  emptyLabel,
  allowEmpty,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: TechnicianOption[];
  /** Technicians already working across this booking's hours. */
  busyIds: Set<string>;
  /** Dropped from the list entirely — the technician this booking is leaving. */
  omitId?: string | null;
  emptyLabel: string;
  /** False on a booking row, where clearing a technician is not a human choice. */
  allowEmpty?: boolean;
  className?: string;
}) {
  const { t } = useAdminI18n();
  const { busySuffix: busyLabel, offSuffix: offLabel } = t.frontDesk;

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
      {/* Rendered even when it cannot be chosen: an unassigned row has to have
          something to show, and this is the label that says why. */}
      <option value="" disabled={!allowEmpty}>
        {emptyLabel}
      </option>
      {options
        .filter((o) => o.id !== omitId)
        .map((o) => {
          // Reasons in order of how much they matter: not in at all beats busy.
          const reason = o.off ? offLabel : busyIds.has(o.id) ? busyLabel : null;
          return (
            <option key={o.id} value={o.id} disabled={!!reason && o.id !== value}>
              {reason ? `${o.name} · ${reason}` : o.name}
            </option>
          );
        })}
    </select>
  );
}

/** One lane: a coloured heading, a count, and its rows. */
function LaneCard({
  lane,
  title,
  rows,
  empty,
  children,
}: {
  lane: Lane;
  title: string;
  rows: FrontDeskRow[];
  empty: string;
  children: (r: FrontDeskRow) => React.ReactNode;
}) {
  const style = LANE_STYLE[lane];

  return (
    <Card className={cn("overflow-hidden", style.card)}>
      <div className={cn("flex items-center gap-2 border-b border-black/[0.06] px-4 py-3", style.head)}>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", style.dot)} />
        <h2 className={cn("text-[11px] font-bold uppercase tracking-wider", style.text)}>{title}</h2>
        <span className={cn("ms-auto text-xs font-semibold tabular-nums", style.text)}>
          {rows.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-7 text-center text-xs text-ink/40">{empty}</p>
      ) : (
        <ul className="divide-y divide-black/[0.04]">
          {rows.map((r) => (
            <li key={r.id}>{children(r)}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * A row inside a lane.
 *
 * Bigger than the list below it and carrying at most one button, because this
 * is read at arm's length and pressed with a thumb. The technician is named but
 * not editable here — changing her is a considered act and lives in the full
 * day list, where there is room for the dropdown and no queue at the counter.
 */
function LaneRow({
  r,
  lane,
  now,
  graceMin,
  f,
  lang,
  busy,
  onOpen,
  onCheckIn,
  onClose,
}: {
  r: FrontDeskRow;
  lane: Lane;
  now: number;
  graceMin: number;
  f: ReturnType<typeof useAdminI18n>["t"]["frontDesk"];
  lang: "ar" | "en";
  busy: boolean;
  onOpen: () => void;
  onCheckIn: () => void;
  onClose: () => void;
}) {
  const startedAt = new Date(r.startsAt).getTime();
  const lateMin = Math.max(0, Math.round((now - startedAt) / 60_000));
  const expectedMin = Math.max(0, Math.round((new Date(r.endsAt).getTime() - startedAt) / 60_000));

  // How long she has been here, wait included — see lib/booking-clock.ts.
  const { runningMs, tookMs } = serviceClock(r, now);
  const runningMin = runningMs === null ? null : Math.max(0, Math.round(runningMs / 60_000));
  const overMin = runningMin !== null && expectedMin > 0 ? runningMin - expectedMin : 0;

  // Checked in, nobody has pressed Start. The lane holds both on purpose.
  const unstarted = lane === "service" && !r.startedAt;

  return (
    <div className="flex items-center gap-3 px-4 py-3 text-start">
      {/* Everything except the one button opens the booking. Read at arm's
          length, pressed with a thumb — so the target is the whole card, not a
          chevron somebody has to aim at. */}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-start"
      >
        <Thumb src={r.imageUrl} size="sm" />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">
            {r.customerName ?? "—"}
          </span>
          <span className="block truncate text-[13px] tabular-nums text-ink/55">
            {[pick(r.serviceName, lang), localTime(r.startsAt), r.stationLabel, r.technicianName]
              .filter(Boolean)
              .join(" · ")}
          </span>

          {/* Late is the one lane where the wait itself is the news, so it gets
              a line of its own rather than sitting in the run of grey text —
              and it says what happens next, because the deadline is the reason
              anyone is looking at this row. */}
          {lane === "late" ? (
            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-red/10 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-red">
              {f.minutesLate(lateMin)} · {f.noShowIn(Math.max(0, graceMin - lateMin))}
            </span>
          ) : null}

          {/* Amber matches the checked-in pulse on /admin/bookings. */}
          {unstarted ? (
            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-[#b7791f]/[0.12] px-2.5 py-0.5 text-xs font-semibold text-[#8a5a06]">
              {f.notStarted}
            </span>
          ) : null}
        </span>
      </button>

      {r.ticketNo && (lane === "arriving" || lane === "late") ? (
        <Badge tone="neutral" className="shrink-0 tabular-nums">
          {r.ticketNo}
        </Badge>
      ) : null}

      {lane === "service" ? (
        <span className="shrink-0 text-end tabular-nums">
          <span
            className={cn(
              "block text-[17px] font-semibold",
              // Amber outranks the over-run red here: a service that has not
              // started cannot be overrunning, it is a queue.
              unstarted ? "text-[#8a5a06]" : overMin > 0 ? "text-red" : "text-[#2c6a88]",
            )}
          >
            {runningMin === null ? "—" : formatDuration(runningMin * 60_000, lang)}
          </span>
          {/* The over-run line has to answer to `unstarted` as well, or the row
              says "waiting for a technician" in amber and "over by 30" in red
              at the same time. Nothing has started, so nothing is overrunning:
              it is still only what the service is booked to take. */}
          <span
            className={cn(
              "block text-[11px]",
              !unstarted && overMin > 0 ? "text-red" : "text-ink/45",
            )}
          >
            {!unstarted && overMin > 0 ? f.overBy(overMin) : f.ofAbout(expectedMin)}
          </span>
        </span>
      ) : lane === "ready" ? (
        <>
          {tookMs !== null ? (
            <span className="hidden shrink-0 text-end text-[11px] tabular-nums text-ink/45 sm:block">
              {f.took} {formatDuration(tookMs, lang)}
            </span>
          ) : null}
          <Button onClick={onClose} disabled={busy} className="h-11 shrink-0 px-5 text-sm">
            {f.close}
          </Button>
        </>
      ) : (
        <Button onClick={onCheckIn} disabled={busy} className="h-11 shrink-0 px-5 text-sm">
          {f.checkIn}
        </Button>
      )}
    </div>
  );
}
