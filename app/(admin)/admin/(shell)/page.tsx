// The one screen everybody lands on, showing each role its own job (brief §3).
//
// It requires no capability beyond being signed in, and that is deliberate.
// Every other page redirects here when a role can't reach it — so if this page
// could turn someone away, the denial would bounce them straight back to a page
// that denies them again. A technician signing in used to hit exactly that loop.
//
// Each role's data loading lives in its own module. Three query blocks inline
// would make this the file nobody wants to touch.

import { and, count, eq, gte, lt, sum } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, services, branches } from "@/lib/db/schema";
import { requireStaff } from "@/lib/auth/guard";
import { can, scopedBranchId } from "@/lib/auth/rbac";
import { riyadhDayRange } from "@/lib/time";
import { formatSAR } from "@/lib/money";
import { asc } from "drizzle-orm";
import DashboardView from "./DashboardView";
import MyDayView from "./my-day/MyDayView";
import { loadMyDay, loadMyHistory } from "./my-day/data";
import { isPeriodKey, loadTechnicianStats } from "@/lib/performance";
import FrontDeskView from "./front-desk/FrontDeskView";
import { loadFrontDesk } from "./front-desk/data";

export const dynamic = "force-dynamic";

export default async function AdminHomePage({
  searchParams,
}: {
  searchParams: { denied?: string; period?: string };
}) {
  const user = await requireStaff();

  if (user.role === "technician") {
    // Her own numbers, over the period she picked — the same function the CEO's
    // performance screen calls, narrowed to one person. She sees nobody else's.
    const period = isPeriodKey(searchParams.period) ? searchParams.period : "today";

    // Today is a board she works from — Start and Finish live on those cards.
    // The longer periods are a record of work already done, so they load the
    // history instead. Loading both would fetch a list the screen won't render.
    const [bookings, history, stats] = await Promise.all([
      period === "today" ? loadMyDay(user.id) : Promise.resolve([]),
      period === "today" ? Promise.resolve([]) : loadMyHistory(user.id, period),
      loadTechnicianStats({ period, technicianId: user.id }),
    ]);

    return (
      <MyDayView
        bookings={bookings}
        history={history}
        stats={stats[0] ?? null}
        period={period}
      />
    );
  }

  if (user.role === "receptionist") {
    // A receptionist belongs to one branch. Falling back to the first branch
    // keeps a half-configured account usable rather than showing them nothing.
    const branchId =
      user.branchId ??
      (await db.select({ id: branches.id }).from(branches).orderBy(asc(branches.sort)).limit(1))[0]
        ?.id;

    if (!branchId) return <FrontDeskView branchId="" data={{ rows: [], technicians: [], stats: { finished: 0, inService: 0, waiting: 0, upcoming: 0 } }} />;

    return <FrontDeskView branchId={branchId} data={await loadFrontDesk(branchId)} />;
  }

  // The CEO sees every branch; everyone else is filtered to their own. The scope
  // is applied in the query, not by hiding numbers in the UI.
  const branchId = scopedBranchId(user.role, user.branchId);
  const branchFilter = branchId ? eq(bookings.branchId, branchId) : undefined;

  const { start, end } = riyadhDayRange();
  const todayFilter = and(gte(bookings.startsAt, start), lt(bookings.startsAt, end), branchFilter);

  const [[today], [upcoming], [activeServices], [customerCount], [revenue]] = await Promise.all([
    db.select({ n: count() }).from(bookings).where(todayFilter),
    db
      .select({ n: count() })
      .from(bookings)
      .where(and(gte(bookings.startsAt, end), eq(bookings.status, "confirmed"), branchFilter)),
    db.select({ n: count() }).from(services).where(eq(services.active, true)),
    db.select({ n: count() }).from(customers),
    db
      .select({ total: sum(bookings.totalHalalas) })
      .from(bookings)
      .where(and(todayFilter, eq(bookings.status, "completed"))),
  ]);

  return (
    <DashboardView
      name={user.name}
      stats={{
        today: today?.n ?? 0,
        upcoming: upcoming?.n ?? 0,
        services: activeServices?.n ?? 0,
        customers: customerCount?.n ?? 0,
        // sum() comes back as a string (or null when no rows matched).
        revenue: formatSAR(Number(revenue?.total ?? 0)),
      }}
      showRevenue={can(user.role, "dashboard.revenue")}
      denied={searchParams.denied ?? null}
    />
  );
}
