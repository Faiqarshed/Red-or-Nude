// Look up a booking by its reference — and the only place the refill button lives.
//
// Entirely client-driven: there is no session to render from, so the page ships
// empty and fills itself once a booking reference is entered, and remembers
// nothing afterwards. Nobody is logged in here, which is why the copy never says
// "my" or "your account". See app/api/my-bookings/route.ts for why the reference
// is enough on its own.

import MyBookingsView from "./MyBookingsView";

export const metadata = { title: "Bookings" };

export default function MyBookingsPage() {
  return <MyBookingsView />;
}
