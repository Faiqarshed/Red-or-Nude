// Who is signed in, as far as a checkout needs to know.
//
// The booking picker never asks for a name, a phone or an email — the payment
// screen does, because a booking needs somebody to belong to. For a signed-in
// customer every one of those is already on her account, and asking her to type
// them again is asking her to prove something the cookie already proved.
//
// Resolved from the session cookie and **never from the body**: an id in a
// request is an id somebody can change, and what is on the other side of this
// one is a customer's own contact details.
//
// Signed out answers `{ signedIn: false }` and nothing else. A guest checkout
// must keep working without an account (brief §2.8), so this is a prefill and
// never a gate.

import { NextResponse } from "next/server";
import { currentCustomer } from "@/lib/account/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ signedIn: false });

  return NextResponse.json({
    signedIn: true,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
  });
}
