# Payment hardening plan

## Context
The StreamPay integration works in the sandbox. A pessimistic review found 26 gaps where:
- money can be lost;
- a customer can pay twice;
- or a customer who paid ends up with nothing.

The triggers are dropped internet, our site or StreamPay being down, lost messages between us and StreamPay, and fraud. The user picked a solution for each gap. The senior reviewed PR 21 and asked for changes, which are folded in below. Goal: no paid money goes unnoticed, nobody pays twice, a paid customer gets what she paid for or her money back under the refund rule, and the owner hears about anything a person must fix.

Fixed decisions:
- Card entry stays on our page (StreamPay embed); OTP on StreamPay's page.
- The gift card code visible via the ref (old #5) is accepted.
- Production moves to **Azure**. While testing on Vercel the settle job stays every 2 days. **No live money is taken before the Azure 5-minute schedule is running** (senior, should-fix 2).

## Refund rule (decided)

One idea: **money goes back to the card only when she paid and never got what she paid for.** Once a booking is confirmed or an item delivered, it's wallet credit or nothing.

| Situation | She gets |
|---|---|
| Paid, but the booking was never confirmed (late payment, appointment already started, money on a written-off payment) | Automatic **card refund** + email |
| Paid for a gift card or membership we couldn't deliver | Automatic **card refund** + email |
| Paid for a chair purchase we couldn't deliver, **over 10 SAR** | Automatic **card refund** + email |
| Paid for a chair purchase we couldn't deliver, **10 SAR or less** | **Wallet credit** + email (a small card refund costs more in fees than it's worth) |
| She cancels **more than 3 h** before | **Wallet credit** for everything she paid (card + any wallet credit spent) |
| She cancels within 3 h | Not allowed, so nothing |
| She doesn't show up | Nothing (spent points are not returned either) |
| The salon cancels more than 3 h before | **Wallet credit** |
| The salon cancels within 3 h | Not allowed in admin |
| The salon reschedules | The salon's call, no money moves |
| The wallet balance | Admin cannot edit it. Only cancellations and small chair refunds add to it. It can be spent on **everything**: bookings, gift cards, memberships and chair purchases |

The senior recommends the salon confirms three things with its legal adviser and accountant before the wallet goes live:
- that credit-only is allowed under Saudi consumer-protection and e-commerce rules;
- that the policy is shown at checkout with an explicit "I accept";
- the VAT treatment of credit notes and of spending credit.

These are questions for the client. They don't change this rule.

## Already handled: nothing to build, nothing to set up

These are covered by the code as it is today. They need no change and no configuration.

**Money and pricing**
- **Price tampering:** the server re-prices every bill from the catalogue and ignores any figure the browser sends.
- **StreamPay's total must equal ours:** after creating the payment link we compare its total with ours. If they differ, the link is switched off before anyone can pay.
- **Paid amount different from the bill:** not confirmed and not delivered, and listed in the report for a person to handle.
- **Zero bill:** confirmed without ever reaching StreamPay.
- **Invalid promo code or points at checkout:** the booking is refused with the reason; she's never silently charged full price.
- **Gift card amounts:** only the salon's preset amounts are accepted.

**Never charging twice, never confirming twice**
- **Double tap, second tab, reload:** the database allows only one live payment per booking (`payments_booking_live_unique`), and each StreamPay link accepts one payment. Pressing Pay again reopens the same checkout.
- **Return page, status check, webhook and settle job arriving together:** a single database update from pending to paid decides who confirms.
- **Webhook sent twice or replayed:** the second one finds it already paid and does nothing.

**Trust and security**
- **A fake "paid" in the URL or webhook body:** never believed. We always ask StreamPay directly.
- **Forged webhook:** HMAC signature check, accepted only within 5 minutes. A missing secret rejects every webhook.
- **Card numbers:** typed only into StreamPay's box and never reach our server.
- **Production running the fake payment driver by mistake:** payments are refused.

**Crashes and failures**
- **Our server crashes while confirming a booking:** one database transaction, so it all happens or none of it does.
- **Our server crashes while delivering a purchase:** delivery and its link to the payment are saved together.
- **Her internet drops before Pay reaches us:** nothing is charged, and the chair stays held.
- **Our answer to Pay never reaches her:** pressing Pay again reopens the saved checkout.
- **Our request to StreamPay never arrives:** the attempt fails cleanly. Nothing is charged.
- **StreamPay's answer to "was it paid?" is lost:** the next check asks again.
- **Our database is down:** everything waits, StreamPay retries the webhook, and the settle job catches up.
- **StreamPay's checkout script is blocked:** she's sent to StreamPay's hosted payment page.

**Payment outcomes**
- **Card declined:** the same checkout stays open for another card, and the chair stays held.
- **3-D Secure still processing:** treated as pending, not failed.
- **Paid after her hold expired:** automatic card refund + email.
- **Paid for something we couldn't deliver:** automatic card refund + email (small chair purchases change to wallet credit in this plan).
- **She closed the tab and the webhook never came:** the settle job finds it.
- **Anything a person must look at:** listed in the report email.

**Chairs and credits**
- **Two people booking one chair at once:** a database row lock puts them in line, with a unique index as backup. Whoever presses Pay first gets the chair.
- **Membership credit spent twice:** row lock + unique index.
- **Staff delete a paid booking:** the payment record survives.

## Chair reservation: confirmed by the senior
- **Reserve at Pay:** confirmed.
- **15-minute hold, plus up to 10 while a payment is open:** confirmed (`booking_hold_min` is already an admin setting).
- **Up to about 25 min blocked when abandoned:** acceptable.

The senior's additions are in the build list below: H1 to H4.

## Decisions and how each is built

Numbers match the 26-item list. H items are new ones from the senior's review.

### Before go-live

**1. Card testing: limits only**
- `app/api/gift-cards/route.ts`: 429 after 5 attempts an hour per IP, and 5 an hour per buyer email.
  - Counted in the DB: `startPurchase` (`lib/payments/purchase.ts`) stores `ip` in `payments.raw`; count gift-card payment rows in the last hour.
  - Keep `throttled()` (`lib/throttle.ts`) as a cheap first line.
- Same per-IP limit on `app/api/payments/confirm/route.ts`.
- `clientIp()`: strip a `:port` (Azure's X-Forwarded-For can carry one).

**2. Paying twice after coming back: check first, then show**
- `releaseHold()` (`lib/booking.ts`): clear the local `held` only when the server released it.
- `app/api/bookings/release/route.ts` + `releaseWebHold` (`lib/bookings.ts`): say why it wasn't released: `paying` or `booked`.
- `app/(site)/booking/payment/page.tsx`, on load: if the release was refused, keep `heldCode`, show `CheckingModal`, and call confirm. That returns tickets (paid) or reopens the same checkout (paying). Only an expired hold starts fresh.
- Needs #24.

**3. Money on a written-off or unknown payment: rechecks + alert**
- `verify()` (`lib/payments/streampay.ts`):
  - any unknown payment status → `pending` + owner alert, never `failed`;
  - **a `COMPLETED` link with no payment on its invoice yet → `pending`, never `failed`** (senior, must-fix 1).
- `reconcile.ts`: also recheck **failed** payments with a link, 15 min to 48 h old. Backoff: when `raw.checkedAt` is older than a quarter of the payment's age (about 15 m, 1 h, 6 h, 24 h, 47 h).
- **Revive:** when `verify` says paid on a failed row, flip `failed → pending` (conditional update) and run the normal settle with that verdict. So it confirms or delivers if still possible, otherwise refunds under the refund rule. If the flip hits `payments_booking_live_unique`, alert + list it in the report.
- Webhook: a `PAYMENT_SUCCEEDED` for a failed row, or a row with no `linkId`: save `linkId` from the event, revive immediately, alert.
- `alertOwner(key, subject, text)` next to `reportPaymentProblems` (`lib/payments/reconcile.ts`): `sendMail` to `PAYMENTS_ALERT_EMAIL`, each key at most once an hour (in-memory, per instance).

**4. Paid chair given away: ask StreamPay first**
- `createBookings` (`lib/bookings.ts`), **before** the transaction: for expired web holds at the target branches whose pending payment has a link, run `settlePayment(ref)`. At most 5, short timeout, no lock held during the call.
- `sweepExpiredHolds` spares holds whose linked pending payment is still unresolved, capped at 30 min past the pay window.

**6. Webhook dropped on a StreamPay blip: answer "try again"**
- `settleBookingPayment` / `settlePurchase`: when `verify` throws, return `unverified` instead of `failed`.
- `settlePayment` maps it to `{ status: "pending" }`.
- The webhook replies **503**, so StreamPay resends.

**8. Return redirect: allow only our pages**
- `app/api/payments/return/route.ts`: `back` must be `/booking/payment`, `/gift-card/payment`, `/memberships/payment`, or match `^/station/[A-Za-z0-9-]+$`. Anything else goes to `/`.

**9. Strangers share a gift card checkout: own id per attempt**
- Gift card payment page: `attemptId = crypto.randomUUID()` once per filled form, kept in `sessionStorage`, reset after success or "new card".
- `app/api/gift-cards/route.ts`: put it in `GiftIntent`; the whole-intent match in `startPurchase` then scopes resume to that attempt.

**10. Settle job monitor**
- The cron route pings `HEALTHCHECK_URL` (healthchecks.io) after each run, if set.

**11. Confirmed after the appointment started: card refund**
- `settleBookingPayment` transaction: if any member's `startsAt <= now`, throw `started`. The existing catch refunds with `refundRef(ref, "late-payment")` and emails her.

**12. Chair purchase after the visit ended: card refund, or wallet credit up to 10 SAR**
- `deliver()` treat branch (`lib/payments/purchase.ts`): if the booking is `completed`/`cancelled`/`no_show` or `endsAt < now`, return `null`.
- **Small chair refunds go to the wallet.** One helper, `refundOrCredit(ref)`, used wherever a paid **chair purchase** isn't delivered: `settlePurchase`'s not-delivered path and the reconciler's undelivered loop.
  - `intent.kind === "treat"` and amount ≤ **10 SAR** (`CHAIR_CREDIT_MAX_HALALAS = 1000`, one constant) → wallet credit + email;
  - otherwise → `refundRef` as today.
  - Gift cards and memberships always get a card refund.
- **Until the wallet exists:** a small chair refund is marked `owedCredit` on the payment and listed in the daily report for the desk. No card refund.

**13. Refund retry, checking first** (moved up: senior, must-fix 2)
- `refundPaid` (`lib/payments/refund.ts`): before calling `driver.refund`, call `driver.verify(raw)`. If StreamPay already shows it refunded, just record it. Needs a `refunded` verdict (`Verdict` in `lib/payments/index.ts` + `streampay.ts`).
- `refund()` (`streampay.ts`): a refund answered "pending", or a timeout, is not a failure. Record it as pending, and the next check confirms it.
- `reconcile.ts`: also retry the `owedBookings` set the same way, 15 min to 7 days old.

**18a. Sandbox and live ids never mix** (senior, should-fix 1)
- `lookup`/`remember` (`streampay.ts`): prefix keys with the first 8 hex of `sha256(apiKey)`. No migration; old sandbox rows are simply recreated once.

**24. Paying again after paid shows the ticket** (needed by #2)
- `confirmBookingPayment`: when the party has a **paid** payment, return `settleBookingPayment(thatRef)` (tickets) instead of `expired`.

**H1. A lapsed hold frees the slot at once** (senior, Q3)
- The availability queries in `lib/availability.ts` (the conflict scan used by `computeDay` and `reserveStations`) ignore web holds that are `pending`, older than `booking_hold_min`, and have no open checkout. Use `checkoutOpen` (`lib/payments/index.ts`), the same rule `sweepExpiredHolds` uses.
- So a quiet branch no longer shows an abandoned slot as taken for hours.

**H2. Free the chair when she closes the checkout** (senior, Q1)
- Payment page: on `pagehide`, send the release with `navigator.sendBeacon` (same body as `releaseHold`). Back already releases.
- Safe while she's paying: the server refuses to release a hold with a pending payment.

**Overlap rule (DB)**
- Migration `drizzle/0028_no_chair_overlap.sql`, hand-written: `btree_gist` + `exclude using gist (station_id with =, tstzrange(starts_at, ends_at) with &&) where (status not in ('cancelled','no_show'))`.
- Run an overlap check on the data first.
- `isSlotConflict` (`lib/bookings.ts:257`) recognises the new constraint.
- Note for H1: an expired hold still occupies its range in this constraint. So a new booking into a lapsed hold's slot must sweep that hold first. `createBookings` already sweeps before reserving, so it does.

**26. Real card test** (manual, **needs a real card**; can't be done in the sandbox)
- After live keys: one 1 SAR payment with a real mada card (a second bank if possible).

**Checks before live keys** (no code)
- One discounted sandbox invoice: VAT is calculated on the price **after** the discount (ZATCA) (senior, Q4).
- `npx drizzle-kit generate` comes out empty, so the hand-trimmed 0027 snapshot hasn't drifted.
- The Azure 5-minute settle schedule + daily report are running before live money.

**Docs before go-live**
- `docs/ADMIN-PANEL.md` §9 and `docs/BOOKING-V2.md`: name StreamPay, not "Moyasar vs Tap" (senior, should-fix 4).
- `docs/PAYMENTS-STATUS.md`: the refund rule marked "decided, wallet not built". Today the code still refunds the card on her cancel, and nobody should read the doc as shipped (senior, should-fix 3).

### Right after go-live

**5 + 22. Daily recheck against StreamPay** (senior, Q6)
- A daily job lists StreamPay payments for the last 30 days (`GET /api/v2/payments` with `from_date`/`to_date`, confirmed by the senior) and compares them with ours.
- Any refund, chargeback or payment we don't know about goes into the report.
- **A gift card whose payment was refunded or charged back is frozen automatically.**
- This also covers #22 (daily totals comparison) and is the final net for #3.
- Ask StreamPay whether they send refund or dispute webhooks, to make it real-time later.

**7. StreamPay down: honest message + owner alert**
- #6 already keeps the page polling. After a return it ends on the existing `unconfirmed` text ("don't pay again").
- `api()` (`streampay.ts`): at 5 consecutive failures, `alertOwner("streampay-down")`, and one "back" message after.

**14. The report shows every unresolved payment**
- `paymentProblems()`: `stuck` drops the 48 h lookback. Add the "paid on an old attempt" and `owedCredit` lists.

**15. Status endpoint: limit + reuse answer**
- `throttled` per IP, 60 a minute. Memo `settlePayment(ref)` per ref for 5 s.

**16. Points spent twice: recheck under the lock**
- `createBookings`: after the customer row lock, re-read the balance inside the transaction. `loyaltyBalance` (`lib/loyalty.ts`) takes an optional `tx`.

**19. Config: refuse + ignore debug**
- `getDriver()` production guard: refuse payments when `SITE_URL` is missing or not `https://`.
- `STREAMPAY_DEBUG` only outside production.

**20. Stuck "in progress": time limits + retry in 1 min**
- StreamPay per-call timeout 20 s → 10 s.
- A pending row with no link older than **2 min** is buried and a fresh attempt allowed.
- A slow original charge saves `raw` only `WHERE status = 'pending'`; if its row was buried, it deactivates its link (`driver.cancel`).

**H3. Countdown and "held" in admin** (senior, Q1)
- Payment page: show the time left on her hold (from the booking's `createdAt` + `booking_hold_min`, or the pay window once a checkout is open).
- Admin calendar/bookings list: web bookings in `pending` are shown as **Held**, not as booked.

**H4. Pay-to-paid time** (senior, Q2)
- No code needed: it's `payments.updatedAt − payments.createdAt` on paid rows. Add one line to the daily report (median and slowest this week) so the 15-minute hold can be revisited after the first month.

### Soon

**18b. Self-heal missing StreamPay ids**
- On a 4xx from `POST /payment_links` naming a missing product or coupon: delete that checkout's `streampay_ids` rows and retry once.

**21. Undelivered purchase: retry delivery, then refund**
- Export `redeliver(ref)` from `purchase.ts`; the reconciler's undelivered loop tries it before `refundOrCredit`.

**H5. Sweep expired holds on the 5-min schedule** (senior, optional)
- The settle job also runs the sweep for every branch, to keep the admin calendar tidy.

**Webhook lookup index** (senior, suggestion 2)
- Expression index on `payments ((raw->>'linkId'))` once volume grows.

### Wallet: its own PR, after the salon confirms (senior, Q5)
Scope:
- a `wallet_txns` ledger (customer, booking, amount, reason), with no admin editing;
- balance on /account;
- "Use my credit" at **every** checkout (bookings, gift cards, memberships, chair purchases), sent to StreamPay as a coupon like points. A bill fully covered by credit never reaches StreamPay, the same as a zero bill today.
  - Purchases: `startPurchase` (`lib/payments/purchase.ts`) takes the wallet discount (today it always sends `discounts: []`), and the debit is tied to the payment so an abandoned checkout releases it.
  - **Signed-in only.** The credit belongs to her account. At the chair, the QR token only proves someone is at the table, not who they are, so spending credit there needs her to sign in.
  - Ask the accountant: spending credit on a VAT-exempt gift card.
- the customer cancel route credits the wallet instead of `refundBookings`;
- the admin cancel refuses inside 3 h and credits the wallet otherwise;
- no-show keeps spent points (`isDead` in `lib/rewards.ts`);
- turn `owedCredit` chair refunds into real credit;
- cancel and checkout copy;
- remove `refundBookings` and the unused `payments.refund` permission.

### Not building
- **17.** Price change during checkout: left as is.
- **23.** Refund fails after payout: a question for StreamPay; #13 covers the retry.
- **25.** Partial refund counted as full: skipped.

### Questions
**For StreamPay:**
- refund/dispute webhooks;
- the full list of payment statuses;
- refund fees;
- what happens to a refund when the balance is low.

**For the client** (from the senior):
- whether credit-only for cancellations is legal, and whether it's shown at checkout with an accept;
- VAT on credit;
- who may refund from StreamPay's dashboard;
- how chargebacks are handled;
- whether any promo codes are private (a coupon's name prints the code on the invoice).

## Build order
1. **Before go-live:**
   - #8, #9, #24 → #2;
   - #6, #3, #13, #4, #11, #12, H1, H2, #1, #10, #18a;
   - the overlap migration;
   - the doc fixes;
   - then the checks before live keys and #26.
2. **Right after:** #5 + #22, #7, #14, #15, #16, #19, #20, H3, H4.
3. **Soon:** #18b, #21, H5, the webhook index.
4. **Wallet:** a separate PR once the salon confirms.

One commit per group, docs in the same commit.

## Verification
**Tests** (fake driver with a controllable verdict, as in `tests/streampay.test.ts` / `tests/concurrency.test.ts`):
- verify throws → webhook 503, status pending (#6);
- a `COMPLETED` link with no payment yet stays pending; an unknown status → pending + alert (#3);
- a failed row later paid → revived and confirmed, or refunded if the hold is gone or the time has started (#3, #11);
- an expired hold with a paid payment isn't swept (#4); a lapsed hold with no checkout shows as free (H1);
- a refund already done at StreamPay isn't sent again (#13);
- confirm on a paid party returns tickets (#24); the release is refused while paying (#2);
- return route rejects `%09/evil.com` and `//evil.com` (#8);
- two gift card attempts never share a ref (#9);
- a chair purchase after the visit: 10 SAR → wallet credit (`owedCredit`), 15 SAR → card refund (#12);
- two overlapping bookings on one chair → refused by the DB;
- the gift card limit returns 429 on the 6th attempt (#1).

**Checks:** `npx tsc --noEmit`, `npm test`, `next build`.

**Sandbox:**
- pay, press Back from the OTP → ticket shown, no second charge;
- abandon a checkout → the slot reappears after the hold;
- a bad key while polling → "don't pay again" + one owner email;
- a discounted invoice's VAT is on the post-discount price.
