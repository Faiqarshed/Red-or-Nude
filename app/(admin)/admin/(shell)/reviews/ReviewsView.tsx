"use client";

import { Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge, BranchFilter, Card, EmptyState, PageHeader, StatCard, scoreTone } from "@/components/admin/ui";
import { AdminTable } from "@/components/admin/Table";
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
  branchId,
  branchOptions,
}: {
  rows: Row[];
  invited: number;
  answered: number;
  avgService: number | null;
  avgTech: number | null;
  /** Null = every branch. Only the CEO is ever offered the choice. */
  branchId: string | null;
  branchOptions: { id: string; name: Localized }[];
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const r = t.reviews;

  const oneDecimal = (value: number | null) => (value === null ? "—" : value.toFixed(1));
  const rate = invited > 0 ? Math.round((answered / invited) * 100) : 0;

  return (
    <>
      <PageHeader
        title={r.title}
        subtitle={r.subtitle}
        action={
          <BranchFilter
            branchId={branchId}
            options={branchOptions}
            allLabel={t.topbar.allBranches}
            lang={lang}
            onChange={(id) => router.push(id ? `/admin/reviews?branch=${id}` : "/admin/reviews")}
          />
        }
      />

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
          <AdminTable
            rows={rows}
            rowKey={(row) => row.id}
            minWidth="min-w-[840px]"
            columns={[
              {
                key: "when",
                header: r.when,
                primary: true,
                className: "whitespace-nowrap text-xs tabular-nums text-ink/60",
                cell: (row) => (
                  <>
                    {formatDateTime(new Date(row.startsAt), lang)}
                    <span className="block text-[11px] text-ink/35" dir="ltr">
                      {row.bookingCode}
                    </span>
                  </>
                ),
              },
              {
                key: "service",
                header: r.service,
                className: "text-ink",
                cell: (row) => pick(row.serviceName, lang) || "—",
              },
              {
                key: "technician",
                header: r.technician,
                className: "text-ink/70",
                cell: (row) => row.technicianName ?? <span className="text-ink/30">—</span>,
              },
              {
                key: "serviceScore",
                header: r.serviceScore,
                cell: (row) => <Score value={row.serviceRating} pending={r.pending} />,
              },
              {
                key: "techScore",
                header: r.techScore,
                cell: (row) => <Score value={row.techRating} pending={r.skipped} />,
              },
              {
                key: "comment",
                header: r.comment,
                className: "max-w-[280px] text-xs text-ink/60",
                cell: (row) => row.comment ?? <span className="text-ink/30">{t.common.none}</span>,
              },
            ]}
          />
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
