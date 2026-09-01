import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/auth/rbac";
import { branchScope } from "@/lib/admin/branch-scope";
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
export default async function FrontDeskPage({
  searchParams,
}: {
  searchParams: { branch?: string };
}) {
  const user = await requirePage("bookings.checkin");

  // One desk at a time: a desk is a place, and the CEO — who is pinned to no
  // branch — got the first one and no way to reach another. She picks now, with
  // the first still the default so nobody lands on nothing.
  const { branchId: pinned, options: branchOptions } = await branchScope(user, searchParams.branch);
  const branchId = pinned ?? branchOptions[0]?.id;

  const canSetStatus = can(user.role, "bookings.status");
  const canReschedule = can(user.role, "bookings.reschedule");

  if (!branchId) {
    return (
      <FrontDeskView
        branchId=""
        branchOptions={branchOptions}
        data={NO_BRANCH}
        canSetStatus={canSetStatus}
        canReschedule={canReschedule}
      />
    );
  }

  return (
    <FrontDeskView
      branchId={branchId}
      branchOptions={branchOptions}
      data={await loadFrontDesk(branchId)}
      canSetStatus={canSetStatus}
      canReschedule={canReschedule}
    />
  );
}
