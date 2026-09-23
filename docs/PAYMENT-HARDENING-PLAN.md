# Payment hardening plan

## Context
The StreamPay integration works in the sandbox. A pessimistic review found 26 gaps where:
- money can be lost;
- a customer can pay twice;
- or a customer who paid ends up with nothing.

The triggers are dropped internet, our site or StreamPay being down, lost messages between us and StreamPay, and fraud. The user picked a solution for each gap (answers below). Goal: no paid money goes unnoticed, nobody pays twice, a paid customer gets her booking or an automatic refund, and the owner hears about anything a person must fix.

Fixed decisions (not changing):
- Card entry stays on our page (StreamPay embed); OTP on StreamPay's page.
- The gift card code visible via the ref (#5 old) is accepted.
- Production moves to **Azure**. While testing on Vercel the settle job stays every 2 days. On Azure it becomes every 5 min, plus a separate daily report.

## Already handled: nothing to build, nothing to set up

These are covered by the code as it is today. They need no change and no configuration.

**Money and pricing**
- **Price tampering:** the server re-prices every bill from the catalogue and ignores any figure the browser sends.
- **StreamPay's total must equal ours:** after creating the payment link we compare its total with ours. If they differ, the link is switched off before anyone can pay.
- **Paid amount different from the bill:** not confirmed and not delivered, and listed in the report for a person to refund. Should never happen, because of the check above.
- **Zero bill** (membership credit, a 100% code or points covering everything): confirmed without ever reaching StreamPay.
- **Invalid promo code or points at checkout:** the booking is refused with the reason; she's never silently charged full price.
- **Gift card amounts:** only the salon's preset amounts are accepted.

**Never charging twice, never confirming twice**
- **Double tap, second tab, reload:** the database allows only one live payment per booking (`payments_booking_live_unique`), and each StreamPay link accepts one payment. Pressing Pay again reopens the same checkout.
- **Return page, status check, webhook and settle job arriving together:** a single database update from pending to paid decides who confirms; the rest read the result.
- **Webhook sent twice or replayed:** the second one finds it already paid and does nothing.

**Trust and security**
- **A fake "paid" in the URL or the webhook body:** never believed. We always ask StreamPay directly.
- **Forged webhook:** HMAC signature check, accepted only within 5 minutes. A missing secret rejects every webhook rather than accepting them.
- **Card numbers:** typed only into StreamPay's box and never reach our server.
- **Production running the fake payment driver by mistake:** payments are refused unless StreamPay is configured.

**Crashes and failures**
- **Our server crashes while confirming a booking:** confirming is one database transaction, so it all happens or none of it does.
- **Our server crashes while delivering a gift card, membership or chair purchase:** delivery and its link to the payment are saved together, so it's all or nothing.
- **Her internet drops before Pay reaches us:** nothing is charged, and the chair stays held for a retry.
- **Our answer to Pay never reaches her:** the checkout is saved on our side, so pressing Pay again reopens it.
- **Our request to StreamPay never arrives:** the attempt fails cleanly and she can retry. Nothing is charged.
- **StreamPay's answer to "was it paid?" is lost:** the next check asks again.
- **Our database is down:** everything waits, StreamPay retries the webhook, and the settle job catches up.
- **StreamPay's checkout script is blocked:** she's sent to StreamPay's hosted payment page instead.

**Payment outcomes**
- **Card declined:** the same checkout stays open for another card, and the chair stays held.
- **3-D Secure still processing:** treated as pending, not failed.
- **She pays after her hold expired:** automatic full card refund + email.
- **She paid for a gift card, membership or chair item we couldn't deliver:** automatic full card refund + email.
- **She paid and closed the tab, and the webhook never came:** the settle job finds it (every 2 days while testing on Vercel, every 5 min on Azure).
- **Anything a person must look at** (a refund owed, a payment with no answer from StreamPay): listed in the report email.

**Chairs and credits**
- **Two people booking the same chair at the same time:** a database row lock on the branch's chairs puts them in line, and a unique index backs it up. Whoever presses Pay first gets the chair; the other is told before entering a card.
- **Membership credit spent twice:** row lock + unique index.
- **Staff delete a paid booking:** the payment record survives.

Go-live setup still needed (not code) is listed in `docs/PAYMENTS-STATUS.md` §4: register the webhook, production env vars, migration, `streampay:sync`, the Azure timers, the real card test.

## Awaiting senior confirmation: the chair reservation (hold)

How it works today:
1. When she presses **Pay**, the chair is reserved first: a *pending* booking row in the database. Grabbing the chair uses a database row lock for a few milliseconds.
2. The payment opens on our page (StreamPay's box). The OTP opens on StreamPay's page, then she comes back to us.
3. Paid: the booking is confirmed and she gets her ticket.
4. Not paid: the reservation lapses after **15 min** (up to about **25 min** if a payment is still open), and the chair is free again. It's released lazily, when someone else books at that branch.
5. Two people, one chair: whoever presses Pay first gets it. The other is told "that time was just taken" before entering a card.

Why not reserve only after payment is confirmed? Two customers could then both pay for the last chair, and one would need a card refund (5 to 14 days, fees, chargeback risk). Gift cards and memberships can't run out, so they have no reservation and are created only after payment.

Questions sent to the senior:
1. Are you OK with reserving the chair at Pay rather than at payment confirmation?
2. Is 15 min, plus up to 10 min while a payment is open, the right length?
3. Is it acceptable that an abandoned payment blocks the chair for up to about 25 min?

Until answered, the plan assumes: reserve at Pay, hold 15 min. The overlap rule below (no two overlapping bookings on one chair, enforced by the database) is independent of these answers.

## Decisions and how each is built

Numbers match the final 26-item list.

### Before go-live

**1. Card testing: limits only (no captcha, no daily cap)**
- `app/api/gift-cards/route.ts`: refuse (429) after 5 attempts an hour per IP, and 5 an hour per buyer email.
  - Counted in the DB, not in memory: `startPurchase` (`lib/payments/purchase.ts`) stores `ip` in `payments.raw`, then we count gift-card payment rows in the last hour. Survives several Azure instances.
  - Keep the existing in-memory `throttled()` (`lib/throttle.ts`) as a cheap first line.
- Same per-IP limit on `app/api/payments/confirm/route.ts` (bookings are also open to guests).
- `clientIp()` in `lib/throttle.ts`: strip a `:port`. Azure's X-Forwarded-For can carry one, which would make every request a new "IP".

**2. Paying twice after coming back: check first, then show**
- `lib/booking.ts` `releaseHold()`: clear the local `held` only when the server actually released it.
- `app/api/bookings/release/route.ts` + `releaseWebHold` (`lib/bookings.ts`): answer why a hold was not released: `paying` (a pending payment exists) or `booked` (already confirmed).
- `app/(site)/booking/payment/page.tsx`, on load:
  - if the release was refused, keep `heldCode`, show `CheckingModal`, and call confirm with that code;
  - confirm returns tickets (paid) or reopens the same checkout (paying);
  - only an expired hold starts fresh.
- Needs #24 (confirm returns tickets for a paid booking).

**3. Money on a written-off or unknown payment: scheduled rechecks + alert**
- `lib/payments/streampay.ts` `verify()`: any payment status outside the known lists → `pending` + owner alert, never `failed`.
- `lib/payments/reconcile.ts`: also pick **failed** payments that have a link, created 15 min to 48 h ago. Backoff: recheck when `raw.checkedAt` is older than a quarter of the payment's age, which gives about 15 m, 1 h, 6 h, 24 h, 47 h with no stage bookkeeping.
- When `verify` says paid on a failed row, **revive** it:
  - flip `failed → pending` with a conditional update, then run the normal settle with the known verdict;
  - so it confirms or delivers if still possible, otherwise the existing late-payment refund runs (#11 applies);
  - if the flip hits `payments_booking_live_unique` (a newer attempt exists), alert + list it in the report as "paid on an old attempt, refund by hand".
- `app/api/payments/streampay/webhook/route.ts`: a `PAYMENT_SUCCEEDED` for a failed row, or a row with no `linkId`:
  - save `linkId` from the event (`data.payment_link.id`);
  - revive immediately;
  - alert.
- New tiny `alertOwner(key, subject, text)` helper next to `reportPaymentProblems` in `lib/payments/reconcile.ts`: reuses `sendMail` + `PAYMENTS_ALERT_EMAIL`, sends the same key at most once an hour (in-memory; ponytail note: per instance).

**4. Paid chair given away: ask StreamPay first**
- `createBookings` in `lib/bookings.ts`, **before** the transaction:
  - find expired web holds at the target branches whose pending payment has a link;
  - `settlePayment(ref)` each, at most 5, with a short timeout.
  - Outside the transaction so no lock is held during a network call.
- `sweepExpiredHolds` spares holds whose pending payment has a link and is still unresolved after that settle (StreamPay unreachable). Capped at 30 min past the pay window, so a chair is never blocked forever.

**6. Webhook dropped on a StreamPay blip: answer "try again"**
- `settleBookingPayment` (`lib/payments/confirm.ts`) and `settlePurchase` (`lib/payments/purchase.ts`): when `verify` throws, return a new error `unverified` instead of `failed`.
- `settlePayment` (`lib/payments/settle.ts`) maps `unverified` to `{ status: "pending" }`, flagged unverified.
- The webhook replies **503** when unverified, so StreamPay resends.

**8. Return redirect: allow only our pages**
- `app/api/payments/return/route.ts`: `back` must be `/booking/payment`, `/gift-card/payment`, `/memberships/payment`, or match `^/station/[A-Za-z0-9-]+$`. Anything else goes to `/`.

**9. Strangers share a gift card checkout: own id per attempt**
- `app/(site)/gift-card/payment/page.tsx`: make `attemptId = crypto.randomUUID()` once per filled form, keep it in `sessionStorage`, and reset it after success or "new card".
- `app/api/gift-cards/route.ts`: accept `attemptId` (uuid) and put it in `GiftIntent`. The existing whole-intent match in `startPurchase` then scopes resume to that attempt. Missing → server generates one (no resume).
- Also fixes #24-old (two taps making two links).

**10. Settle job monitor: free external monitor**
- `app/api/cron/settle-pending/route.ts`: after a run, `fetch(process.env.HEALTHCHECK_URL)` if set (short timeout, errors ignored). Set it up at healthchecks.io for the Azure schedule.

**11. Confirmed after the appointment started: refund**
- `settleBookingPayment` transaction: if any member's `startsAt <= now`, throw `started`. The existing catch claims the payment and calls `refundRef(ref, "late-payment")`, which emails her.

**12. Chair purchase delivered after the visit: refund**
- `deliver()` treat branch (`lib/payments/purchase.ts`): read the booking; if it is `completed`/`cancelled`/`no_show` or `endsAt < now`, return `null`. The existing not-delivered path refunds and emails.

**Overlap rule (DB): add it**
- New migration `drizzle/0028_no_chair_overlap.sql`, hand-written like 0024/0025:
  - `create extension if not exists btree_gist`;
  - on `bookings`: `exclude using gist (station_id with =, tstzrange(starts_at, ends_at) with &&) where (status not in ('cancelled','no_show'))`.
- Before applying, run an overlap check query on staging and prod data.
- `isSlotConflict` (`lib/bookings.ts:257`): also recognise the new constraint name.

**24. Paying again after paid shows the ticket (needed by #2)**
- `confirmBookingPayment` (`lib/payments/confirm.ts`): when the party is not pending but has a **paid** payment row, return `settleBookingPayment(thatRef)` (tickets) instead of `expired`.

**26. Real card test**: manual. After live keys, one 1 SAR payment with a real mada card (a second bank if possible) to confirm the bank OTP returns to our page. **Can't be tested without a real card**; flagged in PAYMENTS-STATUS.

### Right after go-live

**7. StreamPay down: honest message + owner alert**
- #6 already turns a failed verify into "pending", so the page keeps polling. After a return it ends on the existing `unconfirmed` text ("don't pay again"), not `bookingFailed`.
- `lib/payments/streampay.ts` `api()`: count consecutive failures (in-memory). At 5, `alertOwner("streampay-down", …)`. On the next success after an alert, send one "StreamPay is back".

**13. Late-payment refund retry, checking first**
- `lib/payments/refund.ts` `refundPaid`: before calling `driver.refund`, call `driver.verify(raw)`. If StreamPay already shows it refunded, record the refund rows without a second call. Needs a `refunded` verdict in `verify` (`lib/payments/index.ts` `Verdict` + `streampay.ts`).
- `reconcile.ts`: retry the `owedBookings` set (paid, booking not confirmed, no amount mismatch, 15 min to 7 days old) the same way the undelivered set is retried.

**14. Report shows every unresolved payment**
- `paymentProblems()` in `reconcile.ts`: the `stuck` query drops the lookback (its own condition instead of `UNANSWERED`). Add the "paid on an old attempt" list from #3.

**15. Status endpoint: limit + reuse answer**
- `app/api/payments/status/route.ts`: `throttled` per IP, 60 a minute (a page polls at most 20).
- Memo `settlePayment(ref)` per ref for 5 s (module-level Map, per instance).

**16. Points spent twice: recheck under the lock**
- `createBookings`: after the customer row `for("update")`, re-read the balance inside the transaction and abort with `reward-invalid` if it's now short.
- `loyaltyBalance` (`lib/loyalty.ts`) takes an optional executor (`tx`).

**19. Config: refuse + ignore debug**
- `getDriver()` (`lib/payments/index.ts`) production guard: also refuse payments when `SITE_URL` is missing or not `https://`.
- `STREAMPAY_DEBUG` is honoured only when `NODE_ENV !== "production"` (`streampay.ts`, webhook route).

**20. Stuck "in progress": time limits + retry in 1 min**
- `streampay.ts` `api()`: per-call timeout 20 s → 10 s.
- `confirmBookingPayment`: a pending row with no link older than **2 min** (was the whole hold) is buried and a fresh attempt allowed.
- When a slow original charge finishes, it saves `raw` only `WHERE status = 'pending'`. If the row was already buried, it deactivates the new link (`driver.cancel`) and returns an error, so two payable links can never exist.

### Soon

**18. StreamPay ids: self-heal + separate accounts**
- `streampay.ts` `lookup`/`remember`: prefix keys with the first 8 hex of `sha256(apiKey)`, so sandbox and live (or any account change) never share ids. No migration; old sandbox rows are simply recreated once.
- On a 4xx from `POST /payment_links` that names a missing product or coupon: delete that checkout's `streampay_ids` rows and retry once.

**21. Undelivered purchase: retry delivery, then refund**
- Export `redeliver(ref)` from `purchase.ts` (re-runs `deliver`).
- The reconciler's undelivered loop calls it first, and `refundRef` only if it returns null.

**22. Daily comparison with StreamPay**
- A new step in the daily report run compares yesterday's paid total, refunds and count with StreamPay's.
- **Needs a StreamPay list endpoint with a date filter.** Check their API docs first. If there isn't one, raise it with StreamPay before building.

### On hold / not building (documented only)
- **5. Refunds and chargebacks outside our app:** on hold. Document the issue, both solutions (listen to refund/dispute events if StreamPay sends them, otherwise a daily 30-day recheck of paid payments), and the staff rule that refunds are only done through our app, never in StreamPay's dashboard.
- **17. Price change mid-checkout:** left as is (rare; nobody overcharged).
- **23. Refund fails after payout:** a question for StreamPay; #13's retry covers it.
- **25. Partial refund counted as full:** skipped.

## Docs to update
- `docs/PAYMENTS-STATUS.md`:
  - move built items out of limitations;
  - add #5 (issue + both solutions + staff rule), #17, #23, #25;
  - the #26 real-card note;
  - the Azure scheduler note: settle every 5 min, report daily, `LOOKBACK` → 48 h when that goes live, `HEALTHCHECK_URL`;
  - the StreamPay questions list.
- `docs/PAYMENTS-STREAMPAY.md`: flow changes (revive path, unverified → 503, release reasons, overlap constraint).
- `docs/DEPLOYMENT.md`: Azure timers (5 min settle, daily `?report=1`), `HEALTHCHECK_URL`.

## Build order
1. Before go-live, in this order: #8, #9, #24 → #2, #6, #3, #4, #11, #12, #1, #10, overlap migration.
2. Right after: #7, #13, #14, #15, #16, #19, #20.
3. Soon: #18, #21, #22 (after the API check).
4. Docs with each group; one commit per group.

## Verification
- **Tests.** Add to `tests/streampay.test.ts` / `tests/concurrency.test.ts`. Each uses the fake driver with a controllable verdict, which already exists for these suites:
  - verify throws → webhook 503, status "pending";
  - unknown status → pending + alert;
  - failed row later paid → revived and confirmed, or refunded if the hold is gone or the time has started;
  - an expired hold with a paid payment is not swept (#4);
  - confirm on a paid party returns tickets (#24);
  - release refused while paying (#2);
  - return route rejects `%09/evil.com` and `//evil.com` (#8);
  - two gift card intents with different `attemptId` never share a ref (#9);
  - a treat after the visit ended is refunded (#12);
  - points spent from two concurrent bookings → one refused (#16);
  - two overlapping bookings on one chair are refused by the DB (overlap rule);
  - the gift card limit returns 429 on the 6th attempt (#1).
- **Checks.** `npx tsc --noEmit`, `npm test`, `next build`.
- **Sandbox** (ngrok, as before):
  - pay, press Back from the OTP → ticket shown, no second charge (#2);
  - kill the webhook by stopping the server mid-payment → confirmed by the settle job;
  - block StreamPay (bad key) during polling → "don't pay again" message + one owner email (#7).
- **Before applying the migration:** run the overlap check query on staging.
