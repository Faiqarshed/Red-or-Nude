"use client";

// Building a pack: what it is called, what it costs, how long it lasts, and —
// the part that is only here — which services are in it and how many of each.
//
// The lines are the pack. So they are a list you add to and take from rather
// than a fixed grid: the client asked for it to be up to the salon how much
// goes in, and a form that decides that in advance is the wrong form.

import { useState, useTransition } from "react";
import { AlertTriangle, Minus, Plus, Trash2 } from "lucide-react";
import { Button, Field, FormErrors, Input, invalidRing } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import MediaPicker from "@/components/admin/MediaPicker";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import { collect, focusFirstInvalid, hasErrors, rules } from "@/lib/admin/validate";
import type { PackLine, PackRow, ServiceOption } from "./PacksView";
import { deletePack, savePack } from "./actions";

export default function PackDrawer({
  row,
  services,
  nextSort,
  onClose,
  onSaved,
}: {
  row: PackRow | null;
  services: ServiceOption[];
  nextSort: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useAdminI18n();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const [form, setForm] = useState({
    nameAr: row?.name.ar ?? "",
    nameEn: row?.name.en ?? "",
    descAr: row?.description?.ar ?? "",
    descEn: row?.description?.en ?? "",
    priceSar: row ? String(row.priceSar) : "",
    // Three months, unless this pack is deliberately something else.
    validDays: String(row?.validDays ?? 90),
    image: row?.image ?? null,
    active: row?.active ?? true,
  });
  const [lines, setLines] = useState<PackLine[]>(row?.lines ?? []);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const addLine = (serviceId: string) => {
    if (!serviceId) return;
    // Already in? Bump it rather than adding a second row that would lose the
    // fight over the primary key on save.
    setLines((prev) =>
      prev.some((l) => l.serviceId === serviceId)
        ? prev.map((l) => (l.serviceId === serviceId ? { ...l, quantity: l.quantity + 1 } : l))
        : [...prev, { serviceId, quantity: 1 }],
    );
  };

  const bump = (serviceId: string, by: number) =>
    setLines((prev) =>
      prev.flatMap((l) => {
        if (l.serviceId !== serviceId) return [l];
        const quantity = l.quantity + by;
        // Down to nothing is the same as taking it out, which saves the salon
        // hunting for a separate remove button for the common case.
        return quantity <= 0 ? [] : [{ ...l, quantity }];
      }),
    );

  const nameOf = (id: string) => services.find((s) => s.id === id)?.name[lang] ?? id;
  const priceOf = (id: string) => services.find((s) => s.id === id)?.priceSar ?? 0;

  const uses = lines.reduce((sum, l) => sum + l.quantity, 0);
  const listPrice = lines.reduce((sum, l) => sum + priceOf(l.serviceId) * l.quantity, 0);
  const price = Number(form.priceSar) || 0;
  const saving = listPrice - price;

  const missingAr = form.nameAr.trim() !== "" && form.nameAr.trim() === form.nameEn.trim();

  const r = rules(t.validation);
  const priceLabel = `${t.catalog.price} (${t.common.riyal})`;
  const check = () =>
    collect({
      nameAr: r.text(t.catalog.nameAr, form.nameAr, { max: 120 }),
      nameEn: r.text(t.catalog.nameEn, form.nameEn, { max: 120 }),
      descAr: r.text(t.catalog.descAr, form.descAr, { required: false, max: 400 }),
      descEn: r.text(t.catalog.descEn, form.descEn, { required: false, max: 400 }),
      lines:
        lines.length === 0
          ? t.packs.needsServices
          : lines.length > 30 && t.validation.max(t.packs.contents, 30),
      priceSar: r.number(priceLabel, form.priceSar, { min: 0, max: 100_000 }),
      validDays: r.number(t.packs.validDays, form.validDays, { int: true, min: 1, max: 730 }),
    });
  const errors = tried ? check() : {};

  const save = () =>
    startTransition(async () => {
      setError(null);
      setTried(true);
      if (hasErrors(check())) return focusFirstInvalid();
      const res = await savePack({
        id: row?.id,
        name: { ar: form.nameAr.trim(), en: form.nameEn.trim() },
        description: { ar: form.descAr.trim(), en: form.descEn.trim() },
        priceSar: form.priceSar,
        validDays: form.validDays,
        image: form.image,
        active: form.active,
        sort: row?.sort ?? nextSort,
        lines,
      });
      if (res.ok) onSaved();
      else
        setError(
          res.error === "no-services"
            ? t.packs.needsServices
            : res.error === "not-found"
              ? t.validation.notFound
              : t.common.error,
        );
    });

  const remove = () =>
    startTransition(async () => {
      if (!row) return;
      const res = await deletePack(row.id);
      if (res.ok) onSaved();
      else setError(t.common.error);
    });

  return (
    <Drawer
      open
      onClose={onClose}
      title={row ? t.packs.editPack : t.packs.newPack}
      footer={
        <>
          {row ? (
            <button
              onClick={remove}
              disabled={pending}
              className="me-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-red transition-colors hover:bg-red/[0.06] disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t.catalog.delete}
            </button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? t.common.saving : t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.catalog.nameAr} error={errors.nameAr}>
            <Input
              dir="rtl"
              aria-invalid={!!errors.nameAr}
              value={form.nameAr}
              onChange={(e) => set("nameAr", e.target.value)}
            />
          </Field>
          <Field label={t.catalog.nameEn} error={errors.nameEn}>
            <Input
              dir="ltr"
              className="text-left"
              aria-invalid={!!errors.nameEn}
              value={form.nameEn}
              onChange={(e) => set("nameEn", e.target.value)}
            />
          </Field>
        </div>

        {missingAr ? (
          <p className="flex items-start gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {t.catalog.missingAr}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.catalog.descAr} error={errors.descAr}>
            <Input
              dir="rtl"
              aria-invalid={!!errors.descAr}
              value={form.descAr}
              onChange={(e) => set("descAr", e.target.value)}
            />
          </Field>
          <Field label={t.catalog.descEn} error={errors.descEn}>
            <Input
              dir="ltr"
              className="text-left"
              aria-invalid={!!errors.descEn}
              value={form.descEn}
              onChange={(e) => set("descEn", e.target.value)}
            />
          </Field>
        </div>

        {/* ---- what is in it -------------------------------------------- */}
        <div className="rounded-xl border border-black/[0.06] bg-white p-4">
          <p className="mb-1 text-sm font-medium text-ink">{t.packs.contents}</p>
          <p className="mb-3 text-[11px] text-ink/45">{t.packs.contentsHint}</p>

          {lines.length === 0 ? (
            <p className="rounded-lg bg-black/[0.02] px-3 py-4 text-center text-xs text-ink/40">
              {t.packs.noServicesYet}
            </p>
          ) : (
            <ul className="mb-3 divide-y divide-black/[0.05]">
              {lines.map((l) => (
                <li key={l.serviceId} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {nameOf(l.serviceId)}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink/40">
                    {(priceOf(l.serviceId) * l.quantity).toLocaleString("en-US")} {t.common.riyal}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => bump(l.serviceId, -1)}
                      title={t.packs.fewer}
                      className="grid h-6 w-6 place-items-center rounded-lg text-ink/45 transition-colors hover:bg-black/[0.05] hover:text-ink"
                    >
                      <Minus className="h-3.5 w-3.5" strokeWidth={2} />
                    </button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums text-ink">
                      {l.quantity}
                    </span>
                    <button
                      onClick={() => bump(l.serviceId, 1)}
                      title={t.packs.more}
                      disabled={l.quantity >= 99}
                      className="grid h-6 w-6 place-items-center rounded-lg text-ink/45 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-30"
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <select
            value=""
            aria-invalid={!!errors.lines}
            onChange={(e) => addLine(e.target.value)}
            className={cn(
              "w-full rounded-lg border border-black/[0.1] bg-white px-3 py-2 text-sm text-ink outline-none focus:border-red/40",
              invalidRing,
            )}
          >
            <option value="">{t.packs.addService}</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name[lang]}
                {s.active ? "" : ` — ${t.catalog.inactive}`}
              </option>
            ))}
          </select>
          {errors.lines ? <p className="mt-1 text-start text-xs text-red">{errors.lines}</p> : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={priceLabel} error={errors.priceSar}>
            <Input
              type="number"
              min={0}
              step="1"
              dir="ltr"
              className="text-left tabular-nums"
              aria-invalid={!!errors.priceSar}
              value={form.priceSar}
              onChange={(e) => set("priceSar", e.target.value)}
            />
          </Field>
          <Field label={t.packs.validDays} hint={t.packs.validDaysHint} error={errors.validDays}>
            <Input
              type="number"
              min={1}
              step="1"
              dir="ltr"
              className="text-left tabular-nums"
              aria-invalid={!!errors.validDays}
              value={form.validDays}
              onChange={(e) => set("validDays", e.target.value)}
            />
          </Field>
        </div>

        {/* The whole point of a pack, in one line: what it would cost one at a
            time, and what she saves. Shown while the price is being typed,
            because that is when it is being decided. */}
        {lines.length > 0 && (
          <p
            className={cn(
              "rounded-lg px-3 py-2 text-xs",
              saving > 0 ? "bg-[#1f7a4d]/[0.07] text-[#1f7a4d]" : "bg-amber-500/[0.08] text-amber-700",
            )}
          >
            {saving > 0
              ? t.packs.savings
                  .replace("{uses}", String(uses))
                  .replace("{list}", listPrice.toLocaleString("en-US"))
                  .replace("{saving}", saving.toLocaleString("en-US"))
              : t.packs.noSaving.replace("{list}", listPrice.toLocaleString("en-US"))}
          </p>
        )}

        <MediaPicker
          label={t.catalog.image}
          value={form.image}
          onChange={(path) => set("image", path)}
        />

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set("active", e.target.checked)}
            className="h-4 w-4 accent-red"
          />
          {t.catalog.active}
        </label>

        <FormErrors errors={errors} summary={t.validation.summary} server={error} />
      </div>
    </Drawer>
  );
}
