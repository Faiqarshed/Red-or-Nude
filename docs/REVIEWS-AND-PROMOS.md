# Ratings, reviews, and discount codes

Brief §2.9 (ratings and reviews) and §2.10 (discount codes), built together
because they meet in the same two places — the checkout and the booking row.

Part 1 explains what was built and why. Part 2 is the test guide: numbered,
runnable, in order.

---

# Part 1 — Walkthrough

## §2.9 — What "End" now does

The brief says the rating email is triggered when the receptionist presses
**End** on a ticket. There was no new plumbing to build for that: "End" already
existed as `setBookingStatus(id, "completed")` in
`app/(admin)/admin/(shell)/bookings/actions.ts`, so the invitation hangs off that
one call and nothing else in the admin had to change.

The transition is guarded, not the destination:

```ts
if (status === "completed" && before.status !== "completed") {
  await inviteReview(id);
}
```

It is awaited rather than fired and forgotten. On a serverless host the function
is frozen the moment the action returns, so a detached promise would simply never
run — the same reason the invoice is awaited in `lib/payments/confirm.ts`.
`inviteReview` never throws: the appointment is closed and the money is long
since taken, so a mail outage must not turn a receptionist's click into an error.

## The unique index is the mechanism

`inviteReview` inserts the review row **before** it does anything else:

```ts
.insert(reviews).values({ bookingId }).onConflictDoNothing({ target: reviews.bookingId })
```

`reviews_booking_unique` means the second call inserts nothing, gets no row back,
and returns without sending. That is the whole of the "don't email twice" logic —
the database settles it, not a read that two concurrent End presses could both
pass. It is the same reasoning as `bookings_refill_of_unique`.

It also means the row exists from the moment the customer is *asked*, not from
when she replies. That is what makes a response rate computable at all: `invited`
is a row count and `answered` is `count(submitted_at)`.

## The token, and why it isn't the booking code

The emailed link carries `reviews.token`, its own random uuid. The booking code
would have been free, but it travels in forwarded email and is printed on the
ticket, and this link opens a **write**. Same reasoning as `stations.qr_token`.

Auth is that token and nothing else — no OTP round trip. It is the right weight
for what it opens: two scores and a comment on one finished appointment, no money
and no personal data beyond the service she already knows she had. The guards are
the throttle on `POST /api/reviews` and the single-use rule.

The five stars in the email are five separate links (`/review/<token>?r=4`), each
landing with that score pre-selected. An email that asks the customer to click
through, load a page, and *then* start deciding gets answered by almost nobody.
The stars are text, not images — most clients block remote images by default, and
a rating email whose rating is invisible is a rating email nobody answers.

## The technician gap, stated plainly

**Nothing in this application assigns a technician to a booking.**
`bookings.technician_id` exists and has always been null.

The email asks the technician question anyway, because the customer knows who
served her even when the system does not. The score lands in
`reviews.tech_rating`.

Who it refers to is resolved by a **join through the booking**, not stored on the
review:

```sql
left join staff on staff.id = bookings.technician_id
```

So the day an assignment UI lands, attribution appears by itself — on ratings
left before that too, for any booking that gets a technician set, retroactively
or otherwise. No column, no migration, no backfill. Until then the admin column
reads `—` and the average-technician tile says why in its own subtitle rather
than looking broken.

A snapshot on the review row would have frozen whatever was true the moment the
customer happened to click, which is the one thing you cannot correct later.

## §2.10 — Where a discount code enters the price

The `promo_codes` table, `bookings.promo_code_id` and `bookings.discount_halalas`
were already in the schema and entirely unused. This was wiring, not modelling.
The only schema change on that side was giving `promo_code_id` the foreign key it
never had.

`lib/promo.ts` splits the way `lib/cancellation.ts` does — a pure rule and a thin
lookup:

- `promoRefusal(rule, total, now)` → `unknown | inactive | not-started | expired | used-up | min-total`, or `null`
- `promoDiscount(rule, total)` → what it takes off
- `quotePromo(code, total)` → the database lookup around both

The refusals are named because the checkout says them out loud. "That code
applies from 200 SAR" sends the customer somewhere useful; "invalid code" sends
her looking for a typo that isn't there. The one exception is `inactive`, which
the checkout deliberately reports as "not valid" — a stranger should not be able
to learn which of their guesses are real codes the salon hasn't launched yet.

`promoDiscount` is capped at the total. A 500 SAR fixed code on a 200 SAR bill
takes 200. A discount larger than the bill is a refund, and a promo code must
never hand out money that was never taken.

## It stacks, and the maths still adds up

The promo comes off **last**, on top of whatever the group or refill discount
already took. These are occasion offers, not alternatives to the other two, and a
customer who qualifies for both gets both.

In `createBookings`:

1. Price each guest and run `splitGroupPrice` exactly as before.
2. Quote the code against the **combined** group-discounted bill.
3. Share the result back across the guests.
4. Per guest: subtract the share, add it to `discount_halalas`, recompute VAT.

Step 3 is why `lib/money.ts` gained `shareAmount(weights, amount)`. The
largest-remainder split that guarantees the guests' totals add back up to the
bill to the halala already existed inside `splitGroupPrice`; the promo needs
exactly the same thing over a different amount. It was extracted rather than
written twice, and `splitGroupPrice` now calls it. Behaviour is unchanged.

A refused code **aborts the booking** with `promo-invalid` rather than being
ignored. Silently charging full price to someone who typed a code is the one
outcome nobody would accept.

## One discount column, and what that costs

`discount_halalas` holds the guest's *total* reduction — group share plus promo
share, added together — and `promo_code_id` records which code produced part of
it. The invoice reports it as one line, named after the code when there was one:
"Discount (EID25)" instead of "Group booking discount".

The trade is marked in the schema with a `ponytail:` comment: **"how much did
promos cost us" cannot be answered from this column**, only "a code was used
here". Split it into two columns when someone actually wants that report.

## When a use is counted

At payment confirmation, in `lib/payments/confirm.ts`, once per bill — a group is
one redemption, not two. Never at hold time: an abandoned checkout must not burn
a use of a limited code, and counting at hold would need a release-on-sweep path
to undo it.

The cost is marked in `lib/promo.ts`: two people racing the **last** use of a
capped code can both redeem it. Nobody is mispriced by that, and occasion codes
are uncapped or generous. If a code ever needs a hard cap, move the count to hold
time as a conditional `update … where uses < max_uses` and release it when the
hold is swept.

## Two admin screens, no new capabilities

- **/admin/reviews** — read-only. Three tiles (average service, average
  technician, response rate) aggregated in the database over every review rather
  than the 200 listed, because an average of the most recent page is not the
  average and a response rate computed from it is always 100%. Gated on
  `bookings.view`: owner, manager and receptionist hold it, technicians do not,
  which is exactly the right audience.
- **/admin/promo-codes** — create, edit, activate, deactivate. Gated on
  `marketing.manage`, which owner and manager already hold. It is the first piece
  of the Marketing module to actually land; the rest of that nav item is still
  marked `soon`.

Neither needed a line in `lib/auth/rbac.ts`.

Codes are switched off, never deleted: bookings point at them, the invoice names
them, and `uses` is the record of a campaign that happened. Editing a live code
changes what *future* bookings get and nothing else — the discount already given
is frozen in `bookings.discount_halalas`, so lowering a percentage never rewrites
what a customer was charged last week.

## What was deliberately not built

- **A promo/group split in reporting.** One discount column, as above.
- **A hard cap on uses.** See the race note above.
- **Public testimonials.** Reviews are admin-only. A public wall needs an
  approval flow, a moderation queue and a homepage section — three things nobody
  asked for.
- **Review moderation or replies.** There is nothing to moderate while nothing is
  published.
- **A technician assignment UI.** Out of scope for §2.9, and the join above means
  it needs no change here when it arrives.
- **Reminder emails for unanswered reviews.** One ask, one email.
- **Gift-card-style redemption at checkout.** Gift cards are a separate balance
  ledger (§2.5); a promo code is a percentage off one bill.

---

# Part 2 — Test guide

Everything below is real. There are no mocks.

## 0. Automated first

Both are pure — no database, no network — and they run in about a second.

```bash
npm run check:promo      # discount maths, refusal boundaries, the halala split
npm run check:reviews    # score range, email rendering, HTML escaping
```

Expect `check:promo — all discount code checks passed` and
`check:reviews — all rating checks passed`.

Then the migration and the build:

```bash
npm run db:migrate
npm run build
```

The migration (`drizzle/0007_nebulous_calypso.sql`) adds the `reviews` table and
one foreign key on `bookings.promo_code_id`. It is purely additive: nothing is
dropped or rewritten, and the FK cannot fail on existing rows because the column
has never been written.

For the mail steps you need SMTP configured — see `docs/INVOICE-EMAIL.md`. If it
is not, everything below still works and the console prints
`[mail] SMTP is not configured … Skipping:` instead of sending. That is a valid
way to run the whole guide; you just read the subject lines in the terminal.

```bash
npm run check:mail       # says which transport is live
npm run dev
```

## 1. Make a discount code

1. Sign in at `/admin` as an owner or manager.
2. **Discount codes** in the sidebar, under Site. → **New code**.
3. Code `EID25`, type **Percentage**, value `25`, minimum `0`, no window, no
   maximum, Active ticked. Save.

**Expect:** the row lists `EID25`, `25%`, `—` minimum, "No window", `0` uses.

A receptionist should not see this screen at all — the nav item is gated on
`marketing.manage`.

## 2. Apply it — the happy path

1. `/booking`, pick any service, pick a slot, continue to payment.
2. Note the total.
3. In **Discount code**, type `eid25` in lower case and press **Apply**.

**Expect:** the code chip shows `EID25` in upper case with a **Remove** link. A
breakdown appears: subtotal, then a red `−<amount>` row labelled `EID25`. The big
total drops by exactly 25%.

4. Fill in name, a Saudi mobile and an email, then a test card
   (`4242 4242 4242 4242`, any future expiry, any CVV) and confirm.

**Expect:** the success modal shows a ticket number, a chair, and a **total that
matches the discounted figure** — it is summed from the server's tickets, not
from the browser's selection.

5. Check the invoice email (or the terminal).

**Expect:** the discount line reads **"Discount (EID25)"**, not "Group booking
discount", and subtotal + VAT equals the total charged.

6. Back in `/admin/promo-codes`.

**Expect:** `EID25` now shows **1** use.

## 3. Two guests and a code together — the maths that matters

1. `/booking/group`, give each guest a **different** service, one slot, continue.
2. Apply `EID25`.

**Expect:** the breakdown shows **both** reductions — the 10% group discount
*and* the `EID25` line — and the total is 25% off the already-discounted bill.

3. Pay, then open the invoice.

**Expect:** two guest blocks with two tickets, and **the two guests' totals sum
exactly to the bill**. Not "within a halala" — exactly. That is what
`shareAmount` is for, and `npm run check:promo` asserts it on four different
uneven splits.

## 4. A code that is refused

Run these against the same checkout. Each should refuse and leave the total
untouched at full price.

| What to do | Expect |
|---|---|
| Type `NOTACODE`, Apply | "That code isn't valid" |
| Set `EID25`'s minimum to 900 SAR, retry on a cheap booking | "That code applies from 900 SAR" |
| Set its end date to yesterday, retry | "That code has expired" |
| Set its start date to next month, retry | "That code hasn't started yet" |
| Set max uses to 1 on an already-used code, retry | "That code has been fully used" |
| Turn the code **off**, retry | "That code isn't valid" — deliberately the same message as unknown |
| Apply, then Remove | The discount row disappears and the total goes back up |

The last row of that table is the point: an outsider must not be able to tell a
switched-off code from one that never existed.

## 5. A code applied, then a card declined

1. Apply a valid code.
2. Pay with `4000 0000 0000 0002` (the decline card).

**Expect:** "Payment didn't go through… your slot is still held." The code is
still applied and the discounted total is unchanged.

3. Retry with a good card.

**Expect:** it confirms, and the amount charged is still the discounted one. The
retry re-uses the existing hold and never re-prices it.

## 6. End the ticket — the invitation

1. `/admin/bookings`, find the booking from step 2, open it.
2. Move it to **completed**.

**Expect:** an email titled "How was your visit?" (or `كيف كانت زيارتك؟`) arrives
at the address used at checkout, with five star links and a button. The console
logs `[review] invite sent to …`.

3. **Press completed again**, or reload the action.

**Expect: no second email.** The console logs nothing new. This is the unique
index doing its job — verify it with:

```sql
select count(*) from reviews r join bookings b on b.id = r.booking_id where b.code = 'RON-XXXX';
-- 1
```

4. Complete a **walk-in** booking, which has no email address.

**Expect:** no mail and no error. The review row is still created — it records
that this appointment was never asked, which is the difference between a low
response rate and a low invite rate.

## 7. Leave the rating

1. Click the **fourth star** in the email.

**Expect:** `/review/<token>?r=4` opens with four stars already filled on "Rate
the service", and an empty technician row labelled "Rate your technician" —
generic, because no technician is assigned.

2. Set the technician to 5, write a comment, send.

**Expect:** the page flips to "Thank you!" and shows your scores and comment back
to you, read-only.

3. **Reload the same link.**

**Expect:** still the thank-you page, still read-only. The API answers `409` and
does not overwrite.

4. Open `/review/00000000-0000-4000-8000-000000000000`.

**Expect:** the site's 404 page.

5. Rate a second appointment but **skip** the technician stars.

**Expect:** it sends. The technician score is optional; skipping is not the same
as a 1.

## 8. Read them back

`/admin/reviews`:

**Expect:**

- **Average service rating** — the mean of every answered review, to one decimal.
- **Average technician rating** — likewise, subtitled *"Bookings aren't assigned
  to technicians yet"* while nothing is assigned.
- **Response rate** — answered ÷ invited, with the raw counts underneath. The
  walk-in from step 6.4 is in the denominator and not the numerator.
- A table with the appointment, service, `—` for technician, both scores as
  coloured badges (green ≥4, amber 3, red ≤2), and the comment.
- An unanswered invitation shows "Not answered"; a skipped technician shows
  "Skipped". They are different things and read differently.

Then the part that proves the design. Assign a technician **by hand** to one of
those bookings:

```sql
update bookings set technician_id = (select id from staff where role = 'technician' limit 1)
where code = 'RON-XXXX';
```

Reload `/admin/reviews`.

**Expect:** that row now names the technician, and the average-technician tile
loses its "not assigned yet" subtitle. Nothing was migrated and no review was
touched — the join found it.

Sign in as a **receptionist**: Reviews is visible, Discount codes is not.
Sign in as a **technician**: neither is.

## 9. Regression — what must not have changed

| Path | Expect |
|---|---|
| Book a single service with **no** code | Same price as before, no discount row, invoice shows no discount line |
| Book two guests with **no** code | 10% group discount, invoice line still reads "Group booking discount" |
| A refill from `/my-bookings` | Still half price, still one per booking |
| Cancel inside the window | Still refunds; `npm run check:cancel` passes |
| Leave a booking unpaid for 15 min | Hold still swept |
| Miss an appointment | No-show sweep still releases the chair and flags it |
| `npm run preview:invoice` | Renders both languages, all assertions pass |
| `npm run check:fields`, `check:cancel` | Pass |

## 10. Clean up

The rows made above are ordinary bookings, customers and reviews. Delete the
bookings and the reviews go with them (`on delete cascade`); switch the test code
off rather than deleting it if anything ever pointed at it.
