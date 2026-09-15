"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button, FormErrors } from "@/components/admin/ui";
import { ConfirmDialog, Drawer } from "@/components/admin/overlays";
import MediaPicker from "@/components/admin/MediaPicker";
import { pick } from "@/lib/localized";
import { useAdminI18n } from "@/lib/admin/i18n";
import { NumberField, TextPair } from "@/components/admin/TextField";
import { arScript, collect, DESC_MAX, focusFirstInvalid, hasErrors, NAME_MAX, rules } from "@/lib/admin/validate";
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
  // Blank, not "0" and "60": a pre-filled box is never empty, so Save would
  // accept a free, hour-long service nobody actually priced or timed.
  priceSar: "",
  durationMin: "",
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
  const { t, lang } = useAdminI18n();
  const [form, setForm] = useState<FormState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [pending, startTransition] = useTransition();
  // Its own state rather than a field on the form: this is a list, and the
  // form holds scalars.
  const [designs, setDesigns] = useState<DesignRow[]>([]);

  // Reload the form whenever the drawer opens on a different row.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTried(false);
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
        : empty,
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
  //
  // Anything but "0" counts as ticked, so clearing the box to retype it keeps
  // the box on screen (and asks for a number) instead of unticking under her.
  const hasRefill = form.refillDays !== "0";

  // Remembered so unticking and re-ticking does not lose the length that was
  // typed — an accidental click should cost nothing.
  const lastRefillDays = useRef<string | null>(null);
  if (hasRefill) lastRefillDays.current = form.refillDays;

  const title = row
    ? kind === "service"
      ? t.catalog.editService
      : kind === "addon"
        ? t.catalog.editAddon
        : kind === "upsell"
          ? t.catalog.editUpsell
          : t.catalog.editRemoval
    : kind === "service"
      ? t.catalog.newService
      : kind === "addon"
        ? t.catalog.newAddon
        : kind === "upsell"
          ? t.catalog.newUpsell
          : t.catalog.newRemoval;

  const r = rules(t.validation);
  const priceLabel = `${t.catalog.price} (${t.common.riyal})`;
  const offersDesigns = kind === "addon" && form.isSeasonal;
  const check = () =>
    collect({
      nameAr: r.text(t.catalog.nameAr, form.nameAr, { min: 2, max: NAME_MAX, script: arScript(form.nameAr, form.nameEn) }),
      nameEn: r.text(t.catalog.nameEn, form.nameEn, { min: 2, max: NAME_MAX, script: "en" }),
      descAr:
        kind === "service" &&
        r.text(t.catalog.descAr, form.descAr, { required: false, max: DESC_MAX, script: arScript(form.descAr, form.descEn) }),
      descEn:
        kind === "service" &&
        r.text(t.catalog.descEn, form.descEn, { required: false, max: DESC_MAX, script: "en" }),
      priceSar: r.number(priceLabel, form.priceSar, { min: 0, max: 100_000, decimals: 2 }),
      // A service of 0 minutes would book a slot that ends as it starts. Add-ons
      // and removals may genuinely add no time.
      durationMin:
        kind !== "upsell" &&
        r.number(t.catalog.duration, form.durationMin, {
          int: true,
          min: kind === "service" ? 5 : 0,
          max: 600,
        }),
      refillDays:
        kind === "service" &&
        hasRefill &&
        r.number(t.catalog.refillDays, form.refillDays, { int: true, min: 1, max: 365 }),
      // A design row with anything in it needs both names; a blank row is
      // simply dropped on save.
      ...(offersDesigns
        ? Object.fromEntries(
            designs.flatMap((d, i) => {
              if (!d.name.ar.trim() && !d.name.en.trim() && !d.image) return [];
              const prefix = `${t.catalog.designs} ${i + 1} · `;
              return [
                [`design${i}ar`, r.text(prefix + t.catalog.nameAr, d.name.ar, { max: NAME_MAX, script: arScript(d.name.ar, d.name.en) })],
                [`design${i}en`, r.text(prefix + t.catalog.nameEn, d.name.en, { max: NAME_MAX, script: "en" })],
              ];
            }),
          )
        : {}),
    });
  const errors = tried ? check() : {};

  const save = () =>
    startTransition(async () => {
      setError(null);
      setTried(true);
      if (hasErrors(check())) return focusFirstInvalid();
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
                .filter((d) => d.name.ar.trim() || d.name.en.trim() || d.image)
                .map((d) => ({ id: d.id, name: d.name, image: d.image ?? null }))
            : undefined,
        active: form.active,
        sort: row?.sort ?? nextSort,
      });
      if (res.ok) onSaved();
      else setError(res.error === "not-found" ? t.validation.notFound : t.common.error);
    });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const remove = () =>
    startTransition(async () => {
      if (!row) return;
      setDeleteError(null);
      const res = await deleteCatalogItem(kind, row.id);
      if (res.ok) return onSaved();
      // A service with booking history can't be deleted (FK restrict) — that
      // would erase what a customer actually bought. Deactivating is the answer.
      setDeleteError(res.error === "in-use" ? t.catalog.inUseCannotDelete : t.common.error);
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
          <TextPair
            labels={[t.catalog.descAr, t.catalog.descEn]}
            long
            max={DESC_MAX}
            errors={[errors.descAr, errors.descEn]}
            values={[form.descAr, form.descEn]}
            onChange={[(v) => set("descAr", v), (v) => set("descEn", v)]}
          />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            label={priceLabel}
            error={errors.priceSar}
            maxDigits={6}
            decimals={2}
            value={form.priceSar}
            onChange={(v) => set("priceSar", v)}
          />
          {/* Not asked of an upsell: it is chosen after the chair has been
              quoted, so it takes no time on it. The action forces 0. */}
          {kind === "upsell" ? null : (
            <NumberField
              label={t.catalog.duration}
              hint={t.catalog.durationHint}
              error={errors.durationMin}
              maxDigits={3}
              value={form.durationMin}
              onChange={(v) => set("durationMin", v)}
            />
          )}
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
                  set("refillDays", e.target.checked ? (lastRefillDays.current || "30") : "0")
                }
                className="h-4 w-4 accent-red"
              />
              {t.catalog.hasRefill}
            </label>
            <p className="mt-1 text-start text-[11px] text-ink/40">{t.catalog.hasRefillHint}</p>

            {hasRefill ? (
              <div className="mt-3">
                <NumberField
                  label={t.catalog.refillDays}
                  hint={t.catalog.refillDaysHint}
                  error={errors.refillDays}
                  maxDigits={3}
                  value={form.refillDays}
                  onChange={(v) => set("refillDays", v)}
                />
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
                    <TextPair
                      className="grid min-w-[180px] flex-1 gap-2 sm:grid-cols-2"
                      labels={[t.catalog.nameAr, t.catalog.nameEn]}
                      max={NAME_MAX}
                      errors={[errors[`design${i}ar`], errors[`design${i}en`]]}
                      values={[d.name.ar, d.name.en]}
                      onChange={[
                        (ar) => setDesign(i, { name: { ...d.name, ar } }),
                        (en) => setDesign(i, { name: { ...d.name, en } }),
                      ]}
                    />
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

        <FormErrors errors={errors} summary={t.validation.summary} server={error} />

        <ConfirmDialog
          open={confirmDelete}
          title={t.common.deleteNamed(row ? pick(row.name, lang) : "")}
          body={t.common.cannotUndo}
          pending={pending}
          error={deleteError}
          onClose={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
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
