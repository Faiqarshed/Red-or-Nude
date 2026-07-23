"use client";

import { ScrollText } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { formatDateTime } from "@/lib/time";

type Row = {
  id: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string | null;
  diff: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: string;
};

const TONES: Record<string, "success" | "info" | "danger" | "neutral"> = {
  create: "success",
  update: "info",
  delete: "danger",
  refund: "danger",
  cancel: "danger",
};

export default function AuditView({ rows }: { rows: Row[] }) {
  const { t, lang } = useAdminI18n();

  return (
    <>
      <PageHeader title={t.audit.title} subtitle={t.audit.subtitle} />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={t.audit.empty}
            body={t.audit.subtitle}
            icon={<ScrollText className="h-8 w-8" strokeWidth={1.25} />}
          />
        ) : (
          // Tables can exceed the viewport in either direction — scroll the
          // container, never the page body.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.015]">
                  {[t.audit.when, t.audit.actor, t.audit.action, t.audit.entity, t.audit.changes].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-4 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-black/[0.04] last:border-0 hover:bg-black/[0.015]"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-start text-xs tabular-nums text-ink/60">
                      {formatDateTime(new Date(row.createdAt), lang)}
                    </td>
                    <td className="px-4 py-3 text-start text-ink">{row.actorName}</td>
                    <td className="px-4 py-3 text-start">
                      <Badge tone={TONES[row.action] ?? "neutral"}>{row.action}</Badge>
                    </td>
                    <td className="px-4 py-3 text-start">
                      <span className="font-medium text-ink">{row.entity}</span>
                      {row.entityId && (
                        <span className="block text-[11px] text-ink/35" dir="ltr">
                          {row.entityId.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-start text-xs text-ink/55">
                      {row.diff && Object.keys(row.diff).length > 0 ? (
                        <ul className="space-y-0.5">
                          {Object.entries(row.diff)
                            .slice(0, 3)
                            .map(([field, change]) => (
                              <li key={field} dir="ltr" className="text-left">
                                <span className="text-ink/70">{field}</span>{" "}
                                <span className="text-ink/35 line-through">
                                  {String(change.from ?? "—").slice(0, 24)}
                                </span>{" "}
                                → <span className="text-ink">{String(change.to ?? "—").slice(0, 24)}</span>
                              </li>
                            ))}
                          {Object.keys(row.diff).length > 3 && (
                            <li className="text-ink/35">
                              +{Object.keys(row.diff).length - 3}
                            </li>
                          )}
                        </ul>
                      ) : (
                        <span className="text-ink/30">{t.common.none}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
