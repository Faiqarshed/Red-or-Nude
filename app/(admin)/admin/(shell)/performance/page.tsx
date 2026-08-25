// Per-technician timings (brief §3.2).
//
// Its own route rather than a tab on /admin/staff: that page is staff CRUD, and
// folding an aggregate query into it tangles two unrelated things.
//
// The arithmetic lives in lib/performance.ts, shared with the technician's own
// screen — an average that differed depending on who was reading it would be
// worse than no average at all.

import { requirePage } from "@/lib/auth/guard";
import { scopedBranchId } from "@/lib/auth/rbac";
import { isPeriodKey, loadTechnicianStats } from "@/lib/performance";
import PerformanceView from "./PerformanceView";

export const dynamic = "force-dynamic";

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: { period?: string };
}) {
  const user = await requirePage("staff.performance");
  const period = isPeriodKey(searchParams.period) ? searchParams.period : "7";

  const stats = await loadTechnicianStats({
    period,
    branchId: scopedBranchId(user.role, user.branchId),
  });

  return <PerformanceView stats={stats} period={period} />;
}
