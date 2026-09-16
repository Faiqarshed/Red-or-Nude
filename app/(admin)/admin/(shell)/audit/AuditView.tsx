"use client";

import { ScrollText } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/admin/ui";
import { AdminTable } from "@/components/admin/Table";
import { useAdminI18n } from "@/lib/admin/i18n";
import type { AdminLang, AdminStrings } from "@/lib/admin/strings";
import { ROLE_LABELS } from "@/lib/auth/rbac";
import { pick } from "@/lib/localized";
import { halalasToSar } from "@/lib/money";
import { formatDateTime } from "@/lib/time";

export type AuditName = string | { ar: string; en: string };

type Change = { from: unknown; to: unknown };

type Row = {
  id: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string | null;
  /** What the item is called: recorded with the entry, or looked up. */
  name: AuditName | null;
  diff: Record<string, Change>;
  createdAt: string;
};

const TONES: Record<string, "success" | "info" | "danger" | "neutral"> = {
  create: "success",
  update: "info",
  delete: "danger",
  refund: "danger",
  cancel: "danger",
  deactivate: "danger",
};

/** Shown before the rest fold behind "N more changes". */
const VISIBLE = 4;

// Money is stored in halalas under these keys; "amount" is already riyals.
const HALALAS = new Set(["priceHalalas", "balance", "totalHalalas", "amountHalalas"]);

/** "refillDays" → "Refill days", for a field nobody has named yet. */
const humanize = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

export default function AuditView({ rows, people }: { rows: Row[]; people: Record<string, string> }) {
  const { t, lang } = useAdminI18n();
  const a = t.audit;

  return (
    <>
      <PageHeader title={a.title} subtitle={a.subtitle} />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title={a.empty} body={a.subtitle} icon={<ScrollText className="h-8 w-8" strokeWidth={1.25} />} />
        ) : (
          <AdminTable
            rows={rows}
            rowKey={(row) => row.id}
            minWidth="min-w-[820px]"
            rowClassName="border-b border-black/[0.04] align-top last:border-0 hover:bg-black/[0.015]"
            columns={[
              {
                key: "when",
                header: a.when,
                className: "whitespace-nowrap text-xs tabular-nums text-ink/60",
                cell: (row) => formatDateTime(new Date(row.createdAt), lang),
              },
              {
                key: "actor",
                header: a.actor,
                className: "text-ink",
                cell: (row) => a.actors[row.actorName] ?? row.actorName,
              },
              {
                key: "action",
                header: a.action,
                className: "whitespace-nowrap",
                cell: (row) => (
                  <Badge tone={TONES[row.action] ?? "neutral"}>
                    {a.actions[row.action] ?? humanize(row.action)}
                  </Badge>
                ),
              },
              {
                key: "entity",
                header: a.entity,
                primary: true,
                cell: (row) => (
                  <>
                    <span className="block text-[11px] text-ink/45">
                      {a.entities[row.entity] ?? humanize(row.entity)}
                    </span>
                    <span
                      className="block max-w-[220px] truncate font-medium text-ink"
                      title={row.entityId ?? undefined}
                    >
                      {row.name ? (
                        shortName(
                          row.entity,
                          typeof row.name === "string" ? row.name : pick(row.name, lang),
                        )
                      ) : (
                        <span className="text-ink/35">{a.unnamed}</span>
                      )}
                    </span>
                  </>
                ),
              },
              {
                key: "changes",
                header: a.changes,
                className: "text-xs",
                cell: (row) => {
                  const changes = Object.entries(row.diff);
                  if (changes.length === 0) return <span className="text-ink/30">{a.noDetails}</span>;
                  return (
                    <>
                      <ChangeList changes={changes.slice(0, VISIBLE)} action={row.action} t={t} lang={lang} people={people} />
                      {changes.length > VISIBLE && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-ink/45 hover:text-ink">
                            {a.more(changes.length - VISIBLE)}
                          </summary>
                          <ChangeList changes={changes.slice(VISIBLE)} action={row.action} t={t} lang={lang} people={people} />
                        </details>
                      )}
                    </>
                  );
                },
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}

/** An image is known by its file, not the folder it sits in. */
const fileName = (path: string) => path.split("/").pop() || path;
const shortName = (entity: string, name: string) => (entity === "media" ? fileName(name) : name);
const blank = (v: unknown) => v === null || v === undefined || v === "";

function ChangeList({
  changes,
  action,
  t,
  lang,
  people,
}: {
  changes: [string, Change][];
  action: string;
  t: AdminStrings;
  lang: AdminLang;
  people: Record<string, string>;
}) {
  const a = t.audit;
  const show = (key: string, v: unknown) => formatValue(key, v, t, lang, people);

  return (
    <ul className="space-y-1">
      {changes.map(([key, c]) => {
        const label = a.fields[key] ?? humanize(key);
        const had = !blank(c.from);
        const has = !blank(c.to);
        return (
          <li key={key} className="leading-relaxed">
            <span className="text-ink/50">{label}:</span>{" "}
            {/* A value appearing reads as a value, a value going away reads as
                struck through, and only a real change gets an arrow. */}
            {had && has ? (
              <>
                <span className="text-ink/40 line-through">{show(key, c.from)}</span>
                <span className="mx-1 text-ink/30" aria-hidden>
                  {lang === "ar" ? "←" : "→"}
                </span>
                <span className="font-medium text-ink">{show(key, c.to)}</span>
              </>
            ) : has ? (
              <span className="font-medium text-ink">{show(key, c.to)}</span>
            ) : had ? (
              <span className={action === "delete" ? "text-ink/70" : "text-ink/40 line-through"}>{show(key, c.from)}</span>
            ) : (
              <span className="text-ink/35">{a.emptyValue}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function formatValue(key: string, v: unknown, t: AdminStrings, lang: AdminLang, people: Record<string, string>): string {
  const a = t.audit;
  if (blank(v)) return a.emptyValue;
  if (typeof v === "boolean") return v ? a.yes : a.no;
  if (Array.isArray(v)) return a.items(v.length);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // { ar, en }: a name or description in both languages.
    if (typeof o.ar === "string" || typeof o.en === "string")
      return clip(pick(o as { ar: string; en: string }, lang)) || a.emptyValue;
    return clip(JSON.stringify(v));
  }
  if (typeof v === "number") {
    if (HALALAS.has(key)) return `${halalasToSar(v).toLocaleString("en-US")} ${t.common.riyal}`;
    if (key === "amount") return `${v.toLocaleString("en-US")} ${t.common.riyal}`;
    if (key === "durationMin") return a.minutes(v);
    if (key === "refillDays" || key === "validDays") return a.days(v);
    return v.toLocaleString("en-US");
  }
  const s = String(v);
  if (key === "role" && s in ROLE_LABELS) return ROLE_LABELS[s as keyof typeof ROLE_LABELS][lang];
  if (key === "status" && s in t.bookings.statuses) return t.bookings.statuses[s as keyof typeof t.bookings.statuses];
  if (key === "source" && s in t.bookings.sources) return t.bookings.sources[s as keyof typeof t.bookings.sources];
  if ((key === "technicianId" || key === "staffId") && people[s]) return people[s];
  if (key === "hours" && s === "closed") return t.availability.closed;
  if (key === "image" || key === "path") return fileName(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return formatDateTime(new Date(s), lang);
  return clip(s);
}

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
