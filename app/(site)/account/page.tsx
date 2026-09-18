// The account screen (brief §2.8).
//
// A server component, so the signed-out and signed-in states are decided before
// anything renders — no flash of the wrong screen, and the balance and bookings
// arrive with the page rather than after it.

import type { Metadata } from "next";
import { currentCustomer } from "@/lib/account/guard";
import { loyaltyBalance, loyaltyRules } from "@/lib/loyalty";
import { packCredits } from "@/lib/packs";
import { bookingSummaries } from "@/lib/bookings";
import AccountView from "./AccountView";

export const metadata: Metadata = { title: "Red Or Nude — Account" };

// The session cookie makes this per-request by definition.
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const customer = await currentCustomer();

  // Signed out: the sign-in form, and nothing else. No booking data is fetched
  // and none is sent — but the rules are, because the advert under the form
  // quotes the offer, and that is the reason to make an account at all.
  if (!customer) return <AccountView rules={await loyaltyRules()} />;

  const [rules, balance, credits, history] = await Promise.all([
    loyaltyRules(),
    loyaltyBalance(customer.id),
    // What her memberships have left. This is the screen a customer opens to
    // check, and until now it was the one place that did not say: she bought a
    // membership and the only trace of it was on the shelf she bought it from.
    packCredits(customer.id),
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
      rules={rules}
      credits={credits.map((c) => ({
        customerPackId: c.customerPackId,
        packName: c.packName,
        serviceId: c.serviceId,
        serviceName: c.serviceName,
        left: c.left,
        granted: c.granted,
        expiresAt: c.expiresAt.toISOString(),
      }))}
      history={history}
    />
  );
}
