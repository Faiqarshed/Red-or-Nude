// Server component: services, add-ons, removal types, seasonal designs and
// branches all come from the database, so edits in /admin/catalog show up here.
// The interactive UI lives in BookingView; bookable times come from
// /api/availability rather than a hardcoded grid.

import { getPublicBranches, getPublicCatalog } from "@/lib/catalog";
import BookingView from "./BookingView";

export const dynamic = "force-dynamic";

export default async function BookingPage() {
  // Branch names are needed in both languages because the client can toggle
  // language without a round-trip.
  const [catalog, branchesAr, branchesEn] = await Promise.all([
    getPublicCatalog(),
    getPublicBranches("ar"),
    getPublicBranches("en"),
  ]);

  return <BookingView catalog={catalog} branchesAr={branchesAr} branchesEn={branchesEn} />;
}
