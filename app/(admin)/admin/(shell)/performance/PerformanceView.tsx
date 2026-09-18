"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, EmptyState, PageHeader, Badge, BranchFilter, tabItem } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import type { PeriodKey, TechnicianStats } from "@/lib/performance";

export default function PerformanceView({
  stats,
  period,
  branchId,
  branchOptions,
}: {
  stats: TechnicianStats[];
  period: PeriodKey;
  /** Null = every branch. Only the CEO is ever offered the choice. */
  branchId: string | null;
  branchOptions: { id: string; name: Localized }[];
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const p = t.performance;

  // The period is already in the URL, so the branch joins it there rather than
  // in state — the two have to travel together or switching one loses the other.
  const href = (next: { period?: PeriodKey; branch?: string | null }) => {
    const q = new URLSearchParams();
    q.set("period", next.period ?? period);
    const b = next.branch === undefined ? branchId : next.branch;
    if (b) q.set("branch", b);
    return `/admin/performance?${q.toString()}`;
  };

  const tabs: [PeriodKey, string][] = [
    ["today", p.periodToday],
    ["7", p.period7],
    ["30", p.period30],
  ];

  return (
    <>
      <PageHeader
        title={p.title}
        subtitle={p.subtitle}
        action={
          <div className="flex flex-wrap items-center gap-2">
          <BranchFilter
            branchId={branchId}
            options={branchOptions}
            allLabel={t.topbar.allBranches}
            lang={lang}
            onChange={(id) => router.push(href({ branch: id }))}
          />
          <div className="flex gap-1 rounded-xl bg-black/[0.04] p-1">
            {tabs.map(([key, label]) => (
              <Link
                key={key}
                href={href({ period: key })}
                className={cn(
                  tabItem,
                  period === key ? "bg-white text-ink shadow-sm" : "text-ink/55 hover:text-ink",
                )}
              >
                {label}
              </Link>
            ))}
          </div>
          </div>
        }
      />

      <Card>
        {stats.length === 0 ? (
          <EmptyState title={p.noData} body={p.commissionNote} />
        ) : (
          <>
            <div className="hidden gap-3 border-b border-black/[0.06] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink/40 sm:flex">
              <span className="min-w-0 flex-1 text-start">{p.technician}</span>
              <span className="w-24 text-end">{p.services}</span>
              <span className="w-32 text-end">{p.avgService}</span>
              <span className="w-32 text-end">{p.avgExpected}</span>
              <span className="w-28 text-end">{p.avgWait}</span>
            </div>

            {/* The headings above are `sm:flex` — gone on a phone, which left
                four bare numbers wrapping under a truncated name and nothing to
                say which was which. Below `sm` each figure carries its own
                label; `sm:contents` then dissolves the list back into the flex
                row the desk sees, unchanged. */}
            <ul className="divide-y divide-black/[0.06]">
              {stats.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3"
                >
                  <span className="min-w-0 flex-1 text-start text-sm font-medium text-ink sm:truncate">
                    {s.name}
                  </span>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs sm:contents">
                    <dt className="text-ink/45 sm:hidden">{p.services}</dt>
                    <dd className="text-start text-sm tabular-nums text-ink sm:w-24 sm:text-end">
                      {s.services}
                    </dd>

                    <dt className="text-ink/45 sm:hidden">{p.avgService}</dt>
                    <dd className="text-start text-sm tabular-nums text-ink sm:w-32 sm:text-end">
                      {s.avgServiceMin} {p.minutes}
                    </dd>

                    <dt className="text-ink/45 sm:hidden">{p.avgExpected}</dt>
                    <dd className="text-start sm:w-32 sm:text-end">
                      {s.avgVsExpectedMin === null ? (
                        <span className="text-xs text-ink/35">—</span>
                      ) : (
                        <Badge tone={s.avgVsExpectedMin <= 0 ? "success" : "warning"}>
                          {Math.abs(s.avgVsExpectedMin)} {p.minutes}{" "}
                          {s.avgVsExpectedMin <= 0 ? p.faster : p.slower}
                        </Badge>
                      )}
                    </dd>

                    <dt className="text-ink/45 sm:hidden">{p.avgWait}</dt>
                    <dd className="text-start text-sm tabular-nums text-ink/60 sm:w-28 sm:text-end">
                      {s.avgWaitMin === null ? "—" : `${s.avgWaitMin} ${p.minutes}`}
                    </dd>
                  </dl>
                </li>
              ))}
            </ul>

            <p className="border-t border-black/[0.06] px-4 py-3 text-start text-xs text-ink/45">
              {p.commissionNote}
            </p>
          </>
        )}
      </Card>
    </>
  );
}
