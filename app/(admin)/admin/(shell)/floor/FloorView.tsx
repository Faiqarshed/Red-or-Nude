"use client";

// Today's floor, read technician-first.
//
// One card each. When someone goes home her card stays exactly where it was,
// now marked out and with her remaining customers listed underneath — the desk
// works down that list handing each one to somebody still here. Nothing is moved
// automatically: the receptionist knows which of her customers can wait and which
// cannot, and the software does not.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronDown } from "lucide-react";
import { Badge, BranchFilter, Button, Card, EmptyState, PageHeader } from "@/components/admin/ui";
import { Dialog } from "@/components/admin/overlays";
import RescheduleDialog from "../bookings/RescheduleDialog";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { localTime } from "@/lib/time";
import { busyDuring } from "@/lib/slots";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import type { FloorBooking, FloorData } from "./data";
import { bringBack, sendHome } from "./actions";
import { assignTechnician } from "../front-desk/actions";
import { TechSelect } from "../front-desk/FrontDeskView";
import TechnicianDay, { DayCounts, useDayClock, useToggleSet } from "../technicians/TechnicianDay";

export default function FloorView({
  data,
  branchId,
  branchOptions,
  canReschedule = false,
}: {
  data: FloorData;
  branchId: string;
  /** `bookings.reschedule`, for a customer nobody left is free to take. */
  canReschedule?: boolean;
  /** Empty for anyone pinned. A floor is one place, so there is no "all". */
  branchOptions: { id: string; name: Localized }[];
}) {
  const { t, lang } = useAdminI18n();
  const f = t.floor;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, toggle] = useToggleSet();
  const now = useDayClock();
  /**
   * The technician being sent home, while the desk decides where her customers
   * go. Nothing has happened yet — Cancel leaves the floor exactly as it was.
   */
  const [leaving, setLeaving] = useState<string | null>(null);
  /** Booking id → the technician it will go to, once Done is pressed. */
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<FloorBooking | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error === "on-leave" ? f.onLeave : t.common.error);
      router.refresh();
    });

  const working = data.technicians.filter((tech) => !tech.off).length;

  // Nobody's, and still ahead of them a customer expecting someone. Read off
  // the day rather than off a technician, because that is the whole point —
  // these rows belong to no card, so no card would ever show them.
  const orphans = data.rows.filter((b) => !b.technicianId && b.status === "confirmed");

  // The send-home plan, read live off the day so a booking rescheduled from the
  // popup leaves the list the moment the page refreshes.
  const leavingTech = data.technicians.find((tech) => tech.id === leaving) ?? null;
  const waiting = leavingTech?.bookings.filter((b) => b.status === "confirmed") ?? [];
  const staysWithLeaving =
    leavingTech?.bookings.filter((b) => !["confirmed", "cancelled", "no_show"].includes(b.status)) ?? [];
  // The day as it will be after Done, so two of her customers at one hour cannot
  // both be handed to the same person.
  const planned = data.rows.map((r) => (picks[r.id] ? { ...r, technicianId: picks[r.id] } : r));
  const allPlaced = waiting.every((b) => picks[b.id]);

  const closeLeaving = () => {
    setLeaving(null);
    setPicks({});
    setLeaveError(null);
  };

  const confirmLeaving = () =>
    startTransition(async () => {
      if (!leaving || !allPlaced) return;
      setLeaveError(null);
      const res = await sendHome(
        leaving,
        waiting.map((b) => ({ bookingId: b.id, technicianId: picks[b.id] })),
      );
      router.refresh();
      if (res.ok) return closeLeaving();
      // `unplaced`: a booking landed on her while the popup was open. The refresh
      // above puts it in the list; saying so beats a Done that silently fails.
      setLeaveError(
        res.error === "unplaced" ? f.unplaced : res.error === "bad-target" ? f.badTarget : t.common.error,
      );
    });

  // The one list, rendered in two places: under a technician on leave, and at
  // the top of the screen. Each pick there is applied at once.
  const moveList = (rows: FloorBooking[]) => (
    <ul className="divide-y divide-black/[0.06]">
      {rows.map((b) => (
        <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-start">
          <span className="w-12 shrink-0 font-display text-base font-extrabold text-red">
            {b.ticketNo ?? "—"}
          </span>
          <span className="w-24 shrink-0 text-xs tabular-nums text-ink/50">
            {localTime(b.startsAt)}–{localTime(b.endsAt)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">
              {b.customerName ?? "—"}
            </span>
            <span className="block truncate text-xs text-ink/50">{pick(b.serviceName, lang)}</span>
          </span>

          {/* The desk's own picker: same greying, same rule. Value stays empty —
              this is "move it", not "show who has it". */}
          <TechSelect
            value=""
            onChange={(to) => run(() => assignTechnician(b.id, to))}
            options={data.technicians}
            busyIds={busyDuring(data.rows, b)}
            omitId={b.technicianId}
            emptyLabel={f.moveTo}
            allowEmpty
            className="w-40 shrink-0"
          />
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader
        title={f.title}
        subtitle={f.subtitle.replace("{n}", String(working))}
        action={
          <BranchFilter
            branchId={branchId}
            options={branchOptions}
            allLabel={t.topbar.allBranches}
            lang={lang}
            allowAll={false}
            onChange={(id) => router.push(id ? `/admin/floor?branch=${id}` : "/admin/floor")}
          />
        }
      />

      {error && (
        <p className="mb-4 rounded-xl bg-red/10 px-4 py-3 text-sm text-red">{error}</p>
      )}

      {/* Above the team, not inside it: these have no card of their own, and a
          customer arriving to nobody is the most urgent thing on the screen. */}
      {orphans.length > 0 && (
        <Card className="mb-4 overflow-hidden border-red/30">
          <p className="border-b border-black/[0.06] bg-red/5 px-4 py-3 text-xs font-semibold text-red">
            {f.needsTechnician} · {orphans.length}
          </p>
          {moveList(orphans)}
        </Card>
      )}

      {data.technicians.length === 0 ? (
        <Card>
          <EmptyState title={f.noTechnicians} />
        </Card>
      ) : (
        <div className="space-y-4">
          {data.technicians.map((tech) => {
            // What still needs a home. A customer already in the chair is not
            // a booking to hand around — that work is happening, or it is done.
            const toMove = tech.bookings.filter((b) => b.status === "confirmed");

            // And what does not, which the screen never said. Sending someone
            // home with four bookings takes two off her and leaves two sitting
            // there under the name of somebody who has left the building, with
            // nothing to explain why they stayed. A finished service
            // records who performed it — /admin/performance reads its timings
            // off exactly these rows — and a customer mid-service is in her
            // chair right now. Neither can be handed to anyone else.
            const staying = tech.bookings.filter(
              (b) => !["confirmed", "cancelled", "no_show"].includes(b.status),
            );

            return (
              <Card key={tech.id} className={cn("overflow-hidden", tech.off && "bg-black/[0.02]")}>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  {/* The count was the only thing this card said about a
                      technician who is here, so "what is she actually doing"
                      needed a different screen. It unfolds now. */}
                  <button
                    type="button"
                    onClick={() => toggle(tech.id)}
                    aria-expanded={open.has(tech.id)}
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-3 text-start"
                  >
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-ink/35 transition-transform",
                        open.has(tech.id) && "rotate-180",
                      )}
                      strokeWidth={2}
                    />
                    <span className="font-display text-base font-bold text-ink">{tech.name}</span>
                    {tech.off ? (
                      <Badge tone="danger">{f.off}</Badge>
                    ) : (
                      <Badge tone="success">{f.here}</Badge>
                    )}
                    <DayCounts rows={tech.bookings} />
                  </button>

                  {tech.off ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => bringBack(tech.id))}
                    >
                      {f.bringBack}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => setLeaving(tech.id)}
                    >
                      {f.sendHome}
                    </Button>
                  )}
                </div>

                {open.has(tech.id) ? <TechnicianDay rows={tech.bookings} now={now} /> : null}

                {/* Her customers, and where they go. Listed only once she is out:
                    a technician who is here needs no reassignment prompts. And
                    never behind the toggle above — this is the thing the desk
                    has to act on, not a detail it went looking for. */}
                {tech.off && toMove.length > 0 && (
                  <div className="border-t border-black/[0.06] bg-white">
                    <p className="px-4 pt-3 text-xs font-semibold text-red">{f.needsMoving}</p>
                    {moveList(toMove)}
                  </div>
                )}

                {tech.off && toMove.length === 0 && tech.bookings.length > 0 && (
                  <p className="border-t border-black/[0.06] px-4 py-3 text-xs text-ink/50">
                    {f.nothingToMove}
                  </p>
                )}

                {tech.off && staying.length > 0 && (
                  <p className="border-t border-black/[0.06] px-4 py-3 text-xs text-ink/50">
                    {f.staysWithHer(staying.length)}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Asked before anything happens. Every waiting customer gets a technician
          here, or a new time, and Done sends her home with all of them placed in
          one call. Cancel — the button, the ×, Escape, the backdrop — leaves the
          floor untouched. */}
      <Dialog
        open={leavingTech !== null}
        onClose={closeLeaving}
        title={f.sendHomeTitle(leavingTech?.name ?? "")}
        className="max-w-lg"
        footer={
          <>
            {/* Why Done is grey, beside it rather than left to guesswork. */}
            {!allPlaced && (
              <span className="me-auto text-start text-xs text-ink/50">{f.placeAll}</span>
            )}
            <Button variant="secondary" size="sm" onClick={closeLeaving} disabled={pending}>
              {t.common.cancel}
            </Button>
            <Button size="sm" onClick={confirmLeaving} disabled={pending || !allPlaced}>
              {f.done}
            </Button>
          </>
        }
      >
        <p className="text-start text-xs text-ink/60">
          {waiting.length ? f.sendHomeBody(waiting.length) : f.sendHomeNothing}
        </p>

        {waiting.length > 0 && (
          <ul className="mt-3 divide-y divide-black/[0.06] rounded-xl bg-white">
            {waiting.map((b) => {
              const busy = busyDuring(planned, b);
              const anyoneFree = data.technicians.some(
                (o) => !o.off && o.id !== leaving && !busy.has(o.id),
              );
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-start">
                  <span className="w-10 shrink-0 font-display text-base font-extrabold text-red">
                    {b.ticketNo ?? "—"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {b.customerName ?? "—"}
                    </span>
                    <span className="block truncate text-xs text-ink/50">
                      <span className="tabular-nums">
                        {localTime(b.startsAt)}–{localTime(b.endsAt)}
                      </span>{" "}
                      · {pick(b.serviceName, lang)}
                    </span>
                  </span>

                  {/* Nobody left who is free at her hour: a technician list of
                      greyed names is not an answer, a new time is. */}
                  {anyoneFree || picks[b.id] ? (
                    <TechSelect
                      value={picks[b.id] ?? ""}
                      onChange={(to) => setPicks((p) => ({ ...p, [b.id]: to }))}
                      options={data.technicians}
                      busyIds={busy}
                      omitId={leaving}
                      emptyLabel={f.moveTo}
                      className="w-40 shrink-0"
                    />
                  ) : canReschedule ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setRescheduling(b)}
                      className="shrink-0"
                    >
                      <CalendarClock className="h-4 w-4" strokeWidth={1.75} />
                      {t.bookings.reschedule}
                    </Button>
                  ) : null}

                  {/* Why the picker became a button. On its own line, under the
                      booking it is about, so "Change time" is never a mystery. */}
                  {!anyoneFree && !picks[b.id] && (
                    <p className="basis-full text-xs text-red">
                      {canReschedule ? f.noOneFreeMove : f.noOneFreeAsk}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {staysWithLeaving.length > 0 && (
          <p className="mt-3 text-start text-xs text-ink/50">{f.staysWithHer(staysWithLeaving.length)}</p>
        )}

        {leaveError && (
          <p role="alert" className="mt-3 rounded-xl bg-red/10 px-3 py-2 text-start text-xs text-red">
            {leaveError}
          </p>
        )}
      </Dialog>

      {/* After the send-home dialog, so it opens on top of it. A moved booking is
          re-dealt by the server; the refresh brings it back into the list only if
          it landed on her again, and its old pick is dropped either way — a new
          time is a new question about who is free. */}
      <RescheduleDialog
        open={rescheduling !== null}
        booking={rescheduling}
        branchId={branchId}
        onClose={() => setRescheduling(null)}
        onDone={() => {
          if (rescheduling) {
            const { [rescheduling.id]: _dropped, ...rest } = picks;
            setPicks(rest);
          }
          router.refresh();
        }}
      />
    </>
  );
}
