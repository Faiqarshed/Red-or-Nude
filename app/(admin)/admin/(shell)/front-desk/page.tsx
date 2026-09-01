import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/auth/rbac";
import { NO_BRANCH, loadFrontDesk } from "./data";
import FrontDeskView from "./FrontDeskView";

export const dynamic = "force-dynamic";

/**
 * The desk, at a URL of its own.
 *
 * A receptionist still *lands* on this screen at /admin, which is what she wants
 * on opening the panel. But the desk is not hers alone: an admin covering a
 * lunch break, or the CEO checking why a ticket is stuck, holds bookings.checkin
 * too and had nowhere to use it — /admin renders them the revenue dashboard.
 * This route is that missing door.
 */
export default async function FrontDeskPage() {
  const user = await requirePage("bookings.checkin");

  // One desk at a time: a floor is a place, and the CEO — who is pinned to no
  // branch — gets the first one rather than an impossible merge of all of them.
  const branchId =
    user.branchId ??
    (await db.select({ id: branches.id }).from(branches).orderBy(asc(branches.sort)).limit(1))[0]
      ?.id;

  const canSetStatus = can(user.role, "bookings.status");
  const canReschedule = can(user.role, "bookings.reschedule");

  if (!branchId) {
    return (
      <FrontDeskView
        branchId=""
        data={NO_BRANCH}
        canSetStatus={canSetStatus}
        canReschedule={canReschedule}
      />
    );
  }

  return (
    <FrontDeskView
      branchId={branchId}
      data={await loadFrontDesk(branchId)}
      canSetStatus={canSetStatus}
      canReschedule={canReschedule}
    />
  );
}
