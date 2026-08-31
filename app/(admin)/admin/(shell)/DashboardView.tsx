"use client";

// The owner's and the manager's home screen.
//
// One component for both, and the difference is an ordering rather than a
// second screen: a CEO opens this to ask "how did we do", a branch admin to ask
// "what is going wrong on my floor". So when the scope is a single branch the
// attention panel comes first and the money follows it; across branches the
// money leads. Two layouts, one set of components, no second file to keep in
// step with this one.
//
// Every figure here goes somewhere. A number nobody can open is trivia: the
// point of "38 bookings today" is that it takes you to the thirty-eight.

import {
  AlertTriangle,
  CalendarOff,
  Coins,
  Lock,
  Star,
  UserCog,
  UserX,
} from "lucide-react";
import {
  Avatar,
  Bar,
  Card,
  CardHeader,
  DataRow,
  EmptyState,
  PageHeader,
  Sparkline,
  StatCard,
  Thumb,
} from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import { formatSAR } from "@/lib/money";
import { localTime } from "@/lib/time";
import type { Attention, DashboardData } from "./dashboard-data";

/** Where a booking-shaped figure sends you, optionally at one branch. */
const bookingsHref = (branchId?: string) =>
  branchId ? `/admin/bookings?branch=${branchId}` : "/admin/bookings";

export default function DashboardView({
  name,
  data,
  showRevenue,
  denied,
}: {
  name: string;
  data: DashboardData;
  showRevenue: boolean;
  denied?: string | null;
}) {
  const { t, lang } = useAdminI18n();
  const d = t.dashboard;

  // More than one branch in scope means the CEO. The branch table is the tell:
  // a manager's would be one row saying what the tiles above it already said.
  const owner = data.branches.length > 1;

  const soldHours = Math.round(data.utilisation.soldMin / 60);
  const capacityHours = Math.round(data.utilisation.capacityMin / 60);
  const unsoldHours = Math.max(0, capacityHours - soldHours);

  const attention = (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-[#8a5a06]" strokeWidth={1.75} />
            {d.needsYou}
          </span>
        }
        action={
          data.attention.length > 0 ? (
            <span className="rounded-full bg-[#b7791f]/14 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-[#8a5a06]">
              {data.attention.length}
            </span>
          ) : null
        }
      />
      {data.attention.length === 0 ? (
        <EmptyState title={d.allQuiet} />
      ) : (
        <div className="divide-y divide-black/[0.04]">
          {data.attention.map((item) => (
            <AttentionRow key={item.kind} item={item} />
          ))}
        </div>
      )}
    </Card>
  );

  const money = (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        {showRevenue ? (
          <StatCard
            weight="hero"
            href={bookingsHref()}
            label={d.revenueToday}
            icon={<Coins className="h-5 w-5" strokeWidth={1.5} />}
            value={
              <span className="inline-flex items-baseline gap-1.5">
                {formatSAR(data.revenue.todayHalalas)}
                <span className="text-sm font-normal text-ink/45">{t.common.riyal}</span>
              </span>
            }
            delta={
              data.revenue.deltaPct === null
                ? undefined
                : {
                    pct: data.revenue.deltaPct,
                    up: data.revenue.deltaPct >= 0,
                    label: d.vsLastWeek,
                  }
            }
            aside={<Sparkline points={data.revenue.week} />}
          />
        ) : null}

        {/* Utilisation earns the hero slot next to the money because it *is*
            money — an empty chair is the loss nobody sees on a takings figure. */}
        <StatCard
          weight="hero"
          href={bookingsHref()}
          label={d.utilisation}
          icon={<UserCog className="h-5 w-5" strokeWidth={1.5} />}
          value={
            <span className="inline-flex items-baseline">
              {data.utilisation.pct}
              <span className="text-lg font-medium text-ink/45">%</span>
            </span>
          }
          hint={
            <>
              <Bar value={data.utilisation.pct} />
              <p className="mt-2 tabular-nums">
                {d.chairHours(soldHours, capacityHours)}
                {unsoldHours > 0 ? (
                  <> · <span className="font-semibold text-[#8a5a06]">{d.hoursUnsold(unsoldHours)}</span></>
                ) : null}
              </p>
            </>
          }
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <StatCard
          weight="quiet"
          href={bookingsHref()}
          label={d.todayBookings}
          value={data.counts.today}
        />
        <StatCard
          weight="quiet"
          href={bookingsHref()}
          label={d.upcoming}
          value={data.counts.upcoming}
        />
        <StatCard
          weight="quiet"
          href={bookingsHref()}
          label={d.noShowsWeek}
          value={data.counts.noShowsWeek}
        />
      </div>
    </>
  );

  return (
    <>
      <PageHeader
        title={d.title}
        subtitle={
          lang === "ar" ? `${d.welcome}، ${name}` : `${d.welcome}, ${name}`
        }
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

      {owner ? (
        <>
          {money}
          <div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_1fr]">
            <div className="flex flex-col gap-4">
              <BranchesCard data={data} showRevenue={showRevenue} lang={lang} d={d} none={t.common.none} />
              <TopServicesCard data={data} showRevenue={showRevenue} lang={lang} d={d} none={t.common.none} />
            </div>
            <div className="flex flex-col gap-4">
              {attention}
              <TechniciansCard data={data} d={d} none={t.common.none} minutes={t.performance.minutes} />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Branch-scoped: exceptions first. He is here to fix things. */}
          <div className="mb-4">{attention}</div>
          {money}
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <TopServicesCard data={data} showRevenue={showRevenue} lang={lang} d={d} none={t.common.none} />
            <TechniciansCard data={data} d={d} none={t.common.none} minutes={t.performance.minutes} />
          </div>
        </>
      )}
    </>
  );
}

/** One thing a person has to decide about. Copy here, numbers from the query. */
function AttentionRow({ item }: { item: Attention }) {
  const { t, lang } = useAdminI18n();
  const d = t.dashboard;

  if (item.kind === "unassigned") {
    return (
      <DataRow href="/admin/floor">
        <Pill tone="warning">
          <UserX className="h-4 w-4" strokeWidth={1.75} />
        </Pill>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{d.unassigned}</span>
          <span className="block truncate text-xs tabular-nums text-ink/50">
            {item.startsAt.map((iso) => localTime(iso)).join(" · ")}
          </span>
        </span>
        <span className="rounded-full bg-[#b7791f]/14 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-[#8a5a06]">
          {item.count}
        </span>
      </DataRow>
    );
  }

  if (item.kind === "lowReview") {
    return (
      <DataRow href="/admin/reviews">
        <Pill tone="danger">
          <Star className="h-4 w-4" strokeWidth={1.75} />
        </Pill>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{d.lowReview(item.rating)}</span>
          <span className="block truncate text-xs text-ink/50">
            {[item.customer, item.service ? pick(item.service, lang) : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </DataRow>
    );
  }

  return (
    <DataRow href="/admin/floor">
      <Pill tone="info">
        <CalendarOff className="h-4 w-4" strokeWidth={1.75} />
      </Pill>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{d.onLeave}</span>
        <span className="block truncate text-xs text-ink/50">{item.names.join(" · ")}</span>
      </span>
    </DataRow>
  );
}

const pillTones = {
  warning: "bg-[#b7791f]/14 text-[#8a5a06]",
  danger: "bg-red/10 text-red",
  info: "bg-sky/15 text-[#2c6a88]",
} as const;

function Pill({ tone, children }: { tone: keyof typeof pillTones; children: React.ReactNode }) {
  return (
    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${pillTones[tone]}`}>
      {children}
    </span>
  );
}

type CardProps = {
  data: DashboardData;
  d: ReturnType<typeof useAdminI18n>["t"]["dashboard"];
  none: string;
};

function BranchesCard({
  data,
  showRevenue,
  lang,
  d,
  none,
}: CardProps & { showRevenue: boolean; lang: "ar" | "en" }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={d.branchesToday} subtitle={d.openBranch} />
      {data.branches.length === 0 ? (
        <EmptyState title={none} />
      ) : (
        <div className="divide-y divide-black/[0.04]">
          {data.branches.map((b) => (
            <DataRow key={b.id} href={bookingsHref(b.id)}>
              <span className="h-9 w-1.5 shrink-0 rounded-full bg-red-grad" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {pick(b.name, lang)}
                </span>
                <span className="block truncate text-xs tabular-nums text-ink/50">
                  {d.booked(b.bookings)} · {d.techniciansIn(b.techniciansIn)}
                </span>
              </span>
              {showRevenue ? (
                <span className="w-24 shrink-0 text-end text-sm font-semibold tabular-nums text-ink">
                  {formatSAR(b.revenueHalalas)}
                </span>
              ) : null}
              <span className="hidden w-24 shrink-0 sm:block">
                <Bar value={b.utilisationPct} />
              </span>
              <span className="w-10 shrink-0 text-end text-xs font-semibold tabular-nums text-ink">
                {b.utilisationPct}%
              </span>
            </DataRow>
          ))}
        </div>
      )}
    </Card>
  );
}

function TopServicesCard({
  data,
  showRevenue,
  lang,
  d,
  none,
}: CardProps & { showRevenue: boolean; lang: "ar" | "en" }) {
  // Bars are relative to the day's best seller, not to a target: the question
  // this list answers is "what is carrying today", which is a comparison.
  const top = data.topServices[0]?.revenueHalalas ?? 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader title={d.topServices} subtitle={showRevenue ? d.byRevenue : undefined} />
      {data.topServices.length === 0 ? (
        <EmptyState title={none} />
      ) : (
        <div className="divide-y divide-black/[0.04]">
          {data.topServices.map((s) => (
            <DataRow key={s.id} href="/admin/catalog">
              <Thumb src={s.imageUrl} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {s.name ? pick(s.name, lang) : none}
                </span>
                <span className="block text-xs tabular-nums text-ink/50">{d.booked(s.count)}</span>
              </span>
              <span className="hidden w-28 shrink-0 lg:block">
                <Bar value={top > 0 ? (s.revenueHalalas / top) * 100 : 0} brand />
              </span>
              {showRevenue ? (
                <span className="w-24 shrink-0 text-end text-sm font-semibold tabular-nums text-ink">
                  {formatSAR(s.revenueHalalas)}
                </span>
              ) : null}
            </DataRow>
          ))}
        </div>
      )}
    </Card>
  );
}

function TechniciansCard({ data, d, none, minutes }: CardProps & { minutes: string }) {
  const best = Math.max(1, ...data.technicians.map((x) => x.services));

  return (
    <Card className="overflow-hidden">
      <CardHeader title={d.techniciansToday} subtitle={d.doneAvg} />
      {data.technicians.length === 0 ? (
        <EmptyState title={none} />
      ) : (
        <div className="divide-y divide-black/[0.04]">
          {data.technicians.map((tech) => (
            <DataRow key={tech.id} href="/admin/performance">
              <Avatar name={tech.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{tech.name}</span>
                <span className="mt-1.5 block">
                  <Bar value={(tech.services / best) * 100} brand />
                </span>
              </span>
              <span className="shrink-0 text-end">
                <span className="block text-sm font-semibold tabular-nums text-ink">
                  {tech.services}
                </span>
                <span className="block text-[11px] tabular-nums text-ink/45">
                  {tech.avgServiceMin} {minutes}
                </span>
              </span>
            </DataRow>
          ))}
        </div>
      )}
    </Card>
  );
}
