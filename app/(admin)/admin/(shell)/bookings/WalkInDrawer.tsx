"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Field, Input } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import { createWalkIn } from "./actions";
import type { CatalogOption } from "./BookingsView";

type Slot = { time: string; startsAt: string; available: boolean };

export default function WalkInDrawer({
  open,
  branchId,
  date,
  catalog,
  onClose,
  onCreated,
}: {
  open: boolean;
  branchId: string;
  date: string;
  catalog: { services: CatalogOption[]; addons: CatalogOption[]; removals: CatalogOption[] };
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t, lang } = useAdminI18n();
  const [serviceId, setServiceId] = useState<string>("");
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [removalId, setRemovalId] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setServiceId(catalog.services[0]?.id ?? "");
    setAddonIds([]);
    setRemovalId("");
    setPhone("");
    setName("");
    setStartsAt(null);
    setError(null);
  }, [open, catalog.services]);

  // Duration drives which slots actually fit, so it has to be recomputed as the
  // receptionist adds extras — same rule the customer-facing flow follows.
  const durationMin =
    (catalog.services.find((s) => s.id === serviceId)?.durationMin ?? 60) +
    addonIds.reduce((sum, id) => sum + (catalog.addons.find((a) => a.id === id)?.durationMin ?? 0), 0) +
    (catalog.removals.find((r) => r.id === removalId)?.durationMin ?? 0);

  useEffect(() => {
    if (!open || !branchId || !serviceId) return;
    let cancelled = false;
    setSlots(null);
    setStartsAt(null);
    fetch(`/api/availability?branchId=${branchId}&date=${date}&duration=${durationMin}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setSlots(d.slots ?? []))
      .catch(() => !cancelled && setSlots([]));
    return () => {
      cancelled = true;
    };
  }, [open, branchId, date, durationMin, serviceId]);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      if (!startsAt) return setError(t.bookings.pickTime);
      const res = await createWalkIn({
        branchId,
        serviceId,
        addonIds,
        removalTypeId: removalId || null,
        startsAt,
        name: name.trim() || undefined,
        phone: phone.trim(),
      });
      if (res.ok) onCreated();
      else setError(res.error === "slot-taken" ? t.bookings.slotTaken : t.common.error);
    });

  const total =
    (catalog.services.find((s) => s.id === serviceId)?.priceSar ?? 0) +
    addonIds.reduce((sum, id) => sum + (catalog.addons.find((a) => a.id === id)?.priceSar ?? 0), 0) +
    (catalog.removals.find((r) => r.id === removalId)?.priceSar ?? 0);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t.bookings.walkIn}
      footer={
        <>
          <span className="me-auto text-sm font-semibold tabular-nums text-ink">
            {total.toLocaleString("en-US")}
            <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button size="sm" onClick={submit} disabled={pending || !phone.trim() || !startsAt}>
            {pending ? t.common.saving : t.bookings.create}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label={t.bookings.customer}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.bookings.optional} />
        </Field>

        <Field label={`${t.bookings.phone} *`}>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            dir="ltr"
            inputMode="tel"
            placeholder="05XXXXXXXX"
            className="text-left"
          />
        </Field>

        <Field label={t.bookings.service}>
          <select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            className="h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink outline-none focus:border-sky"
          >
            {catalog.services.map((s) => (
              <option key={s.id} value={s.id}>
                {pick(s.name, lang)} · {s.priceSar} · {s.durationMin}m
              </option>
            ))}
          </select>
        </Field>

        <div className="text-start">
          <span className="mb-1.5 block text-xs font-medium text-ink/70">{t.bookings.addons}</span>
          <div className="flex flex-wrap gap-2">
            {catalog.addons.map((a) => {
              const on = addonIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() =>
                    setAddonIds((prev) => (on ? prev.filter((x) => x !== a.id) : [...prev, a.id]))
                  }
                  className={cn(
                    "rounded-xl border px-3 py-1.5 text-xs transition-colors",
                    on ? "border-red bg-red/[0.07] text-red" : "border-black/10 text-ink/70 hover:bg-black/[0.03]",
                  )}
                >
                  {pick(a.name, lang)}
                </button>
              );
            })}
          </div>
        </div>

        <Field label={t.bookings.removal}>
          <select
            value={removalId}
            onChange={(e) => setRemovalId(e.target.value)}
            className="h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink outline-none focus:border-sky"
          >
            <option value="">{t.common.none}</option>
            {catalog.removals.map((r) => (
              <option key={r.id} value={r.id}>
                {pick(r.name, lang)} · {r.priceSar}
              </option>
            ))}
          </select>
        </Field>

        <div className="text-start">
          <span className="mb-1.5 block text-xs font-medium text-ink/70">
            {t.bookings.time} · {durationMin} {t.catalog.minutes}
          </span>
          {slots === null ? (
            <p className="py-4 text-center text-xs text-ink/40">{t.common.loading}</p>
          ) : slots.length === 0 ? (
            <p className="py-4 text-center text-xs text-ink/45">{t.bookings.noSlots}</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {slots.map((s) => (
                <button
                  key={s.time}
                  type="button"
                  dir="ltr"
                  disabled={!s.available}
                  onClick={() => setStartsAt(s.startsAt)}
                  className={cn(
                    "rounded-lg py-2 text-xs tabular-nums transition-colors",
                    startsAt === s.startsAt
                      ? "bg-red font-semibold text-white"
                      : s.available
                        ? "bg-black/[0.04] text-ink hover:bg-red/10"
                        : "cursor-not-allowed bg-black/[0.02] text-ink/25 line-through",
                  )}
                >
                  {s.time}
                </button>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <p role="alert" className="rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  );
}
