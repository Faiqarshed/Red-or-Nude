"use client";

import { useState, useTransition } from "react";
import { Ticket } from "lucide-react";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
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

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` with no zone; the row carries ISO. */
const toLocalInput = (iso: string | null) => (iso ? iso.slice(0, 16) : "");
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

const blank = (): PromoRow => ({
  id: "",
  code: "",
  type: "percent",
  value: 10,
  minTotalSar: 0,
  startsAt: null,
  endsAt: null,
  maxUses: null,
  uses: 0,
  active: true,
});

export default function PromoCodesView({ rows }: { rows: PromoRow[] }) {
  const { t, lang } = useAdminI18n();
  const p = t.promoCodes;

  const [editing, setEditing] = useState<PromoRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (!editing) return;
    startTransition(async () => {
      setError(null);
      const res = await savePromoCode({
        id: editing.id || undefined,
        code: editing.code,
        type: editing.type,
        value: editing.value,
        minTotalSar: editing.minTotalSar,
        startsAt: editing.startsAt,
        endsAt: editing.endsAt,
        maxUses: editing.maxUses,
        active: editing.active,
      });
      if (res.ok) setEditing(null);
      else setError(p.errors[res.error as keyof typeof p.errors] ?? t.common.error);
    });
  };

  const toggle = (row: PromoRow) =>
    startTransition(async () => {
      await setPromoActive(row.id, !row.active);
    });

  return (
    <>
      <PageHeader
        title={p.title}
        subtitle={p.subtitle}
        action={<Button onClick={() => setEditing(blank())}>{p.newCode}</Button>}
      />

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
                      {!row.active && (
                        <Badge tone="neutral" className="ms-2">
                          {p.inactive}
                        </Badge>
                      )}
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
                        <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>
                          {t.common.edit}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => toggle(row)}
                        >
                          {row.active ? p.deactivate : p.activate}
                        </Button>
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
            <Button onClick={save} disabled={pending || !editing?.code.trim()}>
              {pending ? t.common.saving : t.common.save}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label={p.code} hint={p.codeHint}>
              <Input
                value={editing.code}
                onChange={(e) =>
                  setEditing({ ...editing, code: e.target.value.toUpperCase().replace(/\s/g, "") })
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

            <Field
              label={editing.type === "percent" ? p.percentValue : p.fixedValue}
              hint={editing.type === "percent" ? p.percentHint : undefined}
            >
              <Input
                type="number"
                min={1}
                max={editing.type === "percent" ? 100 : undefined}
                value={editing.value}
                onChange={(e) => setEditing({ ...editing, value: Number(e.target.value) })}
                dir="ltr"
              />
            </Field>

            <Field label={p.minTotal} hint={p.minTotalHint}>
              <Input
                type="number"
                min={0}
                value={editing.minTotalSar}
                onChange={(e) => setEditing({ ...editing, minTotalSar: Number(e.target.value) })}
                dir="ltr"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={p.startsAt}>
                <Input
                  type="datetime-local"
                  value={toLocalInput(editing.startsAt)}
                  onChange={(e) => setEditing({ ...editing, startsAt: toIso(e.target.value) })}
                  dir="ltr"
                />
              </Field>
              <Field label={p.endsAt}>
                <Input
                  type="datetime-local"
                  value={toLocalInput(editing.endsAt)}
                  onChange={(e) => setEditing({ ...editing, endsAt: toIso(e.target.value) })}
                  dir="ltr"
                />
              </Field>
            </div>

            <Field label={p.maxUses} hint={p.maxUsesHint}>
              <Input
                type="number"
                min={1}
                value={editing.maxUses ?? ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    maxUses: e.target.value ? Number(e.target.value) : null,
                  })
                }
                dir="ltr"
                placeholder="∞"
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={editing.active}
                onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                className="h-4 w-4 accent-red"
              />
              {p.activeLabel}
            </label>

            {error && (
              <p role="alert" className="rounded-xl bg-red/[0.08] px-4 py-3 text-xs text-red">
                {error}
              </p>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
