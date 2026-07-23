import { and, asc, eq, gte, or, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { branchHours, branches, closures, stations } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { scopedBranchId } from "@/lib/auth/rbac";
import AvailabilityView from "./AvailabilityView";

export const dynamic = "force-dynamic";

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: { branch?: string };
}) {
  const user = await requirePage("availability.manage");

  const branchRows = await db.select().from(branches).orderBy(asc(branches.sort));
  const pinned = scopedBranchId(user.role, user.branchId);
  const branchId =
    pinned ?? (searchParams.branch && branchRows.some((b) => b.id === searchParams.branch)
      ? searchParams.branch
      : branchRows[0]?.id);

  if (!branchId) {
    return <AvailabilityView branchId="" branches={[]} hours={[]} stations={[]} closures={[]} />;
  }

  const [hourRows, stationRows, closureRows] = await Promise.all([
    db.select().from(branchHours).where(eq(branchHours.branchId, branchId)).orderBy(asc(branchHours.weekday)),
    db.select().from(stations).where(eq(stations.branchId, branchId)).orderBy(asc(stations.sort)),
    db
      .select()
      .from(closures)
      // Closures with no branch are global, so they belong on every branch's page.
      .where(
        and(
          or(eq(closures.branchId, branchId), isNull(closures.branchId)),
          gte(closures.endsAt, new Date()),
        ),
      )
      .orderBy(asc(closures.startsAt)),
  ]);

  return (
    <AvailabilityView
      branchId={branchId}
      branches={branchRows.map((b) => ({ id: b.id, name: b.name }))}
      hours={Array.from({ length: 7 }, (_, weekday) => {
        const row = hourRows.find((h) => h.weekday === weekday);
        return {
          weekday,
          opens: row?.opens?.slice(0, 5) ?? "09:00",
          closes: row?.closes?.slice(0, 5) ?? "23:00",
          closed: row?.closed ?? false,
        };
      })}
      stations={stationRows.map((s) => ({ id: s.id, label: s.label, active: s.active }))}
      closures={closureRows.map((c) => ({
        id: c.id,
        global: c.branchId === null,
        startsAt: c.startsAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        reason: c.reason,
      }))}
    />
  );
}
