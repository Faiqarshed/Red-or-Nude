# Booking v2 — pay first, get a ticket, book for two

What changed, why, and how to test it.

Branch: `booking-group-tickets`. Four commits, each one shippable on its own.

---

## 1. What this delivers

Three things the client asked for:

1. **No booking without payment.** Picking a time now only *holds* the chair. The
   booking is not confirmed, and does not exist as far as the salon is concerned,
   until money has changed hands. Walk away and the hold releases itself.
2. **A ticket number.** Once paid, the booking gets an airline-style number —
   `A1`, `A2`, … `A99`, `B1` — that restarts every day at every branch, plus the
   chair it has been assigned. Both are stored in the database; the customer sees
   them in the confirmation pop-up.
3. **Group booking for two.** Two guests, each choosing their own services, on one
   shared appointment time, on one bill, 10% cheaper. Two tickets, two chairs.

**Not** in this phase: customer accounts, invoice history, email/SMS, a real
payment gateway, and any admin panel screens.

---

## 2. How the flow works now

```
   /booking  or  /booking/group
        │  customer picks services and a time
        ▼
   POST /api/bookings
        │  chairs are LOCKED and claimed
        │  rows written as status = "pending", ticket_no = null
        ▼
   POST /api/payments/confirm
        │  one charge for the whole bill
        │
        ├── declined ──▶ payments row marked "failed"
        │               booking STAYS pending
        │               customer retries — keeps the same slot
        │               (walks away → swept back to cancelled)
        │
        └── paid ─────▶ payments rows marked "paid"
                        ticket numbers allocated
                        bookings → "confirmed"
                        ▼
                   success pop-up: "A45 · Chair 3"
```

The two steps are separate on purpose. If they were one call, a declined card
would mean re-picking the time slot.

### A group is two rows, not a new concept

There is no `booking_groups` table. Two guests booking together produce two
ordinary `bookings` rows that share a `group_id`. Everything downstream — the
admin day grid, the availability engine, cancellation — already understands a
booking row, so it understands a group for free.

We deliberately did **not** add a table, because it would hold nothing the member
rows don't already carry. Add one the day a group gains its own facts (a party
name, a group-level promo).

---

## 3. Where the code lives

| File | Job |
|---|---|
| `lib/bookings.ts` | `createBookings()` — the single write path, 1 or 2 guests. `createBooking()` is a thin wrapper so the admin walk-in form is untouched. |
| `lib/availability.ts` | `reserveStations()` claims N chairs under a lock. `getDayAvailability(..., guests)` answers "can two people sit here?" |
| `lib/money.ts` | `splitGroupPrice()` — the discount maths. Pure, no database. |
| `lib/tickets.ts` | `formatTicketNo()` — `1 → A1`, `100 → B1`. |
| `lib/payments/index.ts` | The `PaymentDriver` interface + `getDriver()`. |
| `lib/payments/fake.ts` | The stand-in gateway. |
| `lib/payments/confirm.ts` | Charge → confirm → issue tickets. The state machine. |
| `app/api/bookings/route.ts` | Creates the hold. Body is `{ branchId, startsAt, members: [...] }`. |
| `app/api/payments/confirm/route.ts` | Takes the money. |
| `components/booking/GuestPicker.tsx` | One guest's services/add-ons/removal/design. Rendered once on `/booking`, twice on `/booking/group`. |
| `components/booking/Summary.tsx` | The bill panel, one guest or two. |
| `app/(site)/booking/group/` | The two-guest page. |
| `scripts/check-booking.ts` | `npm run check` — all the invariants. |

### Database

Three additions, one migration (`drizzle/0001`, `drizzle/0002`):

- `bookings.ticket_no` — `"A45"`. Null until paid.
- `bookings.group_id` — shared uuid, indexed.
- `ticket_counters` — one row per branch per service day.

Nothing was added to `payments`; that table was already fully specified and unused.

---

## 4. The bits worth understanding

### Ticket numbers must not collide

`SELECT max(ticket_no) + 1` is wrong: two people booking at the same instant both
read 44 and both become `A44`. Instead the counter row is incremented and returns
the range in one statement, so the row lock serialises it — and asking for two at
once is what gives a group its consecutive pair.

The counter day is the day of the **appointment**, not of payment. Someone booking
three weeks ahead draws from the queue for the day they'll actually be served,
otherwise the morning roll call is a mixture of numbers issued on four dates.

### The discount maths

Saudi prices already include 15% VAT, so we never *add* VAT — we pull it back out
to report it.

```
gross per guest   = service + removal + add-ons
combined gross    = sum of those
discount          = round(combined gross × 10%)     ← the only rounding anywhere
bill              = combined gross − discount
                    then the discount is shared out by largest remainder
per guest total   = their gross − their share
per guest VAT     = vatIncludedIn(their total)
per guest subtotal= their total − their VAT
```

Rounding exactly once is what guarantees the two guests' totals add back up to
what the card was charged. A single guest at 0% is a no-op, so ordinary bookings
charge exactly what they did before.

**One halala note:** the two guests' VAT figures may sum to one halala different
from VAT computed on the whole bill in one go. That's correct — an invoice is a
list of lines and its tax figure is the sum of the lines' tax, which is how ZATCA
expects a B2C invoice to be built.

### Two guests, different service lengths

Guest 1 might book 90 minutes and guest 2 only 45. They start together; they don't
finish together.

The calendar is asked for two chairs free for the **longer** job, and each guest's
row then gets its own end time. Booking therefore always claims less than what was
checked, so a slot shown as available can never fail on confirm.

This is slightly conservative — it hides an end-of-day slot where one chair is free
long enough and another only briefly. Marked in the code; tighten it only if the
salon reports losing bookings.

### Abandoned checkouts

An unpaid hold blocks a chair. Filtering those out of the calendar alone isn't
enough, because the database's uniqueness rule doesn't know about expiry and would
still reject the replacement booking.

So stale holds are actually **cancelled**, as the first statement of every booking
write. No cron, no background job — the data heals itself the next time anyone
tries to book at that branch. Controlled by the `booking_hold_min` setting
(default 15). Admin-created pending bookings are never swept.

---

## 5. Swapping in a real payment gateway

Moyasar vs Tap is still undecided. When it's picked:

1. Write `lib/payments/moyasar.ts` exporting a `PaymentDriver`:
   ```ts
   export const moyasarDriver: PaymentDriver = {
     name: "moyasar",
     async charge({ ref, amountHalalas, method }) {
       // ref doubles as the idempotency key
       return { status: "paid" | "failed", providerRef, raw };
     },
   };
   ```
2. Branch on `process.env.PAYMENT_DRIVER` in `getDriver()`
   (`lib/payments/index.ts`) — it returns `fakeDriver` unconditionally today.
3. Set `PAYMENT_DRIVER=moyasar` in the environment.

Nothing else changes. The `payments` rows, the pending/confirmed state machine,
the retry behaviour and the ticket issuing are all already real.

A real gateway will also want a **webhook** endpoint (the customer's browser can
die mid-redirect). That's the one piece deliberately not built — it belongs with
the driver that needs it.

> ⚠️ The fake driver approves everything. Deploying with it means customers book
> for free. `PAYMENT_DRIVER` must point at a real provider before the site takes
> public traffic.

---

## 6. Bugs found and fixed along the way

All four were already in the codebase; group booking just made them impossible to
build on.

| Bug | Effect | Fix |
|---|---|---|
| Chair chosen outside the transaction | Overlapping bookings at different start times could land on one chair. **Five people were being seated on four chairs.** | `reserveStations()` takes a `FOR UPDATE` lock and runs inside the insert transaction |
| Conflict check used `>=` on the end boundary | A slot could be offered and then fail on confirm | Strict comparison, matching the calendar exactly |
| Uniqueness rule ignored booking status | A **cancelled** booking held its chair-and-time forever; re-booking a freed slot failed | Partial unique index excluding cancelled/no-show |
| Error matching read `err.message` | Drizzle wraps the driver error, so a lost race was reported as a server fault | `isSlotConflict()` walks the cause chain |

The reschedule action had its own copy-pasted version of the first two; it now
routes through the same shared function.

---

## 7. Testing guide

### Setup

```bash
# Postgres must be running (Windows: services.msc → postgresql-x64-18 → Start)
npm install
npm run db:migrate
npm run db:seed          # 2 branches × 4 chairs, 09:00–23:00
npm run dev              # http://localhost:3000
```

### The automated check

```bash
npm run check
```

Asserts, against a real database: the four-chairs-four-people rule, adjacent
bookings, re-booking a cancelled slot, the discount split with no drift, ticket
formatting, a real group booking, and that an unpaid hold gets no ticket number.

Expected:

```
  5 concurrent overlapping attempts → 4 seated, 1 refused
  no chair holds two overlapping bookings ✓
  booking at exactly +90 min → seated ✓
  re-booking a cancelled slot → seated ✓
  pricing: discount splits with no drift ✓
  tickets: A1 … A99 → B1 ✓
  group: A26 + A27, 370 SAR → 333 SAR (10% off) ✓
  group: subtotal + VAT == total on both rows ✓
  pending hold carries no ticket ✓
```

### Scenario 1 — book for one

1. Go to `/booking`.
2. Pick a branch, a service, optionally add-ons and a removal type.
3. Click the **Appointment** box → pick a day and time → confirm.
4. Tick the terms box → **Continue to Payment**.
5. Enter a name and a Saudi mobile (`0512345678` — must be 10 digits starting `05`).
6. Choose a payment method → **Confirm Payment**.

**You should see:** a pop-up with a large ticket number (`A1`), the chair number
under it, the booking reference (`RON-XXXXX`), and the total.

**Confirm the database agrees:**

```sql
select code, ticket_no, status, station_id, total_halalas
from bookings order by created_at desc limit 1;
```
`ticket_no` filled, `status = 'confirmed'`.

### Scenario 2 — book for two

1. Go to `/booking/group` (or the "Group Booking" card on the homepage).
2. **Guest 1** picks one service, **Guest 2** picks a *different* one.
3. Notice there is only **one** appointment picker — both guests share it. That's
   the requirement: same day, same time slot.
4. The summary shows subtotal → −10% → total.
5. Pay.

**You should see:** two ticket blocks with **consecutive** numbers (`A2`, `A3`) on
**different** chairs.

```sql
select code, ticket_no, station_id, discount_halalas, total_halalas
from bookings where group_id is not null order by created_at desc limit 2;
```
Both rows share one `group_id`, the two `total_halalas` add up to what was charged,
and each row's `subtotal + vat = total`.

### Scenario 3 — declined card

The fake gateway approves everything, so drive the decline through the API:

```bash
curl -X POST localhost:3000/api/payments/confirm \
  -H 'Content-Type: application/json' \
  -d '{"code":"RON-XXXXX","method":"card","simulate":"decline"}'
```

**Expect** `402 {"error":"payment-declined"}`, the booking still `pending`, a
`payments` row marked `failed`, and the same call without `simulate` succeeding.
(`simulate` is ignored in production.)

### Scenario 4 — abandoned checkout

```sql
update settings set value = '0'::jsonb where key = 'booking_hold_min';
```

Now create five holds on the same slot at a four-chair branch. All five succeed:
each new attempt sweeps the stale ones first.

```sql
select status, cancel_reason, count(*) from bookings
where starts_at = '...' group by 1,2;
--  pending   |                 | 1
--  cancelled | payment-timeout | 4

update settings set value = '15'::jsonb where key = 'booking_hold_min';
```

### Scenario 5 — the last chair

Fill three of four chairs at one time slot, then compare:

```bash
curl "localhost:3000/api/availability?branchId=<id>&date=<date>&duration=90&guests=1"
curl "localhost:3000/api/availability?branchId=<id>&date=<date>&duration=90&guests=2"
```

That slot must be `available: true` for one guest and `false` for two.

### Scenario 6 — nothing broke in the admin

Create a walk-in from `/admin/bookings`. It must confirm **instantly** (walk-ins
aren't payment-gated — the customer is standing there) and receive a ticket from
the same daily queue as web bookings.

---

## 8. Known limits

Deliberate, and each has an obvious upgrade path:

- **The fake gateway approves everything.** No money moves. Blocks going live.
- **No webhook.** If the browser dies between charge and confirm, the money is
  taken but the booking stays pending. It's logged loudly as "refund owed".
  Arrives with the real driver.
- **The success pop-up vanishes on refresh.** The ticket is safe in the database,
  but there is no page to revisit it. A `/booking/ticket/<code>` page would be
  small to add and needs nothing built here to change.
- **Holds are swept on write, not on a timer.** A branch nobody is booking keeps
  stale holds visible until the next attempt.
- **The group calendar is slightly conservative** with mismatched durations (§4).
- **Groups are capped at two.** The engine handles N; the API and UI cap it at 2
  because that's the requirement.
- **The admin shows no ticket numbers.** Out of scope this phase — they're in the
  database and visible via `npm run db:studio`.
