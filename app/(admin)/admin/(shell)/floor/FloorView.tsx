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
import type { FloorData } from "./data";
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

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error === "on-leave" ? f.onLeave : t.common.error);
      router.refresh();
    });

  const working = data.technicians.filter((tech) => !tech.off).length;

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
            // home with four bookings moves one and leaves three, and until now
            // the other three just sat there under the name of somebody who has
            // left the building with nothing to explain why. A finished service
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
                      onClick={() => run(() => sendHome(tech.id))}
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
                    <ul className="divide-y divide-black/[0.06]">
                      {toMove.map((b) => (
                        <li
                          key={b.id}
                          className="flex flex-wrap items-center gap-3 px-4 py-3 text-start"
                        >
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
                            <span className="block truncate text-xs text-ink/50">
                              {pick(b.serviceName, lang)}
                            </span>
                          </span>

                          {/* The desk's own picker: same greying, same rule.
                              Value stays empty — this is "move it", not "show
                              who has it", and she is leaving either way. */}
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
    </>
  );
}
