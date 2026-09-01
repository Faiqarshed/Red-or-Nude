// Per-technician timings (brief §3.2).
//
// Its own route rather than a tab on /admin/staff: that page is staff CRUD, and
// folding an aggregate query into it tangles two unrelated things.
//
// The arithmetic lives in lib/performance.ts, shared with the technician's own
// screen — an average that differed depending on who was reading it would be
// worse than no average at all.

import { requirePage } from "@/lib/auth/guard";
import { branchScope } from "@/lib/admin/branch-scope";
import { isPeriodKey, loadTechnicianStats } from "@/lib/performance";
import PerformanceView from "./PerformanceView";

export const dynamic = "force-dynamic";

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: { period?: string; branch?: string };
}) {
  const user = await requirePage("staff.performance");
  const period = isPeriodKey(searchParams.period) ? searchParams.period : "7";

  const { branchId, options } = await branchScope(user, searchParams.branch);
  const stats = await loadTechnicianStats({ period, branchId });

  return (
    <PerformanceView
      stats={stats}
      period={period}
      branchId={branchId}
      branchOptions={options}
    />
  );
}
