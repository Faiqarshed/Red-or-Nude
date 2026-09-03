# Requirement register — `booking`

Phase 1 of `nextjs-drizzle-hardening`. Every row is a verbatim behavioural claim
lifted from `docs/`, with the file and line it came from. Vocabulary is the
glossary's: `BKG` bookings, `BRN` branches, `BHR` branch_hours, `STA` stations,
`CLO` closures, `TIC` ticket_counters.

Sources read in full: `docs/BOOKING-V2.md`, `docs/NO-SHOW-RELEASE.md`,
`docs/PERFORMANCE.md`, `docs/DAY-START-ASSIGNMENT.md`, plus `docs/ADMIN-PANEL.md`
§5, which is the only written specification of the availability engine.

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-001 | BOOKING-V2.md:13 | "Picking a time now only *holds* the chair. The booking is not confirmed … until money has changed hands." | state | P0 |
| REQ-BKG-002 | BOOKING-V2.md:15 | "Walk away and the hold releases itself." | side-effect | P0 |
| REQ-BKG-003 | BOOKING-V2.md:16 | Once paid a booking gets `A1 … A99, B1`, restarting every day at every branch. | state | P1 |
| REQ-BKG-004 | BOOKING-V2.md:20 | Two guests, own services, **one shared appointment time**, one bill, 10% cheaper, two tickets, two chairs. | state | P0 |
| REQ-BKG-005 | BOOKING-V2.md:37 | The hold writes rows as `status = "pending"`, `ticket_no = null`. | state | P0 |
| REQ-BKG-006 | BOOKING-V2.md:59 | "There is no `booking_groups` table" — a group is two ordinary rows sharing a `group_id`. | state | P1 |
| REQ-BKG-007 | BOOKING-V2.md:106 | The ticket counter is incremented and returns the range **in one statement**, so the row lock serialises it. | side-effect | P1 |
| REQ-BKG-008 | BOOKING-V2.md:108 | Asking for two at once is what gives a group its consecutive pair. | state | P1 |
| REQ-BKG-009 | BOOKING-V2.md:110 | The counter day is the day of the **appointment**, not of payment. | state | P1 |
| REQ-BKG-010 | BOOKING-V2.md:122 | `discount = round(combined gross x 10%)` — "the only rounding anywhere". | validation | P0 |
| REQ-BKG-011 | BOOKING-V2.md:130 | The two guests' totals must add back up to what the card was charged. | validation | P0 |
| REQ-BKG-012 | BOOKING-V2.md:131 | "A single guest at 0% is a no-op." | validation | P0 |
| REQ-BKG-013 | BOOKING-V2.md:144 | Two chairs are checked free for the **longer** job; each guest's row keeps its own end time. | state | P0 |
| REQ-BKG-014 | BOOKING-V2.md:145 | "Booking therefore always claims less than what was checked, so a slot shown as available can never fail on confirm." | state | P0 |
| REQ-BKG-015 | BOOKING-V2.md:158 | Stale holds are **cancelled**, as the first statement of every booking write. | side-effect | P0 |
| REQ-BKG-016 | BOOKING-V2.md:160 | Controlled by `booking_hold_min` (default 15). | validation | P1 |
| REQ-BKG-017 | BOOKING-V2.md:161 | "Admin-created pending bookings are never swept." | authz | P1 |
| REQ-BKG-018 | BOOKING-V2.md:203 | Chair choice happens under a `FOR UPDATE` lock inside the insert transaction — overlapping bookings at *different* start times must not land on one chair. | state | P0 |
| REQ-BKG-019 | BOOKING-V2.md:204 | The conflict check is strict on the end boundary — a slot offered must not fail on confirm. | validation | P0 |
| REQ-BKG-020 | BOOKING-V2.md:205 | The uniqueness rule is partial: a cancelled / no-show booking gives its chair back. | state | P0 |
| REQ-BKG-021 | BOOKING-V2.md:206 | `isSlotConflict()` walks the cause chain — a lost race is reported as a lost race, not a server fault. | validation | P1 |
| REQ-BKG-022 | BOOKING-V2.md:255 | The Saudi mobile must be 10 digits starting `05`. | validation | P0 |
| REQ-BKG-023 | BOOKING-V2.md:279 | A group gets consecutive tickets on **different** chairs. | state | P0 |
| REQ-BKG-024 | BOOKING-V2.md:308 | With `booking_hold_min = 0`, five holds on one slot at a four-chair branch all succeed — each new attempt sweeps the stale ones first. | side-effect | P1 |
| REQ-BKG-025 | BOOKING-V2.md:314 | A swept hold is `cancelled` with `cancel_reason = 'payment-timeout'`. | state | P1 |
| REQ-BKG-026 | BOOKING-V2.md:329 | A slot with one free chair must be `available: true` for `guests=1` and `false` for `guests=2`. | state | P0 |
| REQ-BKG-027 | BOOKING-V2.md:333 | A walk-in confirms instantly and takes a ticket from the same daily queue as web bookings. | state | P1 |
| REQ-BKG-028 | BOOKING-V2.md:354 | "Groups are capped at two" in the API and UI; the engine handles N. | validation | P1 |
| REQ-AVL-029 | ADMIN-PANEL.md:246 | `slotsFor = branch_hours[weekday(date)] − closures overlapping date × active stations − bookings occupying that station/time`. | state | P0 |
| REQ-AVL-030 | ADMIN-PANEL.md:250 | Slots are `settings.slot_length` apart, filtered to `now + lead_time`. | state | P0 |
| REQ-AVL-031 | ADMIN-PANEL.md:109 | `branch_hours.weekday` is 0-6; the glossary and `lib/time.ts:riyadhWeekday` fix **0 = Saturday**. | validation | P0 |
| REQ-AVL-032 | ADMIN-PANEL.md:111 | A `closures` row with a null `branch_id` applies to every branch. | authz | P0 |
| REQ-AVL-033 | ADMIN-PANEL.md:253 | One engine, called by both the public booking API and the admin calendar, "so the two can never disagree". | state | P0 |
| REQ-NSH-034 | NO-SHOW-RELEASE.md:3 | If nobody checks a customer in within 20 minutes of their slot, the chair is released automatically. | side-effect | P0 |
| REQ-NSH-035 | NO-SHOW-RELEASE.md:33 | "Setting the status **is** the release" — `no_show` is excluded by the index, `reserveStations` and the conflict scan alike. | state | P0 |
| REQ-NSH-036 | NO-SHOW-RELEASE.md:43 | `status = 'confirmed'` only — `in_progress` and `completed` mean the customer arrived. | state | P0 |
| REQ-NSH-037 | NO-SHOW-RELEASE.md:44 | `no_show_at is null` makes the sweep idempotent. | side-effect | P0 |
| REQ-NSH-038 | NO-SHOW-RELEASE.md:45 | **AMBIGUOUS — see `known-bugs-booking.md` D-1.** Doc says `starts_at >= dayStart`, "today only". Code says a 7-day lookback (`NO_SHOW_LOOKBACK_DAYS`). | state | P0 |
| REQ-NSH-039 | NO-SHOW-RELEASE.md:52 | Three call sites: `createBookings`, `GET /api/availability`, the admin bookings page. | side-effect | P1 |
| REQ-NSH-040 | NO-SHOW-RELEASE.md:100 | `walkIn=1` is honoured **only** when `currentStaff()` returns someone. | authz | P0 |
| REQ-NSH-041 | NO-SHOW-RELEASE.md:101 | The flag is parsed as a literal `"1"` — `walkIn=0` must not switch it on. | validation | P0 |
| REQ-NSH-042 | NO-SHOW-RELEASE.md:105 | "`createBookings` never enforced lead time itself — only the slot grid hid those times." | state | P0 |
| REQ-NSH-043 | NO-SHOW-RELEASE.md:121 | A `no_show` a receptionist set by hand has a null `no_show_at`. | state | P2 |
| REQ-PRF-044 | PERFORMANCE.md:65 | `getSettings` reads the whole table once into a process cache; every caller after the first costs nothing. | side-effect | P1 |
| REQ-PRF-045 | PERFORMANCE.md:186 | The station lock serialises bookings per branch — simultaneous bookings at one branch queue up. That is the double-booking guarantee. | state | P0 |
| REQ-PRF-046 | PERFORMANCE.md:196 | Call **counts** are the number to watch, not timings. | side-effect | P1 |
| REQ-PRF-047 | PERFORMANCE.md:7 | "Every optimisation here removes a network round trip." A whole month is computed from one context load. | side-effect | P1 |
| REQ-DSA-048 | DAY-START-ASSIGNMENT.md:1 | A reschedule onto today re-staffs straight away; a move to a later day stays unassigned until that morning's run. | side-effect | P2 |

## Reverse trace

Every P0 row has at least one TC in `test-cases-booking.md`. Rows whose surface
belongs to another agent's area (payments confirm, the admin day grid) are marked
`N/A — other area` there rather than dropped.

## Requirements the code has and `docs/` does not

Real behaviours with no written spec. Characterized in Phase 4 tests and listed
as documentation gaps in `surface-map-booking.md`:

- `SlotBlocker` — `closed | past | full | too-soon` and their precedence order.
  Described only in `lib/availability.ts:52-60`.
- `candidateStarts` "edge" slots: the exact moment a chair frees is offered even
  when it is off the grid (`lib/availability.ts:130-155`).
- `stationToken` pinning on `POST /api/bookings` (`route.ts:64-80`) and the
  `404 unknown-station` it returns.
- The per-IP throttle budgets: 10/min on bookings, 60/min on availability.
- `guests` capped at 2 by the availability query schema; `members` capped at 2 by
  the create schema.
- **Nothing in the write path consults `branch_hours` or `closures`.** See
  `known-bugs-booking.md` D-2.

---

## Source-derived requirements

Per `AGENT-BRIEF.md` §"The source is spec too". A comment that asserts behaviour
is a requirement; each is cited to the line that asserts it. Most contradict
nothing in `docs/` because `docs/` never mentions them at all — that is the point.

### `lib/slots.ts` — the one definition of "busy"

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-SLT-101 | lib/slots.ts:14 | `overlaps` is **half-open**: a span ending exactly when another starts does *not* collide. | validation | P0 |
| REQ-SLT-102 | lib/slots.ts:34 | `occupies` excludes `cancelled`, `completed` **and** `no_show` — all three hold nobody. | state | P0 |
| REQ-SLT-103 | lib/slots.ts:51 | `busyDuring` excludes the span's own booking id, or its technician always reads as unavailable for the row she is on. | state | P0 |
| REQ-SLT-104 | lib/slots.ts:58 | A row with a null `technicianId` is never in the busy set. | state | P1 |
| REQ-SLT-105 | lib/slots.ts:9 | Pure and client-safe — no `server-only`, no database. | state | P2 |

### `lib/time.ts` — Riyadh is UTC+3, no DST

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-TIM-106 | lib/time.ts:2 | A fixed +3 offset is exact for day boundaries; no tz database is consulted. | state | P0 |
| REQ-TIM-107 | lib/time.ts:10 | `riyadhDayRange` returns the local day start **inclusive** and end **exclusive**. | validation | P0 |
| REQ-TIM-108 | lib/time.ts:19 | `riyadhDateKey` is `YYYY-MM-DD` in Riyadh — the shape date-only columns store. | validation | P0 |
| REQ-TIM-109 | lib/time.ts:27-35 | `closureDays` inverts `addClosure`: `from` is the Riyadh date of `startsAt`, `to` the Riyadh date of `endsAt − 24h`, because `endsAt` is exclusive. Truncating in UTC lands a day early; printing `endsAt` lands a day late. | validation | P0 |
| REQ-TIM-110 | lib/time.ts:104 | `riyadhWeekday` is Saturday = 0, matching `branch_hours`. | validation | P0 |
| REQ-TIM-111 | lib/time.ts:44 | `localTime` is Riyadh wall clock `HH:MM` from an ISO string. | validation | P1 |
| REQ-TIM-112 | lib/time.ts:57 | `formatCountdown` rounds minutes **up**, and never below 1. | validation | P2 |
| REQ-TIM-113 | lib/time.ts:62 | Past two hours it switches to whole hours; past 48 hours to days. | validation | P2 |
| REQ-TIM-114 | lib/time.ts:88 | `formatDuration` is minutes all the way up, never hours. | validation | P2 |
| REQ-TIM-115 | lib/time.ts:55 | Arabic uses Latin digits (`-u-nu-latn`) throughout. | validation | P2 |

### `lib/availability.ts` — the engine

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-AVL-116 | lib/availability.ts:31 | `localToUtc("2026-07-24","09:30")` is the matching UTC instant, three hours earlier. | validation | P0 |
| REQ-AVL-117 | lib/availability.ts:38,43 | `utcToLocalDate` / `utcToLocalTime` are its inverse, at +3h. | validation | P0 |
| REQ-AVL-118 | lib/availability.ts:52-60 | Blocker precedence: `closed`, then `past`, then `full`, then `too-soon`. `full` outranks `too-soon` because a slot with no chair stays unbookable however much notice you give it. | state | P0 |
| REQ-AVL-119 | lib/availability.ts:99 | A closure row with a null `branch_id` applies to every branch. | authz | P0 |
| REQ-AVL-120 | lib/availability.ts:119 | The conflict scan excludes `cancelled` and `no_show` only — a `pending` hold still occupies its chair. | state | P0 |
| REQ-AVL-121 | lib/availability.ts:130-155 | `candidateStarts` offers the grid **plus** the exact moment a booking or closure ends. Without it a 75-minute gap and a 75-minute service never meet. | state | P0 |
| REQ-AVL-122 | lib/availability.ts:168 | A `slot_length_min` of zero is guarded to 1, or the loop spins forever. | validation | P1 |
| REQ-AVL-123 | lib/availability.ts:174 | An edge start is offered only **strictly after** opening, and only if the whole appointment still finishes before closing. | validation | P0 |
| REQ-AVL-124 | lib/availability.ts:202 | `latestStart = close − duration` — the appointment must finish before closing, not merely start before it. | validation | P0 |
| REQ-AVL-125 | lib/availability.ts:190 | No hours row, `closed = true`, or zero active stations → the day returns an **empty array**, not a list of blocked slots. | state | P0 |
| REQ-AVL-126 | lib/availability.ts:229 | `past` is **strictly** before `now` — a slot starting this very second is not past. | validation | P0 |
| REQ-AVL-127 | lib/availability.ts:244 | A grid time always appears, bookable or struck through; an off-grid edge time appears **only** when bookable. | state | P0 |
| REQ-AVL-128 | lib/availability.ts:262 | `guests` is how many chairs must be free at once; ask for the longer duration so the booking claims a strict subset. | state | P0 |
| REQ-AVL-129 | lib/availability.ts:271 | ponytail: knowingly conservative for mismatched durations. | state | P2 |
| REQ-AVL-130 | lib/availability.ts:290 | `leadTimeMin` override: `0` for a walk-in, and it is what makes a chair freed by a no-show usable at all. | authz | P0 |
| REQ-AVL-131 | lib/availability.ts:305 | `getMonthAvailability` loads the context **once** and computes every day from it. | side-effect | P0 |
| REQ-AVL-132 | lib/availability.ts:330 | `reserveStations` returns `null` when there aren't enough free — callers must treat that as a conflict, not an error. | state | P0 |
| REQ-AVL-133 | lib/availability.ts:333 | It MUST be called inside a transaction; the `for update` lock is what makes choose-a-chair and write-the-booking indivisible. | state | P0 |
| REQ-AVL-134 | lib/availability.ts:336 | `bookings_station_slot_unique` only catches an identical `starts_at`; overlapping bookings at *different* start times are caught by the lock alone. | state | P0 |
| REQ-AVL-135 | lib/availability.ts:338 | Rows are locked ordered by `sort`, which is what keeps concurrent reservations deadlock-free. | state | P0 |
| REQ-AVL-136 | lib/availability.ts:341 | `ignoreBookingIds` — a booking being rescheduled must not see itself, nor its group's other half, as the blocker. | state | P0 |
| REQ-AVL-137 | lib/availability.ts:345 | `onlyStationId` narrows to one chair for the station QR flow, with identical lock, conflict rule and atomicity. | state | P0 |
| REQ-AVL-138 | lib/availability.ts:383 | The conflict predicate is strict on both ends and "must match computeDay's predicate character for character". | validation | P0 |
| REQ-AVL-139 | lib/availability.ts:371 | Only **active** stations are reservable. | state | P0 |
| REQ-AVL-140 | lib/availability.ts:420 | `stationFreeWindow` returns minutes, not a boolean, so the QR page offers only services that fit. `0` means not free at all. | state | P1 |
| REQ-AVL-141 | lib/availability.ts:459 | Outside opening hours the window is `0`, or an appointment running past midnight reports the next trading day as free. | validation | P1 |
| REQ-AVL-142 | lib/availability.ts:466 | A booking already running at `from` clamps the window to zero. | validation | P1 |
| REQ-AVL-143 | lib/availability.ts:470 | Closures are deliberately **not** consulted by `stationFreeWindow`. | state | P2 |
| REQ-AVL-144 | lib/availability.ts:493 | `offerableStations` drops any chair whose window is shorter than the shortest service. | state | P1 |
| REQ-AVL-145 | lib/availability.ts:495 | The scanned chair sorts first when it qualifies — an invariant of the returned list, not of the caller's ordering. | state | P1 |

### `lib/bookings.ts` — the write path

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKG-146 | lib/bookings.ts:192 | `isSlotConflict` walks the `cause` chain, because Drizzle's own message is only the failed SQL. | validation | P1 |
| REQ-BKG-147 | lib/bookings.ts:218 | Booking codes use no `I`, `O`, `0` or `1` — they are read aloud over the phone. | validation | P1 |
| REQ-BKG-148 | lib/bookings.ts:222 | A code is `RON-` plus five characters. | validation | P1 |
| REQ-BKG-149 | lib/bookings.ts:325 | `claimedWindows` counts a refill as claimed unless it is `cancelled` or `no_show`. | state | P1 |
| REQ-BKG-150 | lib/bookings.ts:365 | A booking reference opens the **whole party**, not half of it. | authz | P0 |
| REQ-BKG-151 | lib/bookings.ts:355 | `BookingSummary` deliberately omits name, phone, email, station and notes — a privacy boundary, not a view model. | authz | P0 |
| REQ-BKG-152 | lib/bookings.ts:419 | A code lookup caps at 10 rows, a session lookup at 50, newest first. | validation | P1 |
| REQ-BKG-153 | lib/bookings.ts:505 | `allocateTickets` is one statement, so the row lock serialises two transactions asking at the same instant. | side-effect | P0 |
| REQ-BKG-154 | lib/bookings.ts:538 | `sweepExpiredHolds` filters `source = 'web'`, so an admin's pending booking is never swept. | authz | P0 |
| REQ-BKG-155 | lib/bookings.ts:596 | `NO_SHOW_LOOKBACK_DAYS = 7` — contradicts `docs/NO-SHOW-RELEASE.md:45`. See D-1. | state | P0 |
| REQ-BKG-156 | lib/bookings.ts:623 | Zero members → `failed`. | validation | P0 |
| REQ-BKG-157 | lib/bookings.ts:626 | An unparseable `startsAt` → `failed`. | validation | P0 |
| REQ-BKG-158 | lib/bookings.ts:629 | An empty phone → `failed`. | validation | P0 |
| REQ-BKG-159 | lib/bookings.ts:631 | Email is stored lower-cased. | validation | P1 |
| REQ-BKG-160 | lib/bookings.ts:648 | `sweepNoShows` runs **outside** the transaction on purpose — it must not roll back if this booking then fails. | side-effect | P0 |
| REQ-BKG-161 | lib/bookings.ts:659 | The *appointment* must fall inside the refill window, not merely the moment of booking → `refill-window`. | validation | P0 |
| REQ-BKG-162 | lib/bookings.ts:669 | A refill is one guest and the same service, or `invalid-service`. | validation | P0 |
| REQ-BKG-163 | lib/bookings.ts:713,744 | A refused promo or reward is **refused**, never silently ignored. | validation | P0 |
| REQ-BKG-164 | lib/bookings.ts:727 | Order of discounts: group/refill, then promo, then reward. | validation | P0 |
| REQ-BKG-165 | lib/bookings.ts:777 | A signed-in customer books against the row they signed in as; the phone upsert is skipped. | authz | P0 |
| REQ-BKG-166 | lib/bookings.ts:818 | A blocked customer aborts the transaction, so the upsert leaves nothing behind → `blocked`. | authz | P0 |
| REQ-BKG-167 | lib/bookings.ts:821 | A `pending` booking gets no ticket; a `confirmed` one gets it on the spot. | state | P0 |
| REQ-BKG-168 | lib/bookings.ts:838 | VAT is extracted from the discounted total, never added on. | validation | P0 |
| REQ-BKG-169 | lib/bookings.ts:901 | Points are debited at **hold** time, not at confirmation, so two tabs cannot spend one balance. | side-effect | P0 |
| REQ-BKG-170 | lib/bookings.ts:830 | `customerName` is the named guest, else the customer row's name — snapshotted, never joined live. | state | P1 |
| REQ-BKG-171 | lib/bookings.ts:844 | `serviceName` and `servicePriceHalalas` are snapshots — raising a price must not rewrite what was charged. | state | P0 |
| REQ-BKG-172 | lib/bookings.ts:973 | `rescheduleBooking` deliberately enforces **no** permission and **no** cancellation window — that belongs to the caller. | authz | P0 |
| REQ-BKG-173 | lib/bookings.ts:978 | A group moves as a unit; every guest keeps the same start. | state | P0 |
| REQ-BKG-174 | lib/bookings.ts:999 | Each guest keeps their own duration across a move. | state | P0 |
| REQ-BKG-175 | lib/bookings.ts:1026 | A move clears `technicianId` — keeping a now-double-booked name would look like a decision and be a clash. | state | P0 |
| REQ-BKG-176 | lib/bookings.ts:1042 | A move onto today re-staffs immediately; a move to a later day stays empty. | side-effect | P1 |
| REQ-BKG-177 | lib/bookings.ts:983 | An unknown booking id → `not-found`; a NaN start → `failed`. | validation | P0 |
| REQ-BKG-178 | lib/bookings.ts:1091 | `getRefillOffer` returns null for an unknown code, a lapsed or spent window, or a service the salon has deactivated. | state | P1 |
| REQ-BKG-179 | lib/bookings.ts:1114 | The offer uses the original booking's add-on **snapshots**, not today's catalogue. | state | P1 |

### `lib/booking.ts` — client-side selection state

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-BKC-180 | lib/booking.ts:84,89,103 | Every `sessionStorage` helper no-ops when `window` is undefined — they are imported by server-rendered modules. | state | P1 |
| REQ-BKC-181 | lib/booking.ts:96 | A selection saved by an older build with no `members` array reads as nothing selected, rather than crashing the payment page. | validation | P0 |
| REQ-BKC-182 | lib/booking.ts:91 | Malformed JSON in `sessionStorage` reads as null, never throws. | validation | P0 |
| REQ-BKC-183 | lib/booking.ts:111 | `ar-SA` defaults to the Islamic calendar, so month labels pin `-ca-gregory` and `-nu-latn`. | validation | P1 |
| REQ-BKC-184 | lib/booking.ts:131 | `weekdayLabel` maps a JS Sunday-first index onto the dictionary's Saturday-first array. | validation | P0 |
| REQ-BKC-185 | lib/booking.ts:138 | `formatTime` renders 12-hour with the dictionary's am/pm word; `00:xx` and `12:xx` both read as 12. | validation | P1 |
| REQ-BKC-186 | lib/booking.ts:52 | `BookingSelection.total` is display only — the server recomputes every price and never trusts it. | authz | P0 |

### `app/api/bookings/route.ts`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-API-187 | app/api/bookings/route.ts:83 | 10 booking attempts per IP per minute → `429 too-many`. | validation | P0 |
| REQ-API-188 | app/api/bookings/route.ts:29 | `members` is 1-2; `addonIds` at most 20. | validation | P0 |
| REQ-API-189 | app/api/bookings/route.ts:41 | Saudi mobile only, with or without country code. | validation | P0 |
| REQ-API-190 | app/api/bookings/route.ts:47 | Email is **required** on the web, unlike a walk-in. | validation | P0 |
| REQ-API-191 | app/api/bookings/route.ts:64-80 | `stationToken` is a QR token, never a raw station id, resolved only from an **active** station at that branch. | authz | P0 |
| REQ-API-192 | app/api/bookings/route.ts:78 | An unknown or retired token is `404 unknown-station`, never a silent fallback to any free chair. | authz | P0 |
| REQ-API-193 | app/api/bookings/route.ts:70 | The customer id comes from the session cookie and never from the body. | authz | P0 |
| REQ-API-194 | app/api/bookings/route.ts:118 | Status is forced to `pending` — the hold, not the sale. | state | P0 |
| REQ-API-195 | app/api/bookings/route.ts:127 | `slot-taken` and `refill-expired` → 409; `blocked` → 403; everything else → 400. | validation | P0 |
| REQ-API-196 | app/api/bookings/route.ts:158 | Success is `201` with `{ groupId, totalHalalas, pointsSpent, bookings: [{id, code}] }` and nothing else. | validation | P0 |
| REQ-API-197 | app/api/bookings/route.ts:97 | Malformed JSON → `400 invalid-json`; a schema failure → `400 invalid` carrying the failing paths. | validation | P0 |

### `app/api/availability/route.ts`

| REQ | Source | Statement | Type | Pri |
|---|---|---|---|---|
| REQ-API-198 | app/api/availability/route.ts:38 | 60 availability reads per IP per minute → `429 too-many`. | validation | P0 |
| REQ-API-199 | app/api/availability/route.ts:23 | `duration` coerces, defaults to 60, clamped 5-600. | validation | P0 |
| REQ-API-200 | app/api/availability/route.ts:27 | `guests` coerces, defaults to 1, clamped 1-2. | validation | P0 |
| REQ-API-201 | app/api/availability/route.ts:34 | `walkIn` is a literal `"1"`; `walkIn=0` and `walkIn=false` must not switch it on. | validation | P0 |
| REQ-API-202 | app/api/availability/route.ts:57 | The sweep runs on the staff path only — never on a public calendar click. | side-effect | P0 |
| REQ-API-203 | app/api/availability/route.ts:74 | `freeStationIds` is internal and must not reach the browser; `blockedBy` must. | authz | P0 |
| REQ-API-204 | app/api/availability/route.ts:88 | `leadTimeMin` rides along, zero for staff. | validation | P0 |
| REQ-API-205 | app/api/availability/route.ts:104 | Neither `date` nor `month` → `400 date-or-month-required`. | validation | P0 |
| REQ-API-206 | app/api/availability/route.ts:105 | Any thrown error → `500 failed`, with no detail in the body. | validation | P0 |
