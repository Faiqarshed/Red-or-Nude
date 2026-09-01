// Every technician's day, on any date (brief §3.2).
//
// The gap this fills: a technician can read her own day at /admin, and nobody
// above her could read anyone's. /admin/floor answers the same question for
// today only, and answers it as a floor — who is in, who has gone home, whose
// customers need moving. This is the same rows read as a record, for a date the
// admin picks, which is what "what did she do on Tuesday" needs.
//
// Deliberately not merged into /admin/performance. That screen is averages over
// a period; this one is a single day in full. Same subject, different question,
// and folding one into the other would give a screen with two date controls that
// disagree.

import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { scopedBranchId } from "@/lib/auth/rbac";
import { localToUtc } from "@/lib/availability";
import { riyadhDateKey } from "@/lib/time";
import { loadFloor } from "../floor/data";
import TechniciansView from "./TechniciansView";

export const dynamic = "force-dynamic";

export default async function TechniciansPage({
  searchParams,
}: {
  searchParams: { date?: string; branch?: string };
}) {
  const user = await requirePage("staff.performance");

  const branchRows = await db.select().from(branches).orderBy(asc(branches.sort));

  // The CEO chooses; everyone else is pinned by their own branch, and is not
  // offered a picker that would change nothing.
  const pinned = scopedBranchId(user.role, user.branchId);
  const branchId =
    pinned ??
    (searchParams.branch && branchRows.some((b) => b.id === searchParams.branch)
      ? searchParams.branch
      : branchRows[0]?.id);

  const date = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date ?? "")
    ? searchParams.date!
    : riyadhDateKey();

  return (
    <TechniciansView
      date={date}
      today={riyadhDateKey()}
      branchId={branchId ?? ""}
      branches={pinned ? [] : branchRows.map((b) => ({ id: b.id, name: b.name }))}
      // A day is a Riyadh day, and localToUtc is what the bookings screen uses
      // to say so — midday rather than midnight, so the range never lands on the
      // wrong side of the offset.
      data={
        branchId
          ? await loadFloor(branchId, localToUtc(date, "12:00"))
          : { technicians: [], rows: [] }
      }
    />
  );
}
