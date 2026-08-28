// Guest booking-ticket checks (Change 2 — the gate at the front door).
//
//   npm run check:ticket
//
// No database and no network: this is about token separation, which is pure
// crypto over lib/account/session.ts. The one thing that must never be true is
// that a token minted for one purpose opens another, so that is what this
// asserts. The prefixes are the only thing standing between a signed-in
// customer's session and a licence to cancel any booking whose reference they
// know — see readBookingTicket().
//
// Runs against the development fallback secret when AUTH_SECRET is unset, which
// is fine: these are relative claims about tokens minted under one key.

import assert from "node:assert";
import {
  mintBookingTicket,
  mintSession,
  mintSignupTicket,
  readBookingTicket,
  readSession,
  readSignupTicket,
} from "@/lib/account/session";

const BOOKING_ID = "11111111-2222-3333-4444-555555555555";
const CUSTOMER_ID = "99999999-8888-7777-6666-555555555555";

async function main() {
  // -- a ticket reads back as the booking it was minted for -------------------
  const ticket = await mintBookingTicket(BOOKING_ID);
  assert.equal(await readBookingTicket(ticket), BOOKING_ID);

  // -- and only that booking --------------------------------------------------
  const other = await mintBookingTicket(CUSTOMER_ID);
  assert.notEqual(await readBookingTicket(other), BOOKING_ID);

  // -- a SESSION is not a ticket ---------------------------------------------
  // The one that matters. Without the `booking:` prefix check this would return
  // the customer id, mayActOnBooking() would compare it to a booking id, and a
  // signed-in customer would hold a skeleton key for every reference they saw.
  const session = await mintSession(CUSTOMER_ID);
  assert.equal(await readBookingTicket(session), null);

  // -- a signup ticket is not a booking ticket -------------------------------
  const signup = await mintSignupTicket("someone@example.com");
  assert.equal(await readBookingTicket(signup), null);

  // -- and a booking ticket is neither of those ------------------------------
  assert.equal(await readSignupTicket(ticket), null);
  // readSession is prefix-blind by design — it is the shared decoder the three
  // readers sit on top of. It returns the raw subject, which is exactly why the
  // prefix checks above have to exist in the readers.
  assert.equal(await readSession(ticket), `booking:${BOOKING_ID}`);

  // -- garbage is null, never a throw ----------------------------------------
  assert.equal(await readBookingTicket(undefined), null);
  assert.equal(await readBookingTicket(""), null);
  assert.equal(await readBookingTicket("not-a-jwt"), null);
  assert.equal(await readBookingTicket(ticket.slice(0, -4)), null);

  console.log("✓ booking tickets are scoped to one booking and nothing else");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
