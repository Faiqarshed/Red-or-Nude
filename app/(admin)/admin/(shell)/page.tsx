// The one screen everybody lands on, showing each role its own job (brief §3).
//
// It requires no capability beyond being signed in, and that is deliberate.
// Every other page redirects here when a role can't reach it — so if this page
// could turn someone away, the denial would bounce them straight back to a page
// that denies them again. A technician signing in used to hit exactly that loop.
//
// Each role's data loading lives in its own module. Three query blocks inline
// would make this the file nobody wants to touch.

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { requireStaff } from "@/lib/auth/guard";
import { can, scopedBranchId } from "@/lib/auth/rbac";
import DashboardView from "./DashboardView";
import { loadDashboard, type DashboardData } from "./dashboard-data";
import MyDayView from "./my-day/MyDayView";
import { loadMyDay, loadMyHistory } from "./my-day/data";
import { isPeriodKey, loadTechnicianStats } from "@/lib/performance";
import FrontDeskView from "./front-desk/FrontDeskView";
import { NO_BRANCH, loadFrontDesk } from "./front-desk/data";

export const dynamic = "force-dynamic";

/** A salon with no branches configured yet. Every figure is honestly zero. */
const NO_BRANCHES: DashboardData = {
  revenue: { todayHalalas: 0, deltaPct: null, week: [] },
  utilisation: { pct: 0, soldMin: 0, capacityMin: 0 },
  counts: { today: 0, upcoming: 0, noShowsWeek: 0 },
  branches: [],
  topServices: [],
  technicians: [],
  attention: [],
};

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

    return (
      <FrontDeskView
        branchId={branchId || ""}
        data={branchId ? await loadFrontDesk(branchId) : NO_BRANCH}
        canSetStatus={can(user.role, "bookings.status")}
        canReschedule={can(user.role, "bookings.reschedule")}
      />
    );
  }

  // The CEO spans branches; everyone else is pinned to their own. The scope is
  // a list of ids handed to the query, not a filter applied to the answer —
  // there is no moment where this page holds a figure it must not show.
  const scoped = scopedBranchId(user.role, user.branchId);
  const branchIds = scoped
    ? [scoped]
    : (
        await db
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.active, true))
          .orderBy(asc(branches.sort))
      ).map((b) => b.id);

  return (
    <DashboardView
      name={user.name}
      data={branchIds.length ? await loadDashboard(branchIds) : NO_BRANCHES}
      showRevenue={can(user.role, "dashboard.revenue")}
      denied={searchParams.denied ?? null}
    />
  );
}
