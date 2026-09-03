# Surface map — `booking`

Phase 2 of `nextjs-drizzle-hardening`. Enumerated from the code first
(`AGENT-BRIEF.md` §"The source is spec too"), then reconciled against `docs/`.

---

## 1. Route handlers

| Method + path | File | Auth | Mutates | Notes |
|---|---|---|---|---|
| `POST /api/bookings` | `app/api/bookings/route.ts` | **none** — public, guest checkout is the ordinary case. `currentCustomer()` is read but null is fine. | `bookings`, `booking_addons`, `customers` (upsert), `loyalty_txns`, `ticket_counters` (not on this path — status is forced `pending`) | `force-dynamic`. Throttled 10/min/IP. |
| `GET /api/availability` | `app/api/availability/route.ts` | **none** for the read; `currentStaff()` gates `walkIn=1` only | `bookings` — via `sweepNoShows`, staff path only. A GET that writes. | `force-dynamic`. Throttled 60/min/IP. |

Both are unauthenticated by design: `/booking` and `/booking/group` are public
pages. Neither reads a route param, so there is no IDOR surface on an id in the
path; the ownership questions live in `stationToken` and in the session cookie.

## 2. Pages in this area

| Path | File | Client/server |
|---|---|---|
| `/booking` | `app/(site)/booking/page.tsx` + `BookingView.tsx` | server shell, client view |
| `/booking/group` | `app/(site)/booking/group/page.tsx` + `GroupBookingView.tsx` | server shell, client view |
| `/booking/payment` | `app/(site)/booking/payment/page.tsx` | client — posts the selection |

`lib/booking.ts` is the client state carried between them, in `sessionStorage`
under `ron-booking`. Nothing in it is trusted server-side.

## 3. Exported functions — the real surface list

Every export in the five library files, with what it touches. This, not `docs/`,
is what the Phase 5 checklist was applied to.

### `lib/slots.ts` — pure, client-safe
| Export | Signature | I/O |
|---|---|---|
| `overlaps` | `(aStart, aEnd, bStart, bEnd) => boolean` | none |
| `busyDuring` | `(rows, span) => Set<string>` | none |
| `occupies` | *not exported* — reachable only through `busyDuring` | none |

### `lib/time.ts` — pure
`riyadhDayRange`, `riyadhDateKey`, `closureDays`, `localTime`, `formatCountdown`,
`formatDuration`, `riyadhWeekday`, `formatDateTime`, plus the `TIMEZONE` and
`UTC_OFFSET_HOURS` constants. No database, no `server-only`.

### `lib/availability.ts` — `server-only`
| Export | Reads | Writes |
|---|---|---|
| `localToUtc`, `utcToLocalDate`, `utcToLocalTime` | — | — |
| `getDayAvailability` | `settings`, `stations`, `branch_hours`, `closures`, `bookings` (5 selects, one `loadContext`) | — |
| `getMonthAvailability` | the same five, **once for the whole month** | — |
| `reserveStations` | `stations … for update`, `bookings` | takes row locks |
| `stationFreeWindow` | `branch_hours`, `bookings` (2 selects, parallel) | — |
| `offerableStations` | — (pure) | — |

### `lib/bookings.ts` — `server-only`
| Export | Reads | Writes |
|---|---|---|
| `isSlotConflict` | — | — |
| `claimedWindows` | `bookings` | — |
| `bookingSummaries` | `bookings` ⋈ `services`/`branches`/`staff`, `booking_addons` ⋈ `addons`, `settings` | — |
| `allocateTickets` | — | `ticket_counters` (upsert, one statement) |
| `sweepNoShows` | `settings` | `bookings` (raw `update`) |
| `createBookings` | `settings`, `services`, `addons`, `removal_types`, `designs`, `bookings` (refill parent), `promo_codes`, `loyalty_txns` | `bookings`, `booking_addons`, `customers`, `loyalty_txns`, `ticket_counters`; plus `sweepNoShows` and `sweepExpiredHolds` |
| `createBooking` | wrapper over the above, one member | as above |
| `rescheduleBooking` | `bookings` | `bookings` (start, end, station, technician), then `assignIfToday` |
| `getRefillOffer` | `bookings`, `services`, `booking_addons`, `removal_types`, `settings` | — |

Private but reachable through the above and therefore in scope: `makeCode`,
`priceMember`, `loadRefillParent`, `sweepExpiredHolds`, `isRefillConflict`,
`BookingAbort`.

### `lib/booking.ts` — client
`emptySelection`, `saveBooking`, `loadBooking`, `clearBooking`, `monthLabel`,
`formatDateLabel`, `weekdayLabel`, `formatTime`, and the `BookingSummary` type
that is the customer-facing privacy boundary.

## 4. Tables and constraints this area depends on

| Table | Constraint | Why it matters here |
|---|---|---|
| `bookings` | `bookings_code_unique` | the reference read aloud on the phone |
| `bookings` | `bookings_station_slot_unique` — partial unique on `(station_id, starts_at)` where status not in (`cancelled`,`no_show`) | backstop only. **Does not catch overlapping bookings at different start times** (`lib/availability.ts:336`, `scripts/check-booking.ts:170`) |
| `bookings` | `bookings_refill_of_unique` — partial unique on `refill_of_booking_id` | one refill per booking, decided by the database |
| `bookings` | FK `branch_id` `on delete restrict` | a branch with bookings cannot be deleted |
| `bookings` | FK `station_id`/`technician_id`/`customer_id` `on delete set null` | a retired chair does not delete history |
| `branch_hours` | `branch_hours_day_unique` on `(branch_id, weekday)` | one row per weekday |
| `stations` | `stations_qr_token_unique` | the public sticker token |
| `ticket_counters` | PK `(branch_id, day)` | the upsert that serialises ticket allocation |
| `closures` | **no constraint on `branch_id`** — null means every branch | the "all branches" case |

## 5. Environment and external dependencies

| Name | Used by | Test approach |
|---|---|---|
| `DATABASE_URL` / `TEST_DATABASE_URL` | everything | real local `_test` Postgres, via `tests/setup.ts` |
| `AUTH_SECRET` | `lib/account/session.ts`, reachable from `POST /api/bookings` via `currentCustomer()` | not exercised — the guard is mocked at the module boundary |
| `settings` table | `slot_length_min`, `booking_lead_time_min`, `booking_hold_min`, `no_show_grace_min`, `vat_percent`, `group_discount_percent`, `refill_discount_percent` | **process-cached for 60s** (`lib/settings.ts:88`), which is itself a test hazard — see §8 |
| Gemini / Moyasar / SMTP / Supabase | not reached from this area | N/A |

---

## 6. Reconciliation — spec without code

| # | `docs/` promises | Reality |
|---|---|---|
| S1 | `NO-SHOW-RELEASE.md:45` — the sweep is bounded to `starts_at >= dayStart`, "today only". | The code uses a 7-day lookback. **Contradiction, not a gap — see D-1.** |
| S2 | `ADMIN-PANEL.md:258` — "Booking creation runs in a transaction with a uniqueness constraint on `(station_id, starts_at)` — two customers hitting confirm at the same second must not both get the chair." | True but it understates and, read alone, misleads: the constraint catches only the identical-second case. The guarantee the salon actually needs comes from the `for update` lock. `lib/availability.ts:333-337` says so; `docs/` does not. |
| S3 | `BOOKING-V2.md:246` — the expected `npm run check` output still shows `booking at exactly +90 min`. | The check script prints the seeded service's duration, which is not necessarily 90. Cosmetic. |

No promised behaviour is missing from the code.

## 7. Reconciliation — code without spec

The largest list, as expected. Each row has a `// @characterization` test.

| # | Surface | Undocumented behaviour |
|---|---|---|
| C1 | `SlotBlocker` | Four reasons and a precedence order that exists only in a comment. `docs/` describes slots as available or not. |
| C2 | `candidateStarts` edge slots | The engine offers off-grid start times at the exact moment a chair frees. Nothing in `docs/` mentions non-grid slots; `ADMIN-PANEL.md:250` says "slots of `settings.slot_length`", full stop. |
| C3 | `computeDay` empty-day rule | A closed day, a missing hours row and a branch with no active chairs all return `[]` rather than a struck-through grid. |
| C4 | `latestStart = close − duration` | "Must finish before closing" is a comment only. |
| C5 | `stationFreeWindow` | Whole function. Minutes-not-boolean, the outside-hours zero, the deliberate omission of closures. |
| C6 | `offerableStations` | Whole function, including "the scanned chair sorts first" as a list invariant. |
| C7 | `stationToken` on `POST /api/bookings` | Whole feature. The `404 unknown-station` refusal and the never-fall-back rule. |
| C8 | Throttle budgets | 10/min bookings, 60/min availability. |
| C9 | `guests` / `members` caps | Enforced by Zod at 2; `BOOKING-V2.md:354` says "capped at two" without saying what the refusal looks like. |
| C10 | `rescheduleBooking` | Enforces no permission and no cancellation window **on purpose**; clears `technicianId`; moves a group as a unit. Only comments say so. |
| C11 | `bookingSummaries` party rule | One reference opens every row in the group. A privacy decision documented only at `lib/bookings.ts:365`. |
| C12 | Refill `refill-window` vs `refill-expired` | Two different errors with two different HTTP statuses. |
| C13 | Points debited at hold time | `lib/bookings.ts:901`. Nothing in `docs/` says an abandoned checkout holds points. |
| C14 | `sweepExpiredHolds` `source = 'web'` filter | `BOOKING-V2.md:161` says admin holds are never swept; the mechanism (the `source` column) is comment-only. |
| C15 | Booking code alphabet | No `I`/`O`/`0`/`1`. |
| C16 | Email lower-casing | `lib/bookings.ts:631`. |
| C17 | `loadBooking` version tolerance | An old `sessionStorage` payload with no `members` reads as nothing selected. |
| C18 | **Nothing in the write path consults `branch_hours` or `closures`.** | `createBookings` checks chairs and conflicts only. `NO-SHOW-RELEASE.md:105` documents this for *lead time*, and no further. See D-2. |
| C19 | Staff time off does not constrain availability | Capacity is chairs, not technicians. Consistent with the glossary, unstated in `docs/`. |

## 8. Reconciliation — spec contradicts code

Reported, not resolved. See `known-bugs-booking.md`.

- **D-1** `NO-SHOW-RELEASE.md:45` vs `lib/bookings.ts:596`: "today only" vs a
  7-day lookback. The code carries a long comment explaining why the day bound
  was wrong; the doc was never updated. Which is authoritative?
- **D-2** `ADMIN-PANEL.md:246` describes availability as `branch_hours − closures
  × stations − bookings`, and `ADMIN-PANEL.md:253` says the engine exists "so the
  two can never disagree". The **write** path implements only the last two terms.
  A direct POST books a closed day.
- **D-3** `BOOKING-V2.md:122` calls the group discount "the only rounding
  anywhere". Promo and reward shares are rounded too (`shareAmount`), after the
  doc was written.

## 9. Test hazards found while mapping

- `lib/settings.ts` caches the whole `settings` table for 60 seconds in module
  scope. A test that writes a setting and immediately calls the engine reads the
  stale value. `tests/booking/helpers.ts` exports `withSetting()`, which writes
  the row and then busts the cache by waiting out nothing — it cannot, so the
  tests instead pass explicit `now`/`leadTimeMin` arguments wherever the engine
  offers them, and only use `withSetting` where there is no argument.
- `lib/throttle.ts` counts in module scope and is never reset. Route-handler
  tests must vary the `x-forwarded-for` header per test or the eleventh case in a
  file gets a 429 it did not ask for.
- `db.transaction` on postgres-js gives each transaction its own connection from
  a pool of 10. The concurrency tests use at most 6.
