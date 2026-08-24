"use client";

import { Star } from "lucide-react";
import { Badge, Card, EmptyState, PageHeader, StatCard, scoreTone } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { formatDateTime } from "@/lib/time";
import type { Localized } from "@/lib/db/schema";

type Row = {
  id: string;
  serviceRating: number | null;
  techRating: number | null;
  comment: string | null;
  submittedAt: string | null;
  invitedAt: string;
  serviceName: Localized | null;
  bookingCode: string;
  startsAt: string;
  technicianName: string | null;
};

export default function ReviewsView({
  rows,
  invited,
  answered,
  avgService,
  avgTech,
}: {
  rows: Row[];
  invited: number;
  answered: number;
  avgService: number | null;
  avgTech: number | null;
}) {
  const { t, lang } = useAdminI18n();
  const r = t.reviews;

  const oneDecimal = (value: number | null) => (value === null ? "—" : value.toFixed(1));
  const rate = invited > 0 ? Math.round((answered / invited) * 100) : 0;

  return (
    <>
      <PageHeader title={r.title} subtitle={r.subtitle} />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard
          label={r.avgService}
          value={oneDecimal(avgService)}
          hint={r.outOfFive}
          icon={<Star className="h-5 w-5" strokeWidth={1.5} />}
        />
        <StatCard
          label={r.avgTech}
          value={oneDecimal(avgTech)}
          // Says out loud why this tile is empty, rather than looking broken.
          hint={avgTech === null ? r.noTechYet : r.outOfFive}
          icon={<Star className="h-5 w-5" strokeWidth={1.5} />}
        />
        <StatCard label={r.responseRate} value={`${rate}%`} hint={r.ofInvited(answered, invited)} />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={r.empty}
            body={r.emptyBody}
            icon={<Star className="h-8 w-8" strokeWidth={1.25} />}
          />
        ) : (
          // Tables can exceed the viewport in either direction — scroll the
          // container, never the page body.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[840px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.015]">
                  {[r.when, r.service, r.technician, r.serviceScore, r.techScore, r.comment].map(
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
                      {formatDateTime(new Date(row.startsAt), lang)}
                      <span className="block text-[11px] text-ink/35" dir="ltr">
                        {row.bookingCode}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-start text-ink">
                      {pick(row.serviceName, lang) || "—"}
                    </td>
                    <td className="px-4 py-3 text-start text-ink/70">
                      {row.technicianName ?? <span className="text-ink/30">—</span>}
                    </td>
                    <td className="px-4 py-3 text-start">
                      <Score value={row.serviceRating} pending={r.pending} />
                    </td>
                    <td className="px-4 py-3 text-start">
                      <Score value={row.techRating} pending={r.skipped} />
                    </td>
                    <td className="max-w-[280px] px-4 py-3 text-start text-xs text-ink/60">
                      {row.comment ?? <span className="text-ink/30">{t.common.none}</span>}
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

/** A score out of five, or why there isn't one. */
function Score({ value, pending }: { value: number | null; pending: string }) {
  if (value === null) return <span className="text-[11px] text-ink/30">{pending}</span>;

  return (
    <Badge tone={scoreTone(value)}>
      <span dir="ltr" className="tabular-nums">
        {value} ★
      </span>
    </Badge>
  );
}
