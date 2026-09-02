# Known bugs — booking and availability

Found by `tests/booking/`. Not fixed — reported, per the skill's rule.

---

## BUG-BOOK-001 — the booking route trusts the client's start time  ·  P1  ·  PARTLY FIXED 2026-09-03

**Where** `app/api/bookings/route.ts:125` → `lib/bookings.ts:622`
**Tests** `tests/booking/concurrency.test.ts` — "refuses a booking in the past,
at the public route" (passing), "still accepts a slot chosen seconds ago"
(passing), "still lets the salon seat a walk-in into a chair a no-show just
freed" (passing), and "refuses the two start times outside the branch's opening
hours" (`it.fails` — still open).

### What happens

`POST /api/bookings` validates `startsAt` with `z.string().datetime()` and passes
it down. `createBookings` asks `reserveStations` one question — *is a chair free
across this window* — and writes the row if the answer is yes. Nothing anywhere
on the path asks whether the availability engine would have **offered** that
moment.

| Posted `startsAt` | Before | Now |
|---|---|---|
| Yesterday | booked | **400 `slot-in-past`** |
| 07:00 local, branch opens 10:00 | booked | booked — still open |
| 21:30 local + a 90-minute service, branch closes 22:00 | booked | booked — still open |

A closed weekday and a `closures` row are the same shape and almost certainly
behave like the two still-open rows.

### The fix so far, 2026-09-03

A start time more than two minutes in the past is refused with
`400 slot-in-past`, in `app/api/bookings/route.ts`.

**Why the route and not `createBookings`.** The library must keep accepting a
past start: a no-show frees a slot that has already begun and the walk-in drawer
seats somebody into it. `scripts/check-booking.ts` asserts exactly that — "no-show:
freed chair is immediately rebookable" — and it still passes. This is the same
split `app/api/availability/route.ts` already draws when it passes
`leadTimeMin: 0` for signed-in staff and the branch's real lead time for
everyone else: staff reach the floor through the admin actions, and this route
is the public one.

**Why a two-minute grace.** A slot picked at 14:00 and confirmed at 14:00:03 was
honestly available when it was chosen; refusing it would be a bug report nobody
could reproduce. Small enough that it cannot reach a slot that has meaningfully
passed. Asserted in both directions.

### Still open — opening hours and closing time

Deliberately not fixed in the same change. Checking those safely means asking
the availability engine whether the slot was offered, and the station QR add-on
(brief §2.7) books at a *projected finish time* that may not sit on the engine's
slot grid. A careless check there would break a real flow in order to close a
smaller hole, so it wants its own change with the QR flow tested alongside.

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
