// Server component: packs and their contents come from the database, so the
// admin decides what is on the shelf.
//
// Whether she is signed in is decided here too, and passed down. Buying needs an
// account — the credits have to belong to somebody — and a page that offers a
// buy button it will refuse is worse than one that says so up front.

import { getPublicPacks } from "@/lib/catalog";
import { currentCustomer } from "@/lib/account/guard";
import { packCredits } from "@/lib/packs";
import PacksView from "./PacksView";

export const dynamic = "force-dynamic";

export default async function PacksPage() {
  const [packs, customer] = await Promise.all([getPublicPacks(), currentCustomer()]);
  // What she already holds, so the shelf can say "you have 3 left" rather than
  // selling her a second one she did not mean to buy.
  const credits = customer ? await packCredits(customer.id) : [];

  return (
    <PacksView
      packs={packs}
      signedIn={Boolean(customer)}
      credits={credits.map((c) => ({
        serviceName: c.serviceName,
        left: c.left,
        expiresAt: c.expiresAt.toISOString(),
      }))}
    />
  );
}
