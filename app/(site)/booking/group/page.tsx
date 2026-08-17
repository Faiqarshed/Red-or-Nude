// Server component: same catalogue and branches as /booking. The only difference
// on this route is that two guests are picking, and the slot has to fit both.

import { getPublicBranches, getPublicCatalog } from "@/lib/catalog";
import { getSettings } from "@/lib/settings";
import GroupBookingView from "./GroupBookingView";

export const dynamic = "force-dynamic";

export default async function GroupBookingPage() {
  const [catalog, branchesAr, branchesEn, settings] = await Promise.all([
    getPublicCatalog(),
    getPublicBranches("ar"),
    getPublicBranches("en"),
    // The discount is a setting, not a constant — the page must quote whatever
    // the server will actually charge.
    getSettings(["group_discount_percent"]),
  ]);

  return (
    <GroupBookingView
      catalog={catalog}
      branchesAr={branchesAr}
      branchesEn={branchesEn}
      discountPercent={settings.group_discount_percent}
    />
  );
}
