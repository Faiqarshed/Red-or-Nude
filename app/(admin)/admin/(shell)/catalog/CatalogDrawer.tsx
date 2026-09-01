"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button, Field, Input } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import MediaPicker from "@/components/admin/MediaPicker";
import { useAdminI18n } from "@/lib/admin/i18n";
import type { CatalogRow, DesignRow } from "./CatalogView";
import { deleteCatalogItem, saveCatalogItem, type CatalogKind } from "./actions";

type FormState = {
  nameAr: string;
  nameEn: string;
  descAr: string;
  descEn: string;
  priceSar: string;
  durationMin: string;
  refillDays: string;
  image: string | null;
  isSeasonal: boolean;
  active: boolean;
};

const empty: FormState = {
  nameAr: "",
  nameEn: "",
  descAr: "",
  descEn: "",
  priceSar: "0",
  durationMin: "60",
  refillDays: "0",
  image: null,
  isSeasonal: false,
  active: true,
};

export default function CatalogDrawer({
  kind,
  row,
  open,
  nextSort,
  onClose,
  onSaved,
}: {
  kind: CatalogKind;
  row: CatalogRow | null;
  open: boolean;
  nextSort: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useAdminI18n();
  const [form, setForm] = useState<FormState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Its own state rather than a field on the form: this is a list, and the
  // form holds scalars.
  const [designs, setDesigns] = useState<DesignRow[]>([]);

  // Reload the form whenever the drawer opens on a different row.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      row
        ? {
            nameAr: row.name.ar,
            nameEn: row.name.en,
            descAr: row.description?.ar ?? "",
            descEn: row.description?.en ?? "",
            priceSar: String(row.priceSar),
            durationMin: String(row.durationMin),
            refillDays: String(row.refillDays ?? 0),
            image: row.image ?? null,
            isSeasonal: row.isSeasonal ?? false,
            active: row.active,
          }
        : { ...empty, durationMin: kind === "service" ? "60" : "15" },
    );
    setDesigns(row?.designs ?? []);
  }, [open, row, kind]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setDesign = (i: number, patch: Partial<DesignRow>) =>
    setDesigns((list) => list.map((d, x) => (x === i ? { ...d, ...patch } : d)));

  // Zero is still how "no refill" is stored — one number, and every reader of
  // it (lib/refill.ts, the reminder job, the customer's history) keeps working
  // unchanged. The tick is a way of asking the question, not a second field to
  // hold in sync with this one.
  const hasRefill = Number(form.refillDays) > 0;

  // Remembered so unticking and re-ticking does not lose the length that was
  // typed — an accidental click should cost nothing.
  const lastRefillDays = useRef<string | null>(null);
  if (hasRefill) lastRefillDays.current = form.refillDays;

  const title = row
    ? kind === "service"
      ? t.catalog.editService
      : kind === "addon"
        ? t.catalog.editAddon
        : t.catalog.editRemoval
    : kind === "service"
      ? t.catalog.newService
      : kind === "addon"
        ? t.catalog.newAddon
        : t.catalog.newRemoval;

  const save = () =>
    startTransition(async () => {
      setError(null);
      const res = await saveCatalogItem({
        kind,
        id: row?.id,
        name: { ar: form.nameAr.trim(), en: form.nameEn.trim() },
        description:
          kind === "service"
            ? { ar: form.descAr.trim(), en: form.descEn.trim() }
            : undefined,
        priceSar: form.priceSar,
        durationMin: form.durationMin,
        refillDays: kind === "service" ? form.refillDays : undefined,
        image: kind === "removal" ? null : form.image,
        isSeasonal: kind === "addon" ? form.isSeasonal : undefined,
        designs:
          kind === "addon" && form.isSeasonal
            ? designs
                .filter((d) => d.name.ar.trim() || d.name.en.trim())
                .map((d) => ({ id: d.id, name: d.name, image: d.image ?? null }))
            : undefined,
        active: form.active,
        sort: row?.sort ?? nextSort,
      });
      if (res.ok) onSaved();
      else setError(res.error === "save-failed" ? t.common.error : t.common.error);
    });

  const remove = () =>
    startTransition(async () => {
      if (!row) return;
      const res = await deleteCatalogItem(kind, row.id);
      if (res.ok) onSaved();
      // A service with booking history can't be deleted (FK restrict) — that
      // would erase what a customer actually bought. Deactivating is the answer.
      else setError(res.error === "in-use" ? t.catalog.inUseCannotDelete : t.common.error);
    });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
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
        {/* Side-by-side AR/EN, so a missing translation is visible rather than
            buried behind a language switch. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.catalog.nameAr}>
            <Input dir="rtl" value={form.nameAr} onChange={(e) => set("nameAr", e.target.value)} />
          </Field>
          <Field label={t.catalog.nameEn}>
            <Input
              dir="ltr"
              className="text-left"
              value={form.nameEn}
              onChange={(e) => set("nameEn", e.target.value)}
            />
          </Field>
        </div>

        {/* Flags rows where the seed copied English into the Arabic column
            because no Arabic name existed in lib/booking.ts. Some of these are
            brand terms that shouldn't be translated — hence a note, not a block. */}
        {form.nameEn && form.nameAr === form.nameEn ? (
          <p className="flex items-center gap-1.5 rounded-lg bg-[#b7791f]/12 px-3 py-2 text-start text-xs text-[#8a5a06]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {t.catalog.missingAr}
          </p>
        ) : null}

        {kind === "service" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.catalog.descAr}>
              <Input dir="rtl" value={form.descAr} onChange={(e) => set("descAr", e.target.value)} />
            </Field>
            <Field label={t.catalog.descEn}>
              <Input
                dir="ltr"
                className="text-left"
                value={form.descEn}
                onChange={(e) => set("descEn", e.target.value)}
              />
            </Field>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t.catalog.price} (${t.common.riyal})`}>
            <Input
              type="number"
              min={0}
              step="1"
              dir="ltr"
              className="text-left tabular-nums"
              value={form.priceSar}
              onChange={(e) => set("priceSar", e.target.value)}
            />
          </Field>
          <Field label={t.catalog.duration} hint={t.catalog.durationHint}>
            <Input
              type="number"
              min={0}
              step="5"
              dir="ltr"
              className="text-left tabular-nums"
              value={form.durationMin}
              onChange={(e) => set("durationMin", e.target.value)}
            />
          </Field>
        </div>

        {/* Services only: this is what makes the refill button appear in the
            customer's booking history, and for how long.

            A tick and a length, rather than a lone number where 0 quietly meant
            "none" — a rule you had to be told, and one that made an empty box
            and a deliberate "no refill" look identical. */}
        {kind === "service" ? (
          <div className="rounded-xl border border-black/[0.06] bg-white p-4">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={hasRefill}
                onChange={(e) =>
                  // Ticking restores the last length typed, or the usual 30,
                  // so nobody has to think about a number to answer "yes".
                  set("refillDays", e.target.checked ? (lastRefillDays.current ?? "30") : "0")
                }
                className="h-4 w-4 accent-red"
              />
              {t.catalog.hasRefill}
            </label>
            <p className="mt-1 text-start text-[11px] text-ink/40">{t.catalog.hasRefillHint}</p>

            {hasRefill ? (
              <div className="mt-3">
                <Field label={t.catalog.refillDays} hint={t.catalog.refillDaysHint}>
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    step="1"
                    dir="ltr"
                    className="text-left tabular-nums"
                    value={form.refillDays}
                    onChange={(e) => set("refillDays", e.target.value)}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        ) : null}

        {kind !== "removal" ? (
          <MediaPicker
            label={t.catalog.image}
            value={form.image}
            onChange={(path) => set("image", path)}
          />
        ) : null}

        <div className="space-y-3 border-t border-black/[0.06] pt-4">
          {kind === "addon" ? (
            <Toggle
              label={t.catalog.seasonal}
              hint={t.catalog.seasonalHint}
              checked={form.isSeasonal}
              onChange={(v) => set("isSeasonal", v)}
            />
          ) : null}

          {/* There is no single seasonal catalogue: a winter set and a chrome
              set are two add-ons with two sets of pictures. So the pictures
              live on the add-on that shows them, edited here rather than on a
              screen of their own — the salon is describing one product, and
              its designs are part of that description. */}
          {kind === "addon" && form.isSeasonal ? (
            <div className="rounded-xl border border-black/[0.06] bg-white p-4">
              <p className="mb-1 text-start text-xs font-medium text-ink/70">
                {t.catalog.designs}
              </p>
              <p className="mb-3 text-start text-xs text-ink/45">{t.catalog.designsHint}</p>

              <div className="space-y-3">
                {designs.map((d, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-3 border-t border-black/[0.05] pt-3 first:border-0 first:pt-0">
                    <div className="grid min-w-[180px] flex-1 gap-2 sm:grid-cols-2">
                      <Field label={t.catalog.nameAr}>
                        <Input
                          value={d.name.ar}
                          onChange={(e) => setDesign(i, { name: { ...d.name, ar: e.target.value } })}
                        />
                      </Field>
                      <Field label={t.catalog.nameEn}>
                        <Input
                          dir="ltr"
                          className="text-left"
                          value={d.name.en}
                          onChange={(e) => setDesign(i, { name: { ...d.name, en: e.target.value } })}
                        />
                      </Field>
                    </div>
                    <div className="min-w-[160px]">
                      <MediaPicker
                        label={t.catalog.image}
                        value={d.image ?? null}
                        onChange={(path) => setDesign(i, { image: path })}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setDesigns(designs.filter((_, x) => x !== i))}
                      className="h-10 rounded-xl px-3 text-xs font-medium text-red transition-colors hover:bg-red/[0.06]"
                    >
                      {t.catalog.delete}
                    </button>
                  </div>
                ))}
              </div>

              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() =>
                  setDesigns([...designs, { name: { ar: "", en: "" }, image: null }])
                }
              >
                {t.catalog.addDesign}
              </Button>
            </div>
          ) : null}
          <Toggle
            label={t.catalog.active}
            hint={t.catalog.activeHint}
            checked={form.active}
            onChange={(v) => set("active", v)}
          />
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

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-start">
        <p className="text-xs font-medium text-ink">{label}</p>
        {hint ? <p className="mt-0.5 text-[11px] text-ink/45">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky ${
          checked ? "bg-[#1f7a4d]" : "bg-black/15"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? "end-0.5" : "start-0.5"
          }`}
        />
      </button>
    </div>
  );
}
