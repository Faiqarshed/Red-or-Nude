import { and, count, eq, gte, lt, sum } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, services } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { can, scopedBranchId } from "@/lib/auth/rbac";
import { riyadhDayRange } from "@/lib/time";
import { formatSAR } from "@/lib/money";
import DashboardView from "./DashboardView";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { denied?: string };
}) {
  const user = await requirePage("dashboard.view");

  // Owners see every branch; everyone else is filtered to their own. The scope
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
