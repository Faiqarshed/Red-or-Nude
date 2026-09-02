# Known bugs — booking and availability

Found by `tests/booking/`. Not fixed — reported, per the skill's rule.

---

## BUG-BOOK-001 — the booking route trusts the client's start time  ·  P1

**Where** `app/api/bookings/route.ts:125` → `lib/bookings.ts:622`
**Test** `tests/booking/concurrency.test.ts` — "refuses the three start times the
slot engine would never offer" (`it.fails`), with current behaviour pinned by
"today, all three are written to the books".

### What happens

`POST /api/bookings` validates `startsAt` with `z.string().datetime()` and passes
it down. `createBookings` asks `reserveStations` one question — *is a chair free
across this window* — and writes the row if the answer is yes. Nothing anywhere
on the path asks whether the availability engine would have **offered** that
moment.

All three of these are accepted today:

| Posted `startsAt` | Result |
|---|---|
| Yesterday | booked |
| 07:00 local, branch opens 10:00 | booked |
| 21:30 local + a 90-minute service, branch closes 22:00 | booked, finishing at 23:00 |

A closed weekday and a `closures` row are the same shape and almost certainly
behave the same way.

### Why it matters

The browser only ever shows real slots, so this is not reachable through the UI.
It is reachable with `curl`. The consequences are operational rather than
financial: an appointment appears on a technician's day at 07:00, the salon's
roll call contains a booking for a date that has passed, and capacity planning
counts work nobody will do. It also takes a real chair, so it can be used to
deny slots the engine would otherwise offer.

### The engine itself is fine

Asserted separately: `getDayAvailability` does not offer 07:00 on an open
Saturday, and does offer other times that day. The hole is the route accepting a
start time instead of asking the engine, not the engine being wrong.

### Note on where the guard belongs

`rescheduleBooking` documents a deliberate split — "this is the mechanics of
moving a booking. Who is allowed to move it, and how late, belongs to the
caller." By that reasoning `createBookings` is right to stay mechanical and the
check belongs in `app/api/bookings/route.ts`, which is the surface the public
can reach. The admin walk-in path calls `createBookings` directly and must keep
being able to seat someone right now, so a check pushed down into the library
would break the counter — see the `leadTimeMin` override at
`lib/availability.ts:281` for the existing precedent on that distinction.

---

## Verified sound — recorded so it is not re-litigated

Ten concurrency cases pass against real Postgres. `reserveStations`'s `for
update` lock does what its comment claims:

- Two customers for the last chair → exactly one wins, the other gets
  `slot-taken`.
- Eight at once against two chairs → exactly two win, on two *different* chairs.
- An overlap starting at a different minute is refused — the case the
  `bookings_station_slot_unique` index explicitly cannot catch.
- A group of three into two chairs seats nobody, rather than a partial group.
- 11:00–12:00 followed by 12:00–13:00 both fit on one chair; a one-minute
  overlap does not.
- A cancelled booking gives its chair back; a `pending` hold does not.
- Deactivating a chair stops new bookings without disturbing existing ones.
