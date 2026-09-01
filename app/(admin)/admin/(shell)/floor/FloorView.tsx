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
import { ChevronDown } from "lucide-react";
import { Badge, BranchFilter, Button, Card, EmptyState, PageHeader } from "@/components/admin/ui";
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
}: {
  data: FloorData;
  branchId: string;
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
  /** How many customers the last Send home left without a technician. */
  const [alerted, setAlerted] = useState<number | null>(null);

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

  // The one list, rendered in three places: under a technician on leave, at the
  // top of the screen, and in the popup that says to go and do it now.
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
                      onClick={() =>
                        run(async () => {
                          const res = await sendHome(tech.id);
                          if (res.ok && res.released) setAlerted(res.released);
                          return res;
                        })
                      }
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

      {/* Said out loud, once, at the moment it becomes true. The card above says
          the same thing and stays until it is done — this is only what stops the
          desk walking away from a floor that no longer adds up. */}
      {alerted !== null && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
        >
          <Card className="w-full max-w-lg overflow-hidden">
            <div className="border-b border-black/[0.06] bg-red/5 px-4 py-3">
              <p className="font-display text-base font-bold text-red">{f.sentHomeTitle}</p>
              <p className="mt-1 text-xs text-ink/60">{f.sentHomeBody(alerted)}</p>
            </div>
            {/* The live list, so a row leaves as soon as it is placed. */}
            <div className="max-h-[55vh] overflow-y-auto">{moveList(orphans)}</div>
            <div className="border-t border-black/[0.06] px-4 py-3 text-end">
              <Button variant="secondary" size="sm" onClick={() => setAlerted(null)}>
                {f.done}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
