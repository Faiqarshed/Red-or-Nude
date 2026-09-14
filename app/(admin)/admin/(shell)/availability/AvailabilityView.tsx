"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, QrCode, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardHeader, Field, Input, invalidRing, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { collect, focusFirstInvalid, hasErrors, rules } from "@/lib/admin/validate";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import { closureDays } from "@/lib/time";
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
  const [stationTried, setStationTried] = useState(false);
  const [closureTried, setClosureTried] = useState(false);

  const a = t.availability;
  const v = t.validation;
  const r = rules(v);

  // The server's refusals, as sentences. It used to print the code itself.
  const messageFor = (code?: string) =>
    code === "closes-before-opens"
      ? v.after(a.closes, a.opens)
      : code === "to-before-from"
        ? v.notBefore(a.to, a.from)
        : code === "in-use"
          ? a.stationInUse
          : t.common.error;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(messageFor(res.error));
      router.refresh();
    });

  // Checked as she types, not on a save press: hours save the moment a box
  // loses focus, so there is no later moment to tell her.
  const dayError = (day: Hours) =>
    day.closed
      ? undefined
      : !day.opens
        ? v.required(a.opens)
        : !day.closes
          ? v.required(a.closes)
          : day.closes <= day.opens
            ? v.after(a.closes, a.opens)
            : undefined;

  const stationError = stationTried
    ? r.text(a.stationLabel, newStation, { max: 40 })
    : undefined;

  const checkClosure = () =>
    collect({
      from: !closure.from && v.required(a.from),
      to: !closure.to
        ? v.required(a.to)
        : closure.from && closure.to < closure.from && v.notBefore(a.to, a.from),
      reason: r.text(a.reason, closure.reasonAr, { required: false, max: 120 }),
    });
  const closureErrors = closureTried ? checkClosure() : {};

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
    if (!day || dayError(day)) return;
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
                    const next = { ...day, closed: !day.closed };
                    updateDay(day.weekday, { closed: next.closed });
                    if (!dayError(next)) run(() => saveBranchHours({ branchId, ...next }));
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
                      aria-label={a.opens}
                      aria-invalid={!!dayError(day)}
                      value={day.opens}
                      onChange={(e) => updateDay(day.weekday, { opens: e.target.value })}
                      onBlur={() => saveDay(day.weekday)}
                      className={cn(
                        "h-9 rounded-lg border border-black/10 bg-white px-2 text-sm tabular-nums text-ink outline-none focus:border-sky",
                        invalidRing,
                      )}
                    />
                    <span className="text-xs text-ink/35">–</span>
                    <input
                      type="time"
                      aria-label={a.closes}
                      aria-invalid={!!dayError(day)}
                      value={day.closes}
                      onChange={(e) => updateDay(day.weekday, { closes: e.target.value })}
                      onBlur={() => saveDay(day.weekday)}
                      className={cn(
                        "h-9 rounded-lg border border-black/10 bg-white px-2 text-sm tabular-nums text-ink outline-none focus:border-sky",
                        invalidRing,
                      )}
                    />
                    {dayError(day) ? (
                      <span role="alert" className="text-xs text-red">
                        {dayError(day)}
                      </span>
                    ) : null}
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
          <div className="flex items-start gap-2 border-t border-black/[0.06] p-4">
            <Field label={a.stationLabel} error={stationError}>
              <Input
                aria-invalid={!!stationError}
                value={newStation}
                onChange={(e) => setNewStation(e.target.value)}
              />
            </Field>
            <Button
              size="md"
              className="mt-6"
              onClick={() => {
                setStationTried(true);
                if (r.text(a.stationLabel, newStation, { max: 40 })) return focusFirstInvalid();
                run(() => addStation(branchId, newStation));
                setNewStation("");
                setStationTried(false);
              }}
            >
              <Plus className="h-4 w-4" strokeWidth={2} />
              {t.availability.addStation}
            </Button>
          </div>
          {/* The stickers that make §2.7 work. A plain link rather than a
              dialog: the page is a print target, not a modal. */}
          <div className="border-t border-black/[0.06] px-4 py-3">
            <Link
              href={`/admin/availability/qr?branch=${branchId}`}
              className="inline-flex items-center gap-2 text-[13px] font-semibold text-ink/60 transition-colors hover:text-red"
            >
              <QrCode className="h-4 w-4" strokeWidth={1.75} />
              {t.availability.qrCodes}
            </Link>
          </div>
        </Card>

        {/* Closures */}
        <Card>
          <CardHeader title={t.availability.closures} />
          {closures.length === 0 ? (
            <p className="px-5 py-6 text-center text-xs text-ink/40">{t.availability.noClosures}</p>
          ) : (
            <ul className="divide-y divide-black/[0.05]">
              {closures.map((c) => {
                // The days as they were typed into the form above. Both ends
                // have to come back through closureDays: the stored range is
                // half-open and in Riyadh time, so slicing the ISO string
                // showed a closure entered as 20–22 March as 19 → 21.
                const { from, to } = closureDays(new Date(c.startsAt), new Date(c.endsAt));
                return (
                <li key={c.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex-1 text-start">
                    <p className="text-sm text-ink" dir="ltr">
                      {from} → {to}
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
                );
              })}
            </ul>
          )}
          <div className="space-y-3 border-t border-black/[0.06] p-4">
            <div className="grid grid-cols-2 gap-2">
              <Field label={a.from} error={closureErrors.from}>
                <Input
                  type="date"
                  aria-invalid={!!closureErrors.from}
                  value={closure.from}
                  onChange={(e) => setClosure((c) => ({ ...c, from: e.target.value }))}
                />
              </Field>
              <Field label={a.to} error={closureErrors.to}>
                <Input
                  type="date"
                  min={closure.from || undefined}
                  aria-invalid={!!closureErrors.to}
                  value={closure.to}
                  onChange={(e) => setClosure((c) => ({ ...c, to: e.target.value }))}
                />
              </Field>
            </div>
            <Field label={a.reason} error={closureErrors.reason}>
              <Input
                aria-invalid={!!closureErrors.reason}
                value={closure.reasonAr}
                onChange={(e) => setClosure((c) => ({ ...c, reasonAr: e.target.value }))}
              />
            </Field>
            <Button
              size="sm"
              onClick={() => {
                setClosureTried(true);
                if (hasErrors(checkClosure())) return focusFirstInvalid();
                run(() => addClosure({ branchId, ...closure }));
                setClosure({ from: "", to: "", reasonAr: "", reasonEn: "" });
                setClosureTried(false);
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
