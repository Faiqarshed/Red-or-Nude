"use client";

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardHeader, Field, Input, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import {
  addClosure,
  addStation,
  deleteClosure,
  deleteStation,
  saveBranchHours,
  setStationActive,
} from "./actions";

type Hours = { weekday: number; opens: string; closes: string; closed: boolean };
type Station = { id: string; label: string; active: boolean };
type Closure = {
  id: string;
  global: boolean;
  startsAt: string;
  endsAt: string;
  reason: Localized | null;
};

export default function AvailabilityView({
  branchId,
  branches,
  hours,
  stations,
  closures,
}: {
  branchId: string;
  branches: { id: string; name: Localized }[];
  hours: Hours[];
  stations: Station[];
  closures: Closure[];
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Hours[]>(hours);
  const [newStation, setNewStation] = useState("");
  const [closure, setClosure] = useState({ from: "", to: "", reasonAr: "", reasonEn: "" });

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error ?? t.common.error);
      router.refresh();
    });

  const setBranch = (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("branch", id);
    startTransition(() => router.push(`/admin/availability?${sp.toString()}`));
  };

  const updateDay = (weekday: number, patch: Partial<Hours>) => {
    setDraft((prev) => prev.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));
  };

  const saveDay = (weekday: number) => {
    const day = draft.find((d) => d.weekday === weekday);
    if (!day) return;
    run(() => saveBranchHours({ branchId, ...day }));
  };

  return (
    <>
      <PageHeader
        title={t.availability.title}
        subtitle={t.availability.subtitle}
        action={
          branches.length > 1 ? (
            <select
              value={branchId}
              onChange={(e) => setBranch(e.target.value)}
              className="h-10 rounded-xl border border-black/[0.06] bg-white px-3 text-sm text-ink outline-none"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {pick(b.name, lang)}
                </option>
              ))}
            </select>
          ) : null
        }
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
          {error}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Opening hours */}
        <Card className="lg:col-span-2">
          <CardHeader title={t.availability.hours} />
          <ul className="divide-y divide-black/[0.05]">
            {draft.map((day) => (
              <li key={day.weekday} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="w-24 shrink-0 text-start text-sm text-ink">
                  {t.availability.weekdays[day.weekday]}
                </span>

                <button
                  role="switch"
                  aria-checked={!day.closed}
                  onClick={() => {
                    updateDay(day.weekday, { closed: !day.closed });
                    run(() => saveBranchHours({ branchId, ...day, closed: !day.closed }));
                  }}
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                    !day.closed ? "bg-[#1f7a4d]" : "bg-black/15",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                      !day.closed ? "end-0.5" : "start-0.5",
                    )}
                  />
                </button>

                {day.closed ? (
                  <span className="text-xs text-ink/40">{t.availability.closed}</span>
                ) : (
                  <>
                    <input
                      type="time"
                      value={day.opens}
                      onChange={(e) => updateDay(day.weekday, { opens: e.target.value })}
                      onBlur={() => saveDay(day.weekday)}
                      className="h-9 rounded-lg border border-black/10 bg-white px-2 text-sm tabular-nums text-ink outline-none focus:border-sky"
                    />
                    <span className="text-xs text-ink/35">–</span>
                    <input
                      type="time"
                      value={day.closes}
                      onChange={(e) => updateDay(day.weekday, { closes: e.target.value })}
                      onBlur={() => saveDay(day.weekday)}
                      className="h-9 rounded-lg border border-black/10 bg-white px-2 text-sm tabular-nums text-ink outline-none focus:border-sky"
                    />
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>

        {/* Chairs */}
        <Card>
          <CardHeader title={t.availability.stations} subtitle={`${stations.filter((s) => s.active).length}`} />
          <ul className="divide-y divide-black/[0.05]">
            {stations.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                <span className={cn("flex-1 text-start text-sm", s.active ? "text-ink" : "text-ink/40")}>
                  {s.label}
                </span>
                {!s.active && <Badge tone="neutral">{t.catalog.inactive}</Badge>}
                <button
                  role="switch"
                  aria-checked={s.active}
                  onClick={() => run(() => setStationActive(s.id, !s.active))}
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                    s.active ? "bg-[#1f7a4d]" : "bg-black/15",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                      s.active ? "end-0.5" : "start-0.5",
                    )}
                  />
                </button>
                <button
                  onClick={() => run(() => deleteStation(s.id))}
                  className="grid h-7 w-7 place-items-center rounded-lg text-ink/30 transition-colors hover:bg-red/[0.06] hover:text-red"
                  aria-label={t.catalog.delete}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-end gap-2 border-t border-black/[0.06] p-4">
            <Field label={t.availability.stationLabel}>
              <Input value={newStation} onChange={(e) => setNewStation(e.target.value)} />
            </Field>
            <Button
              size="md"
              onClick={() => {
                if (!newStation.trim()) return;
                run(() => addStation(branchId, newStation));
                setNewStation("");
              }}
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              {t.availability.addStation}
            </Button>
          </div>
        </Card>

        {/* Closures */}
        <Card>
          <CardHeader title={t.availability.closures} />
          {closures.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-ink/40">{t.availability.noClosures}</p>
          ) : (
            <ul className="divide-y divide-black/[0.05]">
              {closures.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex-1 text-start">
                    <p className="text-sm text-ink" dir="ltr">
                      {c.startsAt.slice(0, 10)} → {new Date(new Date(c.endsAt).getTime() - 86400000).toISOString().slice(0, 10)}
                    </p>
                    {c.reason ? (
                      <p className="text-[11px] text-ink/45">{pick(c.reason, lang)}</p>
                    ) : null}
                  </div>
                  {c.global && <Badge tone="info">all</Badge>}
                  <button
                    onClick={() => run(() => deleteClosure(c.id))}
                    className="grid h-7 w-7 place-items-center rounded-lg text-ink/30 transition-colors hover:bg-red/[0.06] hover:text-red"
                    aria-label={t.catalog.delete}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-3 border-t border-black/[0.06] p-4">
            <div className="grid grid-cols-2 gap-2">
              <Field label={t.availability.from}>
                <Input
                  type="date"
                  value={closure.from}
                  onChange={(e) => setClosure((c) => ({ ...c, from: e.target.value }))}
                />
              </Field>
              <Field label={t.availability.to}>
                <Input
                  type="date"
                  value={closure.to}
                  onChange={(e) => setClosure((c) => ({ ...c, to: e.target.value }))}
                />
              </Field>
            </div>
            <Field label={t.availability.reason}>
              <Input
                value={closure.reasonAr}
                onChange={(e) => setClosure((c) => ({ ...c, reasonAr: e.target.value }))}
              />
            </Field>
            <Button
              size="sm"
              disabled={!closure.from || !closure.to}
              onClick={() => {
                run(() => addClosure({ branchId, ...closure }));
                setClosure({ from: "", to: "", reasonAr: "", reasonEn: "" });
              }}
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              {t.availability.addClosure}
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
