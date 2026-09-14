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
import { currentCustomer } from "@/lib/account/guard";
import { packCredits } from "@/lib/packs";
import BookingView from "./BookingView";

export const dynamic = "force-dynamic";

export default async function BookingPage({
  searchParams,
}: {
  searchParams: { refill?: string };
}) {
  // Branch names are needed in both languages because the client can toggle
  // language without a round-trip.
  const [catalog, branchesAr, branchesEn, refill, customer] = await Promise.all([
    getPublicCatalog(),
    getPublicBranches("ar"),
    getPublicBranches("en"),
    searchParams.refill ? getRefillOffer(searchParams.refill) : null,
    currentCustomer(),
  ]);

  // Pack credits she can spend here. Empty for a guest, which is not a wall —
  // an account is optional everywhere on this page, and a customer with no
  // credits simply never sees the row. Solo only: a pack paying for a group
  // booking is out of this phase (docs/SCOPE-ENHANCEMENT.md §8).
  const credits = customer ? await packCredits(customer.id) : [];

  return (
    <BookingView
      catalog={catalog}
      branchesAr={branchesAr}
      branchesEn={branchesEn}
      credits={credits.map((c) => ({
        customerPackId: c.customerPackId,
        packName: c.packName,
        serviceId: c.serviceId,
        left: c.left,
      }))}
      refill={refill}
    />
  );
}
