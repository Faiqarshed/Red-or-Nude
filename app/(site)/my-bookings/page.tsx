// Look up a booking by its reference — the *guest* way into a booking.
//
// Client-driven from there on: there is no session to render from, so the page
// ships empty and fills itself once a reference is entered, and remembers
// nothing afterwards. See app/api/my-bookings/route.ts for why the reference is
// enough on its own.
//
// A signed-in customer never sees it. /account is a strict superset — the same
// cards with the same actions, plus the wallet, and without a code to fetch from
// an inbox — so sending them here would be asking them to authenticate twice for
// less. The nav swaps the link for them (components/SiteHeader.tsx); this
// redirect is what makes an old bookmark agree.

import { redirect } from "next/navigation";
import { currentCustomer } from "@/lib/account/guard";
import MyBookingsView from "./MyBookingsView";

export const metadata = { title: "Bookings" };

// Reading the session cookie makes this per-request.
export const dynamic = "force-dynamic";

export default async function MyBookingsPage() {
  if (await currentCustomer()) redirect("/account");
  return <MyBookingsView />;
}
