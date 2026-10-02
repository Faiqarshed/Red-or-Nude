"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, QrCode, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardHeader, Field, Input, invalidRing, PageHeader, touchTargetSm, touchTargetSwitch } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { usePendingAction } from "@/components/admin/use-pending-action";
import { ConfirmDialog } from "@/components/admin/overlays";
import TextField from "@/components/admin/TextField";
import {
  CHAIR_MAX,
  CHAIR_TEXT,
  checkChairLabel,
  checkClosure,
  CLOSURE_LIMITS,
  CLOSURE_TEXT,
  closureWindow,
  focusFirstInvalid,
  hasErrors,
} from "@/lib/admin/validate";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import { closureDays, dayRange, formatDateKey, riyadhDateKey } from "@/lib/time";
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
  // Busy from the click until the fresh screen is back, and which control
  // started it, so that one shows it. A bare useTransition ended at the first
  // await (React 18), and this one's busy flag was thrown away, so adding a
  // chair or a closure gave no sign it had been pressed.
  const { pending, run: busy } = usePendingAction();
  const [busyWith, setBusyWith] = useState<string | null>(null);
  // Switching branch is a navigation, not a save.
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // A chair or closure waiting on "are you sure": both delete for good.
  const [doomed, setDoomed] = useState<{ kind: "station" | "closure"; id: string; name: string } | null>(null);
  const { pending: deleting, run: busyDeleting } = usePendingAction();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Hours[]>(hours);
  const [newStation, setNewStation] = useState("");
  const [closure, setClosure] = useState({ from: "", to: "", reasonAr: "", reasonEn: "" });
  const [stationTried, setStationTried] = useState(false);
  const [closureTried, setClosureTried] = useState(false);

  const a = t.availability;
  const v = t.validation;

  // The server's refusals, as sentences. It used to print the code itself.
  const messageFor = (code?: string) =>
    code === "closes-before-opens"
      ? v.after(a.closes, a.opens)
      : code === "to-before-from"
        ? v.notBefore(a.to, a.from)
        : code === "in-use"
          ? a.stationInUse
          : t.common.error;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, key = "hours") => {
    setBusyWith(key);
    void busy(async () => {
      setError(null);
      const res = await fn();
      if (res.ok) return;
      setError(messageFor(res.error));
      return false;
    });
  };
  const busyOn = (key: string) => pending && busyWith === key;

  const confirmDelete = () =>
    busyDeleting(async () => {
      if (!doomed) return false;
      setDeleteError(null);
      const res = doomed.kind === "station" ? await deleteStation(doomed.id) : await deleteClosure(doomed.id);
      if (!res.ok) {
        setDeleteError(messageFor(res.error));
        return false;
      }
      setDoomed(null);
    });
  const askDelete = (d: NonNullable<typeof doomed>) => {
    setDeleteError(null);
    setDoomed(d);
  };

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

  const checkStation = () => checkChairLabel(t, newStation, stations.map((s) => s.label));
  const stationError = stationTried ? checkStation() : undefined;

  const today = riyadhDateKey();
  const { earliest, latest } = closureWindow(today);
  const checkClosureForm = () =>
    checkClosure(t, { from: closure.from, to: closure.to, reason: closure.reasonAr }, today, (k) =>
      formatDateKey(k, lang),
    );
  const closureErrors = closureTried ? checkClosureForm() : {};

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

      {/* Hours beside chairs, the two about-the-same-height lists; closures
          under both, full width, with its form on one line. */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Opening hours */}
        <Card>
          <CardHeader title={t.availability.hours} />
          <ul className="divide-y divide-black/[0.05]">
            {draft.map((day) => (
              <li key={day.weekday} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <span
                  className={cn(
                    "min-w-0 flex-1 text-start text-sm font-medium",
                    day.closed ? "text-ink/40" : "text-ink",
                  )}
                >
                  {t.availability.weekdays[day.weekday]}
                </span>

                {/* Under the day on a phone, between the day and its switch from sm. */}
                {day.closed ? (
                  <span className="text-xs text-ink/40 max-sm:order-last max-sm:basis-full max-sm:text-start">
                    {t.availability.closed}
                  </span>
                ) : (
                  <div className="flex items-center rounded-xl border border-black/10 bg-cream/50 px-1 transition-colors focus-within:border-red/30 focus-within:bg-white max-sm:order-last max-sm:basis-full max-sm:justify-between">
                    <input
                      type="time"
                      aria-label={a.opens}
                      aria-invalid={!!dayError(day)}
                      value={day.opens}
                      onChange={(e) => updateDay(day.weekday, { opens: e.target.value })}
                      onBlur={() => saveDay(day.weekday)}
                      className={cn(
                        "h-9 rounded-lg bg-transparent px-2 text-sm tabular-nums text-ink outline-none",
                        invalidRing,
                      )}
                    />
                    <span className="text-xs text-ink/30">–</span>
                    <input
                      type="time"
                      aria-label={a.closes}
                      aria-invalid={!!dayError(day)}
                      value={day.closes}
                      onChange={(e) => updateDay(day.weekday, { closes: e.target.value })}
                      onBlur={() => saveDay(day.weekday)}
                      className={cn(
                        "h-9 rounded-lg bg-transparent px-2 text-sm tabular-nums text-ink outline-none",
                        invalidRing,
                      )}
                    />
                  </div>
                )}

                <button
                  role="switch"
                  aria-checked={!day.closed}
                  aria-label={t.availability.weekdays[day.weekday]}
                  onClick={() => {
                    const next = { ...day, closed: !day.closed };
                    updateDay(day.weekday, { closed: next.closed });
                    if (!dayError(next)) run(() => saveBranchHours({ branchId, ...next }));
                  }}
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                      touchTargetSwitch,
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

                {!day.closed && dayError(day) ? (
                  <span role="alert" className="order-last basis-full text-start text-xs text-red">
                    {dayError(day)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        {/* Chairs */}
        <Card>
          <CardHeader title={t.availability.stations} subtitle={`${stations.filter((s) => s.active).length}`} />
          {stations.length === 0 ? (
            <p className="px-5 py-4 text-start text-xs text-ink/45">{t.availability.noStations}</p>
          ) : null}
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
                  onClick={() => run(() => setStationActive(s.id, !s.active), `station:${s.id}`)}
                  disabled={busyOn(`station:${s.id}`)}
                  aria-busy={busyOn(`station:${s.id}`) || undefined}
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
                      touchTargetSwitch,
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
                  onClick={() => askDelete({ kind: "station", id: s.id, name: s.label })}
                  className={`relative grid h-7 w-7 place-items-center rounded-lg text-ink/30 transition-colors hover:bg-red/[0.06] hover:text-red ${touchTargetSm}`}
                  aria-label={t.catalog.delete}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-start gap-2 border-t border-black/[0.06] p-4">
            <div className="flex-1">
              <TextField
                label={a.stationLabel}
                {...CHAIR_TEXT}
                max={CHAIR_MAX}
                error={stationError}
                value={newStation}
                onChange={setNewStation}
              />
            </div>
            <Button
              size="md"
              className="mt-6"
              pending={busyOn("add-station")}
              onClick={() => {
                setStationTried(true);
                if (checkStation()) return focusFirstInvalid();
                run(() => addStation(branchId, newStation.trim()), "add-station");
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
        <Card className="lg:col-span-2">
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
                    onClick={() => askDelete({ kind: "closure", id: c.id, name: dayRange(from, to) })}
                    className={`relative grid h-7 w-7 place-items-center rounded-lg text-ink/30 transition-colors hover:bg-red/[0.06] hover:text-red ${touchTargetSm}`}
                    aria-label={t.catalog.delete}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </li>
                );
              })}
            </ul>
          )}
          <div className="grid grid-cols-1 items-start gap-3 border-t border-black/[0.06] p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_auto]">
            <Field label={a.from} error={closureErrors.from}>
              <Input
                type="date"
                min={earliest}
                max={latest}
                aria-invalid={!!closureErrors.from}
                value={closure.from}
                onChange={(e) => setClosure((c) => ({ ...c, from: e.target.value }))}
              />
            </Field>
            <Field label={a.to} error={closureErrors.to}>
              <Input
                type="date"
                min={closure.from || earliest}
                max={latest}
                aria-invalid={!!closureErrors.to}
                value={closure.to}
                onChange={(e) => setClosure((c) => ({ ...c, to: e.target.value }))}
              />
            </Field>
            <div className="sm:col-span-2 lg:col-span-1">
              <TextField
                label={a.reason}
                {...CLOSURE_TEXT}
                max={CLOSURE_LIMITS.reasonMax}
                error={closureErrors.reason}
                value={closure.reasonAr}
                onChange={(reasonAr) => setClosure((c) => ({ ...c, reasonAr }))}
              />
            </div>
            <Button
              size="md"
              className="justify-self-start lg:mt-6"
              pending={busyOn("add-closure")}
              onClick={() => {
                setClosureTried(true);
                if (hasErrors(checkClosureForm())) return focusFirstInvalid();
                run(() => addClosure({ branchId, ...closure, reasonAr: closure.reasonAr.trim() }), "add-closure");
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

      <ConfirmDialog
        open={!!doomed}
        title={t.common.deleteNamed(doomed?.name ?? "")}
        body={doomed?.kind === "station" ? t.common.stationDeleteBody : t.common.closureDeleteBody}
        pending={deleting}
        error={deleteError}
        onClose={() => setDoomed(null)}
        onConfirm={confirmDelete}
      />
    </>
  );
}
