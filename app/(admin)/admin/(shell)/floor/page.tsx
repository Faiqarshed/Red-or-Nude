import { requirePage } from "@/lib/auth/guard";
import { branchScope } from "@/lib/admin/branch-scope";
import { loadFloor } from "./data";
import FloorView from "./FloorView";

export const dynamic = "force-dynamic";

export default async function FloorPage({
  searchParams,
}: {
  searchParams: { branch?: string };
}) {
  // The floor, not the staff records — so this is the desk's capability, the
  // same one that lets her check somebody in. See ./actions.ts.
  const user = await requirePage("bookings.checkin");

  // A floor is a place, so there is no "all branches" here — the CEO picks one
  // rather than being shown an impossible merge of every salon. Falling back to
  // the first keeps an unpinned account on a usable screen.
  const { branchId: pinned, options } = await branchScope(user, searchParams.branch);
  const branchId = pinned ?? options[0]?.id;

  if (!branchId) return <FloorView data={{ technicians: [], rows: [] }} branchId="" branchOptions={[]} />;

  return (
    <FloorView
      data={await loadFloor(branchId)}
      branchId={branchId}
      branchOptions={options}
    />
  );
}
