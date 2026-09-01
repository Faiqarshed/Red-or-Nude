"use client";

// One card per technician, unfolding into her whole day.
//
// The controls are one axis on purpose: a date. Averages over a week live on
// /admin/performance, and a screen carrying both a period and a date would leave
// the reader working out which of the two a given number answered to.

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Badge, Button, Card, DateStepper, EmptyState, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import type { FloorData } from "../floor/data";
import TechnicianDay, { DayCounts, useDayClock, useToggleSet } from "./TechnicianDay";

export default function TechniciansView({
  data,
  date,
  today,
  branchId,
  branches,
}: {
  data: FloorData;
  date: string;
  /** So the "back to today" button knows when it would do nothing. */
  today: string;
  branchId: string;
  /** Empty for anyone pinned to one branch — see the page. */
  branches: { id: string; name: Localized }[];
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [open, toggle] = useToggleSet();
  const now = useDayClock();

  // The date lives in the URL so a day can be sent to a colleague, and so
  // coming back from another screen lands on the day that was being read.
  const go = (next: Record<string, string>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) q.set(k, v);
    router.push(`/admin/technicians?${q.toString()}`);
  };

  return (
    <>
      <PageHeader title={t.technicians.title} subtitle={t.technicians.subtitle} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DateStepper
          date={date}
          onChange={(next) => go({ date: next })}
          labels={{ prev: t.bookings.prevDay, next: t.bookings.nextDay, date: t.bookings.date }}
        />

        {date !== today ? (
          <Button variant="secondary" size="sm" onClick={() => go({ date: today })}>
            {t.bookings.jumpToday}
          </Button>
        ) : null}

        {branches.length > 1 ? (
          <select
            value={branchId}
            onChange={(e) => go({ branch: e.target.value })}
            className="h-10 rounded-xl border border-black/[0.06] bg-white px-3 text-sm text-ink outline-none"
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {pick(b.name, lang)}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {data.technicians.length === 0 ? (
        <Card>
          <EmptyState title={t.technicians.noTechnicians} />
        </Card>
      ) : (
        <div className="space-y-3">
          {data.technicians.map((tech) => (
            <Card key={tech.id} className={cn("overflow-hidden", tech.off && "bg-black/[0.02]")}>
              <button
                type="button"
                onClick={() => toggle(tech.id)}
                aria-expanded={open.has(tech.id)}
                className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-start"
              >
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-ink/35 transition-transform",
                    open.has(tech.id) && "rotate-180",
                  )}
                  strokeWidth={2}
                />
                <span className="font-display text-base font-bold text-ink">{tech.name}</span>
                {/* Only when she was out: "here" is the ordinary case and a badge
                    on every card would say nothing. */}
                {tech.off ? <Badge tone="danger">{t.floor.off}</Badge> : null}
                <DayCounts rows={tech.bookings} />
              </button>

              {open.has(tech.id) ? <TechnicianDay rows={tech.bookings} now={now} /> : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
