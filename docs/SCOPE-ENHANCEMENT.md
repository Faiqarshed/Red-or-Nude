# Scope enhancement — a flat refill, a checkout upsell, four to a group, and packs

Four additions the client asked for on 8 September 2026, what each one actually
costs once you look at the code, and the order to build them in.

Branch: `scope-addition`. This document is the plan. No code has been written.

---

## 1. Where this came from

Four voice notes and three messages from Hessa, forwarded by Kanwar bhai into the
"Saloon app - heesia" group between 5:08 and 5:11 pm on 8 September 2026, and
tagged there "Boys new addition to scope".

The notes were transcribed locally with faster-whisper (`large-v3`, language
pinned to English) and then checked line by line against the audio. The checking
mattered: an earlier pass detected one note as Arabic at 0.52 confidence and
invented an Arabic opening sentence that was never spoken. Everything below is
from the corrected reading.

---

## 2. What the code already gives us

Three of the four are cheaper than they sound, because the machinery is already
here. These are the facts the plans below are shaped around:

- **Money is an integer count of halalas** (`lib/db/schema.ts:1-10`). 99 SAR is
  `9900`. Nothing in the money path is a decimal and nothing here should become
  one.
- **Settings are a key/value table with code defaults** (`lib/settings.ts`).
  A knob changes with no migration and no deploy.
- **Refill is built.** `lib/refill.ts` holds the window rules,
  `bookings.refill_of_booking_id` holds the link, a partial unique index stops
  two refills of one booking, and `getRefillOffer()` builds the offer. It is
  priced as *the service price less a percentage*.
- **Add-ons are built, priced and line-itemed.** The `addons` table,
  `booking_addons` carrying a snapshotted name and price, and the roll-up in
  `priceMember()` (`lib/bookings.ts:244`). No `service_addons` rows means the
  add-on is offered with every service.
- **The payment page already posts `members[].addonIds`**
  (`app/(site)/booking/payment/page.tsx:277-283`). Anything pushed onto that
  array is priced, line-itemed and invoiced by code that exists today.
- **A group is N booking rows sharing `bookings.group_id`.** There is no group
  table, deliberately (`lib/db/schema.ts:425`). The engine — `splitGroupPrice`,
  `shareAmount`, `allocateTickets`, `reserveStations` — already takes any N.
  Only the HTTP edges and the group screen hard-code two.
- **Balances are ledgers, never columns.** `loyalty_txns` and `gift_card_txns`
  both store signed deltas and derive the balance with `SUM`. The reasoning is
  written out at `lib/db/schema.ts:742`. Packs follow it.
- **There is no component library, deliberately.** No shadcn, no Radix, no
  `components/ui`. Reuse `components/booking/Modal.tsx` and the `Card` tile
  exported by `GuestPicker.tsx`. Adding a UI dependency for any of this work
  would be more code, not less.

---

## 3. A refill costs 99

Not a new feature — a pricing model swapped on a built one, and the smallest
change in this document.

**Flat, with no floor.** 99 even where the service costs less. The client was
asked directly and was firm about it. Services too cheap to carry a refill are
kept out of the offer from the admin side, by leaving `services.refill_days` at
0. That is an operational guard and not an enforced one: nothing in the code
stops someone giving a 60 SAR service a refill window and then selling a 99 SAR
refill of it.

- `lib/settings.ts:50` — `refill_discount_percent: 50` becomes
  `refill_price_halalas: 9900`.
- `lib/refill.ts:77` — delete `refillPriceHalalas()`. A flat price needs no
  function. The window rules in that file are untouched and stay pure.
- `lib/bookings.ts:677` — `priceMember(m, …)` takes the flat price rather than a
  percentage, and the refilled service line becomes that price.
- `getRefillOffer()` (`lib/bookings.ts:1091`) — quotes the flat price, so the
  button in the customer's history and the server never disagree about what a
  refill costs.

Two things the rename drags behind it: any stored `refill_discount_percent` row
is orphaned and should be dropped, and copy that says "50% off" needs rewording
(`lib/dictionary.ts`).

---

## 4. Coffee and a cookie, at checkout

10 SAR, offered once the services are chosen and before payment, as one card per
guest — so one guest can take it and another skip it.

The client's reasoning decides where this lives, so it is worth keeping: the
salon is priced as affordable, not high-end. High-end salons fold refreshments
into the price; at this price point that is not possible, so it becomes a cheap
opt-in instead of a bundled perk. The reference image is the Crumb & Parcel pin
sent with the notes.

- **Migration** — one boolean on `addons`, `at_checkout`, defaulting to false.
- **Seed one add-on row** — localized name, `price_halalas: 1000`, and
  `duration_min: 0`.
- `duration_min` **must be 0.** An add-on with a duration changes `ends_at`, and
  this one is chosen after the chair has been quoted and is about to be held.
  That is a rule, not a detail.
- `lib/catalog.ts` — `getPublicCatalog()` separates the two kinds, so
  `GuestPicker.tsx` keeps showing only service add-ons and this one does not
  appear in two places.
- `lib/booking.ts` — carry the checkout add-ons through the `ron-booking`
  sessionStorage payload. The payment page is a client component with no server
  shell, and passing them this way avoids standing up a new API route. An
  optional field: the station-QR and gift-card flows simply won't offer it.
- **Payment page** — a checkbox card per guest in the summary `<aside>`, in the
  shape of the promo and loyalty opt-in rows already sitting there. On confirm,
  push the add-on id onto that guest's `addonIds`.

- **Never discounted.** Decided after the plan was written: 10 SAR is 10 SAR
  whether or not two people booked together, whether or not a code was typed,
  whether or not points were spent. So `priceMember()` holds checkout add-ons out
  of `grossHalalas` in a `treatHalalas` of their own, the whole discount stack
  runs on what is left, and the treats go back on last. The payment page adds
  them the same way, which is why ticking one cannot move a quoted promo or
  reward.

`booking_addons` still records it and the invoice still renders it, unchanged.
The only pricing code is the one line that keeps them out of the discounts.

### 4.1 Hot and cold, and swapping the treat each month

The salon asked for two pictures — "one hot with treats, second is cold with
treat" — and to change the sweet thing every month.

Neither needs code. The checkout renders **every** active `at_checkout` row as
its own card, so two rows are two cards, and each row carries its own `image`.
Migration `0023_hot_and_cold_treats.sql` makes sure both exist on a database
that is already live: it renames whichever single upsell `0016` left behind to
the hot one and inserts the cold one beside it. The rename keeps the original
row's id, so bookings already linked to it keep their link — and nothing is lost
either way, because `booking_addons` snapshots the name and price at the time of
sale. An old ticket still reads as what was actually bought.

**The monthly swap, for the salon:**

1. Admin → Catalog → **Upsells**
2. Click the row to edit — "Hot coffee & a treat" or "Iced coffee & a treat"
3. Change the Arabic and English names to whatever the treat is this month
4. Swap the picture with the media picker, and Save

`revalidateAll()` in `catalog/actions.ts` refreshes `/booking` and `/`, so it is
live immediately with no deploy. There is no scheduling: a monthly edit is a
monthly edit, and a scheduler would be a calendar to maintain for something that
takes four clicks.

Two rules the form already enforces, worth knowing before editing:

- **`duration_min` stays 0**, forced by `saveCatalogItem` and hidden from the
  upsell form. A treat with a duration would move `ends_at` under a booking that
  is already being held.
- **A row that has been sold cannot be deleted.** `addon_id` is half of
  `booking_addons`' primary key, so the delete is refused and the panel says
  "in use". Deactivate it instead — it disappears from checkout and every past
  ticket keeps its line. (Note the column also declares `on delete set null`,
  which can never fire for exactly that reason; the two clauses contradict each
  other and `tests/treats.test.ts` pins which one wins.)

### 4.2 What the technician sees

The half that *was* missing, and the salon's actual complaint: "she will see she
added coffee and treats so she will provide it for her".

`loadMyDay` read `booking_addons.name` with no join onto the catalogue, so a
coffee arrived in the same grey pill row as a gel removal with nothing to say
one was a drink to fetch. It now joins `addons.at_checkout` and splits the
payload into `addons` and `treats`, and My Day renders treats as their own warm
row with the picture from the catalogue — she is fetching a *specific* drink.

The same split reaches the front desk and the shared booking drawer, where it
shows only when there is one: an empty "Bring her: none" on every ticket is a
row staff learn to skip, and then miss on the ticket that has one.

**No price goes with it.** `loadMyDay` still selects no price column —
technicians don't see revenue — and `tests/treats.test.ts` asserts the payload
shape rather than trusting the eye.

---

## 5. Group booking: four guests, each with a branch and a time

The real work in this scope. Two changes at once, and they are separable — the
cap can be raised and shipped before the per-guest work starts.

### 5.1 Two becomes four

The engine needs nothing. The edges and the screen do.

- `app/api/bookings/route.ts:34` — `z.array(member).min(1).max(2)` → `.max(4)`.
- `app/api/availability/route.ts:22` — `guests` `.max(2)` → `.max(4)`.
- `app/(site)/booking/group/GroupBookingView.tsx` is written for exactly two, and
  the twoness lives in the types. `useState<[GuestState, GuestState]>` (line 55)
  becomes an array; `openGuest: 0 | 1` (62) and `setGuest(i: 0 | 1, …)` (70)
  become numbers; `setGuestName` (84) hard-codes `prev[1]` and needs an index,
  because guests two through four all need names; the
  `Math.max(totals[0].durationMin, totals[1].durationMin)` at line 99 becomes a
  spread; `bothChose` (106) becomes `allChose`.
- ~~**A guest-count step.**~~ Dropped, 10 September 2026. The Townhouse screen
  the client forwarded asks "HOW MANY PEOPLE ARE COMING?" up front; we kept the
  accordion instead and grew an "Add a guest" button under it, up to four. One
  screen rather than two, and the count is a consequence of the panels rather
  than a question asked before anyone knows the answer.
- `scripts/check-booking.ts:238` asserts that a group is two rows, and fails
  until it is generalised.
- **Copy.** `sameSlotNote` — "Both guests share one appointment — same day, same
  time" — is wrong on both counts once §5.2 lands, in English at
  `lib/dictionary.ts:572` and in Arabic at `lib/dictionary.ts:93`. The "two
  guests" phrasing in `lib/settings.ts:47`, `lib/bookings.ts:4`, `lib/db/schema.ts:425`
  and the admin views is comment-only, but it is what the next reader will
  believe.
- **Capacity.** Four chairs at one branch at one time will fail to reserve far
  more often than two did. The all-or-nothing refusal in `reserveStations` is
  the right behaviour; the message needs to name the guest who could not be
  seated.

### 5.2 Each guest picks a branch and a time

Same day is the only constraint. Times may differ and branches may differ — the
client asked for that flexibility explicitly.

Today `createBookings()` takes one `branchId` and one `startsAt` for the whole
party, and reserves N chairs at one branch and one time in a single call
(`lib/bookings.ts:685-825`).

- `BookingMember` gains optional `branchId` and `startsAt`, each defaulting to
  the party's. The solo path and the shape the client already posts are
  untouched.
- Reserve per member, one chair each, rather than once for the party.
- Enforce the **same local day** across members with `utcToLocalDate`
  (`lib/availability.ts`).
- ~~`refuseOutsideHours` per member.~~ No such function exists: opening hours are
  enforced in the slot picker (`lib/availability.ts`), and `createBookings` has
  never checked them — a hand-crafted request could always book at 3am, at any
  branch, and still can. Pre-existing and untouched by this work, but now it is
  written down.
- **Tickets.** `ticket_counters` is keyed `(branch_id, day)`, so a split party
  takes one number from each branch rather than consecutive numbers from one.
- **`rescheduleBooking()` moved the party as a unit.** It now moves only the
  booking whose reference was quoted. Dragging the rest of the party to an hour
  nobody asked for stopped being a convenience the moment guests held their own.
  The party is *not* held to one day afterwards: same-day is a rule about
  booking together, plans change, and nothing downstream depends on it.
- Cancellation fans out over `group_id` and needs no change.
- The group discount is unchanged and always applies, however the four are
  spread. `splitGroupPrice` keeps working on the combined bill.
- **UI** — a `BranchPicker` and a `ScheduleModal` per guest, inside the accordion
  that already exists. `/api/availability` is called per guest with `guests=1`,
  which also refuses fewer slots than the old "N chairs at one moment" question.
  The screen blocks a party whose days disagree; the server refuses it outright
  with `different-day`.

---

## 6. Membership packs

Entirely new, and the one to build last. "Membership" is the client's word for
this whole thing; there is no separate subscription product behind it.

Buy a bundle of services at one price instead of booking them one at a time. How
much goes in is the salon's to decide — settled 10 September 2026 — with a
**quantity per service** rather than a pool of uses across a menu: three gel
polishes and one manicure cannot become four gel polishes. Valid three months. Redemption is
wallet-shaped: the credits sit in the customer's account, she books, one comes
off. **No barcode and nothing to present** — the client was explicit that the
current way is complicated and that this must not be.

Packs are created by admin and shown at service selection, with their price and
the services they cover.

**Tables**, following `gift_cards` and `loyalty_txns` rather than inventing a
wallet:

- `packs` — the admin catalogue: localized name and description,
  `price_halalas`, `valid_days` (90), image, sort, active.
- `pack_services` — composite primary key, which services a pack covers, and how
  many of each.
- `customer_packs` — one purchase: customer, pack, `purchased_at`, `expires_at`,
  and a snapshotted name and price, the way `gift_cards` snapshots.
- `pack_txns` — signed deltas per service: `+quantity` on purchase, `-1` to
  redeem, `+1` to return, carrying `booking_id` and a reason. The grant being a
  ledger row is what snapshots the purchase — there is no table of purchased
  lines, and editing a pack cannot change what somebody already owns.

Balance is `SUM(delta)` per `customer_pack` **per service**, filtered by
`expires_at` — and expiry is decided on read, so there is no sweeper to run. There is
no stored balance column, for the reason `lib/db/schema.ts:742` already
gives about loyalty points.

- **Purchase** reuses the gift-card shape: its own selection module, its own
  checkout, `POST /api/packs`.
- **Redemption** — a member carries a `customer_pack_id`; that service line
  prices to zero and the `-1` row is written inside the same transaction as the
  booking, so a booking that fails cannot spend a credit.
- **Cancellation** writes the `+1` where `refundBookings()` is already called
  (`app/api/my-bookings/cancel/route.ts`), inside the same `cancel_cutoff_hours`
  window that governs refunds. Cancel late and the credit is spent, exactly as
  money would be.
- **A no-show** follows the existing no-show path rather than burning the
  credit: `rescheduleNoShow()`
  (`app/(admin)/admin/(shell)/bookings/actions.ts:328`).

---

## 7. Build order

Ascending cost, which is also descending certainty:

1. **§3, the flat refill** — a setting, a deleted function, two call sites.
2. **§4, the checkout upsell** — one column, one seeded row, one card, and no
   pricing code at all.
3. **§5.1, two becomes four** — the edges and one screen. Shippable on its own.
4. **§5.2, per-guest branch and time** — the booking engine, and the reschedule
   path with it.
5. **§6, packs** — four tables, a purchase flow, and a redemption path.

All five are built as of 10 September 2026. What §6 gained beyond the plan: a
partial unique index on `(booking_id, service_id)` so a retried request cannot
spend two credits for one appointment; a refusal to delete a booking that spent
one, for the reason loyalty points are already refused; and `payments` carrying
`customer_pack_id`, so a pack sale lands where every other sale lands.

Not built, and still not in this phase: a pack paying for a **group** booking.
The booking screen offers a credit on the solo page only.

---

## 8. Not in this phase

Group size above four. A pack paying for a group booking. Combining a pack credit
with a promo code or a loyalty rung on the same line. Gifting a pack, or
part-refunding one. A membership that is a recurring subscription rather than a
prepaid bundle — the client used the word, but described only the bundle.

And one thing to read before any of this is built: the truncated "Okay dont build
it now…" message from 7 September. It may scope something out.

---

## 9. Still open

- ~~The refill eligibility window against a flat price.~~ Settled 10 September
  2026: 99 is the price of any refill of any service that has a window, whatever
  the service costs and however long its window is. A 350 SAR set refilled on day
  13 of a 14-day window is still 99. Services too cheap for that are kept out of
  the offer by leaving `refill_days` at 0, which is an operational guard and not
  an enforced one.
- Whether a pack tile belongs among the service cards or above them.
- Whether the cap ever moves past four. The Townhouse screen the client sent
  offers a `7+` row, and the engine would already take it.
