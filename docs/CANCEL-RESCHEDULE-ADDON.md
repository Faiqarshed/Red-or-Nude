# Cancellation, reschedule, and the station QR add-on

Brief §2.6 and §2.7. This is the test guide: what to click, what to type, and
what should come back. Written to be runnable by someone who did not build it.

Everything below assumes `npm run dev`, a seeded database (`npm run db:seed`),
and the migration applied.

---

## 0. Setup, once

```bash
npm run db:generate   # only if the schema changed since
npm run db:migrate    # applies 0005 — adds stations.qr_token
npm run check:cancel  # the pure window rule, no database needed
```

`0005` adds `qr_token uuid not null default gen_random_uuid()` plus a unique
constraint. Postgres evaluates a **volatile** default per row on `ADD COLUMN`,
so existing chairs each get their own token — there is no backfill step.
Confirm:

```sql
select label, qr_token from stations order by sort;
-- every row a different uuid, no nulls
```

Two settings drive these flows, both editable in `/admin/settings`:

| Key | Default | What it does |
|---|---|---|
| `cancel_cutoff_hours` | `3` | How close to the appointment a customer may still cancel or move it |
| `booking_lead_time_min` | `60` | How far ahead a *new* slot must be — also enforced on reschedule |

---

## Part A — §2.6 Cancel and reschedule

### A1. Happy path: cancel with a refund

1. Book anything at least **4 hours out**: `/booking` → pick a service, branch
   and a slot → **Proceed** → fill name/phone/email → pay (the fake driver
   approves everything).
2. Note the ticket number, the station, and the reference (`RON-XXXXX`) on the
   success modal.
3. Go to `/my-bookings`, paste the reference, **View**.
   - **Expect:** the booking, status *Confirmed*, and two buttons —
     **Change time** and **Cancel booking** — plus a line reading
     *"You can cancel or change until …"*.
4. Press **Cancel booking**, then confirm the browser prompt.
   - **Expect:** a green line, *"Booking cancelled — the amount is on its way
     back to your card."* The card re-renders with status *Cancelled* and the
     buttons gone.
5. Check the money:
   ```sql
   select p.status, p.amount_halalas, r.amount_halalas, r.reason, r.actor_id
     from payments p join refunds r on r.payment_id = p.id
    where p.booking_id = '<the booking id>';
   -- payments.status = 'refunded'
   -- refunds row exists, same amount, reason 'customer-cancelled', actor_id NULL
   ```
6. Check the chair is genuinely free again: request the same day from
   `/api/availability?branchId=<id>&date=YYYY-MM-DD&duration=60` and confirm the
   slot you just released is back with `available: true`. There is no cache to
   clear — `cancelled` is excluded from the conflict scan, so releasing is
   immediate.
7. Check the audit trail:
   `select * from audit_log where action = 'cancel' order by created_at desc limit 1;`
   — `actor_name` is `customer`, `actor_id` is null, and `diff` carries the
   refunded amount.

### A2. Happy path: reschedule

1. Book again, at least 4 hours out. Note the reference and which station you
   were given.
2. `/my-bookings` → **Change time** → the standard schedule picker opens,
   already on your appointment's month.
3. Pick a different free slot → **Confirm Appointment**.
   - **Expect:** *"Your appointment has been moved."* and the card re-renders on
     the new date.
4. Confirm both directions in `/api/availability`: the **old** slot is bookable
   again and the **new** one is not.
5. The reference, the ticket number and the price are unchanged — nothing was
   charged or refunded. Verify no new `payments` row appeared.
   The **station may differ**: the engine picks the lowest free chair for the new
   time rather than holding your old one.

### A3. The window closes — the important one

You need a booking under the cutoff. The clean way is to move an existing one
with SQL rather than waiting three hours:

```sql
update bookings
   set starts_at = now() + interval '2 hours',
       ends_at   = now() + interval '3 hours'
 where code = 'RON-XXXXX';
```

1. Reload `/my-bookings` and look it up again.
   - **Expect:** the card renders, status still *Confirmed*, and **both buttons
     are gone** — absent, not greyed out. The "cancel or change until" line goes
     with them.
2. Call the API directly, which is the case that actually matters — the UI can
   be bypassed:
   ```bash
   curl -i -X POST localhost:3000/api/my-bookings/cancel \
     -H 'Content-Type: application/json' -d '{"code":"RON-XXXXX"}'
   ```
   - **Expect:** `409` with
     `{"error":"window-closed","cancelBy":"…","cutoffHours":3}`.
   - The booking is untouched — re-check its status is still `confirmed`.
3. Same for `/api/my-bookings/reschedule` with any `startsAt`: `409
   window-closed`. The window is checked against the appointment you *have*, not
   the one you want.

### A4. Failure branches

| What to do | Expect |
|---|---|
| Cancel with a made-up reference (`RON-ZZZZZ`) | `404 not-found` — the same shape of "no" an unknown reference gets from the lookup, so the code space tells an attacker nothing |
| Cancel the same booking twice quickly | Second call `409 already-cancelled`, and **only one** `refunds` row. The update is guarded on status as well as id |
| Reschedule onto a slot someone just took | `409 slot-taken` → the UI shows *"That time has just gone — please pick another."* The original booking is unchanged |
| Reschedule to 10 minutes from now (hand-crafted request) | `409 too-soon` — the lead time applies to a move, not just a new booking |
| Six cancel attempts in one minute from one IP | `429 too-many`. Cancel and reschedule get 5/min; the read endpoint keeps 10/min. Counted per serverless instance — see the note in `lib/throttle.ts` |
| Cancel an unpaid `pending` hold | `200`, `refunded: false` (there was never a payment). Status becomes `cancelled` immediately rather than waiting out `booking_hold_min` |

### A5. Refund failure

The fake driver never declines, so to see this path force it: temporarily make
`refund()` in `lib/payments/fake.ts` return `status: "failed"`.

- **Expect:** the cancellation still succeeds — `200` with `refunded: false`, and
  the screen reads *"Booking cancelled. We'll be in touch about your refund."*
- The chair is released, no `refunds` row is written, `payments.status` stays
  `paid`, and the server log carries
  `[payments] refund declined for … settle by hand`.
- **This is deliberate.** A gateway outage must not be able to keep a customer's
  appointment alive; owing a refund a human can settle is the smaller failure.

### A6. Groups cancel as a unit

1. Book two guests through `/booking/group` and pay.
2. Cancel using **either** guest's reference.
   - **Expect:** `{"cancelled": 2}`, both rows `cancelled`, and a `refunds` row
     per member — the whole bill comes back.
   - **Why:** it is one combined bill at a 10% pair discount (§2.4). Releasing
     half would leave the remaining guest holding a pair price for a solo
     appointment.
3. Reschedule using either reference moves **both** guests together, to the same
   new time, since a shared start is what makes it a group booking at all.

### A7. Admin is unaffected

`/admin/bookings` → open a booking → the staff status controls still work. The
staff reschedule action now calls the same shared `rescheduleBooking()` in
`lib/bookings.ts`, but **without** the 3-hour window — the salon can move an
appointment ten minutes before it starts. Confirm by moving one the customer
could no longer touch.

---

## Part B — §2.7 In-service add-on via station QR

### B1. Print the stickers

1. `/admin/availability` → the **Chairs** card → **Chair QR codes** at the
   bottom.
2. **Expect:** one QR per chair, labelled, laid out three to a row and ready to
   print. Retired chairs appear greyed but are still printed — their token
   survives being switched off.
3. Each code encodes `<SITE_URL>/station/<qr_token>`. Set `SITE_URL` in
   `.env.local` before printing for real, or the stickers will point at
   `localhost` forever.

### B2. Happy path: add a service mid-appointment

Set up a customer who is in the chair right now:

```sql
update bookings
   set starts_at = now() - interval '20 minutes',
       ends_at   = now() + interval '25 minutes',
       status    = 'in_progress'
 where code = 'RON-XXXXX';

-- then take its station_id and read that chair's token:
select label, qr_token from stations where id = '<station_id>';
```

1. Open `/station/<qr_token>` — scan it with a phone, or paste the URL.
2. **Expect**, in order:
   - the chair's label and branch at the top;
   - *"You're at this table now"*, the customer's name, and the service running;
   - *"Your current service finishes at 3:40"* — this is the **projected finish
     time** from the brief, taken from `ends_at`;
   - *"This table is then free for N minutes"*;
   - a service list containing **only** services whose duration fits inside N.
3. Pick a service → **Continue to payment**.
   - **Expect:** the ordinary payment page, with the appointment time already set
     to your finish time. There is no date picker anywhere in this flow, by
     design — the chair and the time are settled by where you are sitting.
4. Pay.
   - **Expect:** the success modal with a **new ticket number** and the **same
     station label** you scanned.
5. Verify in the database: a second `bookings` row, `station_id` equal to the
   chair you scanned, `starts_at` equal to the first booking's `ends_at`.
6. *"Confirms with the technician"* is the ticket on screen — there is no extra
   confirmation state to press.

### B3. The chair is not free — the other branch

Block the chair immediately after the current appointment. The easiest way is to
run B2 once, which creates exactly that, then reload `/station/<qr_token>`.

- **Expect:** *"This table is booked right after you"*, a short explanation, and
  a **Book on the site** button linking to `/booking` — where the availability
  engine will find a different free station. This is the brief's fallback
  verbatim.
- The same screen appears when the gap is real but too short for anything on the
  menu. From the customer's point of view those are the same answer.

### B4. Failure branches

| What to do | Expect |
|---|---|
| `/station/not-a-uuid` | `404`. Malformed tokens are rejected before the query, so a bad sticker is a 404 rather than a 500 |
| `/station/<random uuid>` | `404` |
| Switch a chair off in `/admin/availability`, then open its token | `404`. A retired chair's sticker stops working the moment it is retired |
| Open a token for an **empty** chair | Works, as a walk-up: the free window is measured from now instead of from a finish time |
| POST `/api/bookings` with a `stationToken` from a **different** branch | `404 unknown-station`. The token must match the branch in the same request |
| POST `/api/bookings` with a raw `stationId` instead | Ignored — the field does not exist in the request schema. Only a token can pin a chair, so nobody can deny a chair to others by pinning it |
| Two people scan the same chair and pay at once | One wins. The loser gets `409 slot-taken` — `reserveStations` takes a row lock on the chair, so the second cannot slip through |

---

## Regression checklist

Both `reserveStations` and `createBookings` changed signature, so re-run the
ordinary flows before shipping:

- [ ] `npm run check:cancel` passes
- [ ] `npm run build` is clean
- [ ] A normal solo booking completes end to end and gets a ticket
- [ ] A group booking completes and gets two tickets on two chairs
- [ ] A refill still books from `/my-bookings` (the refill button is unchanged)
- [ ] `/admin/bookings` walk-in creation still works
- [ ] The admin's staff-side reschedule still works

---

## What is deliberately not here

- **No OTP on cancel or reschedule.** The reference arrives in the customer's own
  inbox and a refund always returns to the card that paid, so a leaked reference
  buys a nuisance cancellation, not money. The guards are the throttle and the
  audit row. `lib/otp.ts` is already built if that judgement changes — wrapping
  these routes is a few lines, exactly as `/api/my-bookings/refill` does it.
- **No real gateway.** `lib/payments/fake.ts` approves every charge and every
  refund. `PAYMENT_DRIVER` must point at Moyasar or Tap before this takes public
  traffic — see `docs/DEPLOYMENT.md` §0. `refund()` is now part of the
  `PaymentDriver` contract, so a real driver has to implement it.
- **No cancellation email in a customer's inbox.** `notify()` is still the
  log-only driver, so `booking-cancelled` and `booking-rescheduled` print to the
  server console. Same standing gap as `booking-confirmed`.
- **No partial group cancellation.** See A6 for why.
