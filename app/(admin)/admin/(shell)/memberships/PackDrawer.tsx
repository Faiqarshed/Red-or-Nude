"use client";

// Building a pack: what it is called, what it costs, how long it lasts, and —
// the part that is only here — which services are in it and how many of each.
//
// The lines are the pack. So they are a list you add to and take from rather
// than a fixed grid: the client asked for it to be up to the salon how much
// goes in, and a form that decides that in advance is the wrong form.

import { useState, useTransition } from "react";
import { AlertTriangle, Minus, Plus, Trash2 } from "lucide-react";
import { Button, FormErrors, invalidRing } from "@/components/admin/ui";
import { ConfirmDialog, Drawer } from "@/components/admin/overlays";
import MediaPicker from "@/components/admin/MediaPicker";
import { NumberField, TextPair } from "@/components/admin/TextField";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import { TIMEZONE } from "@/lib/time";
import { arScript, collect, DESC_MAX, focusFirstInvalid, hasErrors, NAME_MAX, rules } from "@/lib/admin/validate";
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
  const validDaysError = r.number(t.packs.validDays, form.validDays, { int: true, min: 1, max: 730 });
  const check = () =>
    collect({
      nameAr: r.text(t.catalog.nameAr, form.nameAr, { min: 2, max: NAME_MAX, script: arScript(form.nameAr, form.nameEn) }),
      nameEn: r.text(t.catalog.nameEn, form.nameEn, { min: 2, max: NAME_MAX, script: "en" }),
      descAr: r.text(t.catalog.descAr, form.descAr, { required: false, max: DESC_MAX, script: arScript(form.descAr, form.descEn) }),
      descEn: r.text(t.catalog.descEn, form.descEn, { required: false, max: DESC_MAX, script: "en" }),
      lines:
        lines.length === 0
          ? t.packs.needsServices
          : lines.length > 30 && t.validation.max(t.packs.contents, 30),
      priceSar: r.number(priceLabel, form.priceSar, { positive: true, max: 100_000, decimals: 2 }),
      validDays: validDaysError,
    });
  const errors = tried ? check() : {};

  // The validity hint follows what is typed: "That's 3 months. Bought today, it
  // runs until 14 Dec 2026". The static line until the number is a valid one.
  const validHint = (() => {
    if (validDaysError) return t.packs.validDaysHint;
    const n = Number(form.validDays);
    const locale = lang === "ar" ? "ar-u-nu-latn" : "en-GB";
    const unit = (u: "week" | "month" | "year", v: number) =>
      new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "long", maximumFractionDigits: 1 }).format(v);
    // Whole years, months or weeks when it divides evenly; otherwise roughly
    // months from 30 days up. Under that, the days in the box say it already.
    const [span, approx] =
      n % 365 === 0 ? [unit("year", n / 365), false]
      : n % 30 === 0 ? [unit("month", n / 30), false]
      : n % 7 === 0 ? [unit("week", n / 7), false]
      : n > 30 ? [unit("month", Math.round((n / 30) * 10) / 10), true]
      : [null, false];
    // Same arithmetic as buyPack in lib/packs.ts, so the date shown is the one she'd get.
    const until = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: TIMEZONE }).format(
      new Date(Date.now() + n * 86_400_000),
    );
    return t.packs.validDaysLive(span, approx, until);
  })();

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

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const remove = () =>
    startTransition(async () => {
      if (!row) return;
      setDeleteError(null);
      const res = await deletePack(row.id);
      if (res.ok) return onSaved();
      setDeleteError(t.common.error);
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
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
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
        <TextPair
          labels={[t.catalog.nameAr, t.catalog.nameEn]}
          max={NAME_MAX}
          errors={[errors.nameAr, errors.nameEn]}
          values={[form.nameAr, form.nameEn]}
          onChange={[(v) => set("nameAr", v), (v) => set("nameEn", v)]}
        />

        {missingAr ? (
          <p className="flex items-start gap-1.5 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {t.catalog.missingAr}
          </p>
        ) : null}

        <TextPair
          labels={[t.catalog.descAr, t.catalog.descEn]}
          long
          max={DESC_MAX}
          errors={[errors.descAr, errors.descEn]}
          values={[form.descAr, form.descEn]}
          onChange={[(v) => set("descAr", v), (v) => set("descEn", v)]}
        />

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
          <NumberField
            label={priceLabel}
            error={errors.priceSar}
            maxDigits={6}
            decimals={2}
            value={form.priceSar}
            onChange={(v) => set("priceSar", v)}
          />
          <NumberField
            label={t.packs.validDays}
            hint={validHint}
            error={errors.validDays}
            maxDigits={3}
            value={form.validDays}
            onChange={(v) => set("validDays", v)}
          />
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

        <ConfirmDialog
          open={confirmDelete}
          title={t.common.deleteNamed(row ? row.name[lang] : "")}
          body={t.common.packDeleteBody}
          pending={pending}
          error={deleteError}
          onClose={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      </div>
    </Drawer>
  );
}
