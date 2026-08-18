// Server component: services, add-ons, removal types, seasonal designs and
// branches all come from the database, so edits in /admin/catalog show up here.
// The interactive UI lives in BookingView; bookable times come from
// /api/availability rather than a hardcoded grid.
//
// `?refill=RON-XXXX` arrives from the button in the customer's booking history.
// It is re-validated here rather than trusted: an expired or spent window simply
// yields no offer and the page renders as an ordinary booking.

import { getPublicBranches, getPublicCatalog } from "@/lib/catalog";
import { getRefillOffer } from "@/lib/bookings";
import BookingView from "./BookingView";

export const dynamic = "force-dynamic";

export default async function BookingPage({
  searchParams,
}: {
  searchParams: { refill?: string };
}) {
  // Branch names are needed in both languages because the client can toggle
  // language without a round-trip.
  const [catalog, branchesAr, branchesEn, refill] = await Promise.all([
    getPublicCatalog(),
    getPublicBranches("ar"),
    getPublicBranches("en"),
    searchParams.refill ? getRefillOffer(searchParams.refill) : null,
  ]);

  return (
    <BookingView
      catalog={catalog}
      branchesAr={branchesAr}
      branchesEn={branchesEn}
      refill={refill}
    />
  );
}
