"use client";

import { useState, useTransition } from "react";
import { Ticket } from "lucide-react";
import { Badge, Button, Card, EmptyState, Field, FormErrors, Input, PageHeader } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import { NumberField } from "@/components/admin/TextField";
import { collect, focusFirstInvalid, hasErrors, rules } from "@/lib/admin/validate";
import { formatDateTime } from "@/lib/time";
import { savePromoCode, setPromoActive } from "./actions";

export type PromoRow = {
  id: string;
  code: string;
  type: "percent" | "fixed";
  /** Percent points, or riyals when fixed. */
  value: number;
  minTotalSar: number;
  startsAt: string | null;
  endsAt: string | null;
  maxUses: number | null;
  uses: number;
  active: boolean;
};

/**
 * `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time with no zone; the row
 * carries ISO in UTC. It has to be converted both ways. Slicing the ISO string
 * showed the UTC clock as if it were local, and toIso then read it back as
 * local, so every save moved the window three hours earlier in Riyadh.
 */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);
const past = (iso: string | null) => !!iso && new Date(iso) <= new Date();

/** The form's copy of a code: number boxes hold what is typed, as text. */
type Draft = Omit<PromoRow, "value" | "minTotalSar" | "maxUses"> & {
  value: string;
  minTotalSar: string;
  maxUses: string;
};

const toDraft = (row: PromoRow): Draft => ({
  ...row,
  value: String(row.value),
  minTotalSar: String(row.minTotalSar),
  maxUses: row.maxUses === null ? "" : String(row.maxUses),
});

const blank = (): Draft => ({
  id: "",
  code: "",
  type: "percent",
  value: "10",
  minTotalSar: "0",
  startsAt: null,
  endsAt: null,
  maxUses: "",
  uses: 0,
  active: true,
});

export default function PromoCodesView({ rows }: { rows: PromoRow[] }) {
  const { t, lang } = useAdminI18n();
  const p = t.promoCodes;

  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [pending, startTransition] = useTransition();

  const open = (draft: Draft) => {
    setError(null);
    setTried(false);
    setEditing(draft);
  };

  const r = rules(t.validation);
  const valueLabel = editing?.type === "percent" ? p.percentValue : p.fixedValue;
  const check = () => {
    if (!editing) return {};
    const code = editing.code.trim();
    // A date already in the past is only refused when it is being set now. An
    // old code that already started, or simply ran out, can still be opened
    // and switched off without retyping its dates.
    const stored = rows.find((row) => row.id === editing.id);
    const startMoved = !stored || stored.startsAt !== editing.startsAt;
    const endMoved = !stored || stored.endsAt !== editing.endsAt;
    return collect({
      code:
        r.text(p.code, code, { min: 3, max: 40 }) ||
        (!/^[A-Za-z0-9]+$/.test(code) && p.errors["code-format"]),
      value:
        editing.type === "percent"
          ? r.number(valueLabel, editing.value, { int: true, positive: true, max: 100 })
          : r.number(valueLabel, editing.value, { positive: true, max: 100_000, decimals: 2 }),
      minTotalSar: r.number(p.minTotal, editing.minTotalSar, { min: 0, max: 100_000, decimals: 2 }),
      startsAt: startMoved && past(editing.startsAt) && p.errors["starts-past"],
      endsAt:
        editing.startsAt && editing.endsAt && editing.endsAt <= editing.startsAt
          ? p.errors["bad-window"]
          : past(editing.endsAt)
            ? endMoved
              ? p.errors["ends-past"]
              : // Its end has passed and is unchanged: fine to save switched off,
                // not switched on.
                editing.active && p.errors.expired
            : undefined,
      maxUses: r.number(p.maxUses, editing.maxUses, { required: false, int: true, min: 1, max: 1_000_000 }),
    });
  };
  const errors = tried ? check() : {};

  const save = () => {
    if (!editing) return;
    startTransition(async () => {
      setError(null);
      setTried(true);
      if (hasErrors(check())) return focusFirstInvalid();
      const res = await savePromoCode({
        id: editing.id || undefined,
        code: editing.code,
        type: editing.type,
        value: Number(editing.value),
        minTotalSar: Number(editing.minTotalSar || 0),
        startsAt: editing.startsAt,
        endsAt: editing.endsAt,
        maxUses: editing.maxUses ? Number(editing.maxUses) : null,
        active: editing.active,
      });
      if (res.ok) setEditing(null);
      else setError(p.errors[res.error as keyof typeof p.errors] ?? t.common.error);
    });
  };

  // Its refusal used to vanish; now it says why, above the list.
  const [listError, setListError] = useState<string | null>(null);
  const toggle = (row: PromoRow) =>
    startTransition(async () => {
      setListError(null);
      const res = await setPromoActive(row.id, !row.active);
      if (!res.ok) setListError(p.errors[res.error as keyof typeof p.errors] ?? t.common.error);
    });

  return (
    <>
      <PageHeader
        title={p.title}
        subtitle={p.subtitle}
        action={<Button onClick={() => open(blank())}>{p.newCode}</Button>}
      />

      {listError ? (
        <p role="alert" className="mb-4 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
          {listError}
        </p>
      ) : null}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={p.empty}
            body={p.emptyBody}
            icon={<Ticket className="h-8 w-8" strokeWidth={1.25} />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.015]">
                  {[p.code, p.discount, p.minTotal, p.window, p.used, ""].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-black/[0.04] last:border-0 hover:bg-black/[0.015]"
                  >
                    <td className="px-4 py-3 text-start">
                      <span className="font-semibold text-ink" dir="ltr">
                        {row.code}
                      </span>
                      {past(row.endsAt) ? (
                        <Badge tone="warning" className="ms-2">
                          {p.expiredBadge}
                        </Badge>
                      ) : !row.active ? (
                        <Badge tone="neutral" className="ms-2">
                          {p.inactive}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-start tabular-nums text-ink">
                      {row.type === "percent" ? `${row.value}%` : `${row.value} ${p.sar}`}
                    </td>
                    <td className="px-4 py-3 text-start tabular-nums text-ink/60">
                      {row.minTotalSar > 0 ? `${row.minTotalSar} ${p.sar}` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-start text-xs text-ink/60">
                      {row.startsAt || row.endsAt ? (
                        <>
                          {row.startsAt ? formatDateTime(new Date(row.startsAt), lang) : "—"}
                          <span className="block text-ink/35">
                            → {row.endsAt ? formatDateTime(new Date(row.endsAt), lang) : "—"}
                          </span>
                        </>
                      ) : (
                        <span className="text-ink/30">{p.always}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-start tabular-nums text-ink/60" dir="ltr">
                      {row.uses}
                      {row.maxUses !== null && ` / ${row.maxUses}`}
                    </td>
                    <td className="px-4 py-3 text-end">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => open(toDraft(row))}>
                          {t.common.edit}
                        </Button>
                        {/* An ended code is brought back by giving it a new end
                            date in Edit, not by a switch that can't hold. */}
                        {past(row.endsAt) ? null : (
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggle(row)}>
                            {row.active ? p.deactivate : p.activate}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? p.editCode : p.newCode}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t.common.cancel}
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? t.common.saving : t.common.save}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label={p.code} hint={p.codeHint} error={errors.code}>
              <Input
                aria-invalid={!!errors.code}
                value={editing.code}
                // Letters and digits only, the same rule the server enforces, so a
                // dash or an Arabic letter never lands instead of erroring later.
                onChange={(e) =>
                  setEditing({ ...editing, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })
                }
                dir="ltr"
                maxLength={40}
                placeholder="EID25"
              />
            </Field>

            <Field label={p.type}>
              <div className="flex gap-2">
                {(["percent", "fixed"] as const).map((option) => (
                  <Button
                    key={option}
                    variant={editing.type === option ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setEditing({ ...editing, type: option })}
                  >
                    {option === "percent" ? p.percent : p.fixed}
                  </Button>
                ))}
              </div>
            </Field>

            <NumberField
              label={valueLabel}
              hint={editing.type === "percent" ? p.percentHint : undefined}
              error={errors.value}
              maxDigits={editing.type === "percent" ? 3 : 6}
              decimals={editing.type === "percent" ? undefined : 2}
              value={editing.value}
              onChange={(value) => setEditing({ ...editing, value })}
            />

            <NumberField
              label={p.minTotal}
              hint={p.minTotalHint}
              error={errors.minTotalSar}
              maxDigits={6}
              decimals={2}
              value={editing.minTotalSar}
              onChange={(minTotalSar) => setEditing({ ...editing, minTotalSar })}
            />

            <div className="grid grid-cols-2 gap-3">
              <Field label={p.startsAt} error={errors.startsAt}>
                <Input
                  aria-invalid={!!errors.startsAt}
                  type="datetime-local"
                  min={toLocalInput(new Date().toISOString())}
                  value={toLocalInput(editing.startsAt)}
                  onChange={(e) => setEditing({ ...editing, startsAt: toIso(e.target.value) })}
                  dir="ltr"
                />
              </Field>
              <Field label={p.endsAt} error={errors.endsAt}>
                <Input
                  aria-invalid={!!errors.endsAt}
                  type="datetime-local"
                  // Not before now, and not before the start when there is one.
                  min={toLocalInput(
                    editing.startsAt && !past(editing.startsAt) ? editing.startsAt : new Date().toISOString(),
                  )}
                  value={toLocalInput(editing.endsAt)}
                  onChange={(e) => setEditing({ ...editing, endsAt: toIso(e.target.value) })}
                  dir="ltr"
                />
              </Field>
            </div>

            <NumberField
              label={p.maxUses}
              hint={p.maxUsesHint}
              error={errors.maxUses}
              maxDigits={7}
              placeholder="∞"
              value={editing.maxUses}
              onChange={(maxUses) => setEditing({ ...editing, maxUses })}
            />

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                className="h-4 w-4 accent-red"
              />
              {p.activeLabel}
            </label>

            <FormErrors errors={errors} summary={t.validation.summary} server={error} />
          </div>
        )}
      </Drawer>
    </>
  );
}
