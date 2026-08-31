// The account screen (brief §2.8).
//
// A server component, so the signed-out and signed-in states are decided before
// anything renders — no flash of the wrong screen, and the balance and bookings
// arrive with the page rather than after it.

import type { Metadata } from "next";
import { currentCustomer } from "@/lib/account/guard";
import { loyaltyBalance } from "@/lib/loyalty";
import { bookingSummaries } from "@/lib/bookings";
import AccountView from "./AccountView";

export const metadata: Metadata = { title: "Red Or Nude — Account" };

// The session cookie makes this per-request by definition.
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const customer = await currentCustomer();

  // Signed out: the sign-in form, and nothing else. No booking data is fetched
  // and none is sent.
  if (!customer) return <AccountView />;

  const [balance, history] = await Promise.all([
    loyaltyBalance(customer.id),
    // Every booking this customer has, newest first. No reference and no code:
    // the session *is* the credential here, which is the whole reason an account
    // is worth having over /my-bookings.
    //
    // The same function POST /api/my-bookings calls, so the cards render
    // identically on both screens and — the part that matters — neither screen
    // can quietly start revealing more than the other.
    bookingSummaries({ customerId: customer.id }),
  ]);

  return (
    <AccountView
      customer={{
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        birthday: customer.birthday,
      }}
      balance={balance}
      history={history}
    />
  );
}
