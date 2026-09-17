// Paying for a membership, on its own screen.
//
// It used to be an aside beside the shelf, which put a card form on a browsing
// page and asked the customer to read a grid and a checkout at once. Every other
// purchase on this site goes to a payment screen; this one now does too.
//
// The membership is named by `?pack=` and re-read here from the database rather
// than carried over from the shelf. The price shown is therefore the price the
// server holds, and a stale tab cannot present an old one — POST /api/packs
// re-reads it again anyway, so nothing here is trusted with money.

import { redirect } from "next/navigation";
import { getPublicPacks } from "@/lib/catalog";
import { currentCustomer } from "@/lib/account/guard";
import MembershipPaymentView from "./MembershipPaymentView";

export const dynamic = "force-dynamic";

export default async function MembershipPaymentPage({
  searchParams,
}: {
  searchParams: { pack?: string };
}) {
  const [packs, customer] = await Promise.all([getPublicPacks(), currentCustomer()]);

  // No membership named, or one that is no longer on the shelf — the salon may
  // have retired it while this tab sat open. Back to the shelf rather than an
  // error: what she wanted is a membership, and they are all right there.
  const pack = packs.find((p) => p.id === searchParams.pack);
  if (!pack) redirect("/memberships");

  return <MembershipPaymentView pack={pack} signedIn={Boolean(customer)} />;
}
