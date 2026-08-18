// The customer's booking history — and the only place the refill button lives.
//
// Entirely client-driven: there is no session to render from, so the page ships
// empty and fills itself once a booking reference is entered. See
// app/api/my-bookings/route.ts for why the reference is enough on its own.

import MyBookingsView from "./MyBookingsView";

export const metadata = { title: "My bookings" };

export default function MyBookingsPage() {
  return <MyBookingsView />;
}
