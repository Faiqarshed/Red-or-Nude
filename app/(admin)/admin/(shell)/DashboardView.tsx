"use client";

import { CalendarDays, Coins, Lock, Sparkles, Users } from "lucide-react";
import { Card, CardHeader, PageHeader, StatCard } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";

export default function DashboardView({
  name,
  stats,
  showRevenue,
  denied,
}: {
  name: string;
  stats: { today: number; upcoming: number; services: number; customers: number; revenue: string };
  showRevenue: boolean;
  denied?: string | null;
}) {
  const { t, lang } = useAdminI18n();

  return (
    <>
      <PageHeader
        title={t.dashboard.title}
        subtitle={lang === "ar" ? `${t.dashboard.welcome}، ${name}` : `${t.dashboard.welcome}, ${name}`}
      />

      {/* Set by requirePage() when a role lands on a section it can't reach. */}
      {denied && (
        <div
          role="status"
          className="mb-5 flex items-center gap-2 rounded-xl bg-[#b7791f]/12 px-4 py-3 text-start text-xs text-[#8a5a06]"
        >
          <Lock className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {t.dashboard.denied}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t.dashboard.todayBookings}
          value={stats.today}
          icon={<CalendarDays className="h-5 w-5" strokeWidth={1.5} />}
        />
        <StatCard
          label={t.dashboard.upcoming}
          value={stats.upcoming}
          icon={<CalendarDays className="h-5 w-5" strokeWidth={1.5} />}
        />
        {showRevenue && (
          <StatCard
            label={t.dashboard.revenueToday}
            value={
              <span className="inline-flex items-baseline gap-1">
                {stats.revenue}
                <span className="text-sm font-normal text-ink/45">{t.common.riyal}</span>
              </span>
            }
            icon={<Coins className="h-5 w-5" strokeWidth={1.5} />}
          />
        )}
        <StatCard
          label={t.dashboard.services}
          value={stats.services}
          icon={<Sparkles className="h-5 w-5" strokeWidth={1.5} />}
        />
        <StatCard
          label={t.dashboard.customers}
          value={stats.customers}
          icon={<Users className="h-5 w-5" strokeWidth={1.5} />}
        />
      </div>

      <Card className="mt-6">
        <CardHeader title={t.dashboard.setupTitle} />
        <p className="px-5 py-4 text-start text-sm leading-relaxed text-ink/60">
          {t.dashboard.setupBody}
        </p>
      </Card>
    </>
  );
}
