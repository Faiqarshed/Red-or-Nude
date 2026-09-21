# Payments — where things stand

What works, what doesn't yet, and what still has to be done before customers pay
real money. How the integration works is in
[PAYMENTS-STREAMPAY.md](PAYMENTS-STREAMPAY.md); this file is the honest status.

**Verdict today:** ready for staging with sandbox keys. Not ready for production
until the "Before go-live" list below is done — in particular the webhook
registered and tested, and a decision on how often the settle job runs.

---

## 1. What works

Each of these is built and covered by `npm test` (`tests/streampay.test.ts` plus
the booking suites) unless it says otherwise.

**Taking money**

- Bookings, gift cards, membership packs and chair-QR treats are all paid through
  StreamPay's embedded checkout. The card number never touches our servers.
- **We price, StreamPay collects.** Every discount (group, promo code, loyalty
  points) is worked out by us and sent as a fixed-amount coupon. Our total is
  checked before the payment link is created, and StreamPay's link total is
  checked after; if they differ the link is cancelled and nobody is charged.
- A bill of zero (a pack credit or a 100% code covering everything) never
  reaches StreamPay.

**Never charging twice, never confirming twice**

- One live payment per booking is enforced by the database
  (`payments_booking_live_unique`), and each payment link accepts one payment.
- Pressing Pay again, reloading, or opening a second tab resumes the same
  checkout instead of opening a new one.
- The return page, the status poll, the webhook and the settle job can all
  arrive for the same payment at the same moment; exactly one confirms. Tested
  with concurrent settles.
- A payment is only ever accepted after asking StreamPay directly. A URL
  parameter or a webhook body is never trusted.
- The amount actually paid is checked against the bill before anything is
  confirmed or delivered.

**When something goes wrong**

- **Declined card:** the checkout stays open for another card; the chair stays
  held for the rest of the hold window.
- **3-D Secure still processing:** counted as pending, not failed.
- **She paid after her hold expired:** refunded automatically, and she is
  emailed that it was refunded.
- **Paid for a gift card / pack / treat that could not be delivered** (a second
  tap already added that treat, a pack withdrawn mid-checkout): refunded on the
  spot, and emailed.
- **Gift card or pack delivery crashed halfway:** the card/pack and its link to
  the payment are saved in one transaction, so it is either fully delivered or
  not at all — never "refunded but the card still works".
- **The page asks while delivery is still running:** it is told "still
  processing" for up to two minutes instead of a false "not delivered".
- **She paid and closed the tab, and the webhook never came:** the settle job
  finds it (see §3).
- **A refund that fails, or money we hold for nothing:** listed in the report
  email to `PAYMENTS_ALERT_EMAIL`, instead of only a log line.

**Configuration safety**

- In production, payments are refused unless `PAYMENT_DRIVER` is set to
  `streampay` (or `fake` on purpose for a staff-only deploy). A forgotten
  variable can no longer make every booking free.
- The webhook is signature-checked (HMAC, 5-minute replay window) and the return
  page only redirects to paths on our own site.

---

## 2. Limitations — what does not work yet

**Money the customer can lose, by design, until a decision is made**

- **The salon cancels a paid booking → no money goes back.** Pack credits come
  back, cash does not (`app/(admin)/admin/(shell)/bookings/actions.ts`
  `updateBookingStatus`). Until the refund policy is decided, staff must refund
  these by hand in the StreamPay dashboard. One
  `refundBookings(ids, "salon-cancelled")` call once decided.
- **Chair-QR treats are never refunded** when their booking is cancelled —
  `refundBookings` matches `payments.booking_id`, and treats sit on
  `treat_booking_id`. Widen the match when the policy is decided.
- **No-shows** move no money.

**Things that are handled, but not the ideal way**

- **Late payment = refund, not the booking.** If she pays after her hold was
  released, she gets her money back rather than her chair. Deliberate: holding
  every abandoned checkout's chair until the settle job answers would block slots
  for other customers.
- **Amount mismatch** (paid ≠ bill) is not refunded automatically, because there
  is no right number to refund. It is logged `REFUND OWED` and appears in the
  report. Should never happen: the link total is checked when it is created.
- **Partly refunded from StreamPay's dashboard before we settle** still confirms
  the booking / delivers the purchase (failing it would keep the rest of her
  money for nothing). Fully refunded counts as unpaid.
- **Two tabs buying the same gift card / pack at the same instant** can each open
  a checkout. It takes two pages and two separate payments; the result is two of
  the thing, refundable. Closing it fully is a partial unique index on pending
  purchase intents — left out as more than the risk.
- **Promo `max_uses` race** — two holds can both pass the last use
  (`lib/promo.ts`). Not new.

**Not built**

- **Paying with a gift card at checkout.** A gift card is a payment method, not a
  discount; sending it as a coupon would likely under-report VAT. Needs the
  accountant's answer on gift-card VAT first.
- **Walk-ins and pay-at-desk.** Walk-ins are confirmed with no `payments` row, so
  the day's takings miss them and they earn no loyalty points.
- **An admin payments screen.** The `payments.view` / `payments.refund`
  permissions exist and nothing checks them. StreamPay's dashboard covers refunds
  and lookups meanwhile; the report email covers "what needs attention".
- **Station-treat revenue** is not in the dashboard totals, which read
  `bookings.total_halalas` (`dashboard-data.ts`).
- **A minimum price on catalogue items.** StreamPay products must be at least
  1 SAR; an item priced between 0 and 1 SAR would fail at checkout. Unrealistic,
  so no admin rule was added.

---

## 3. The settle job runs every 2 days — and that is a compromise

**Why it exists.** A payment is normally confirmed by one of three things: our
return page, the page polling us every 3 seconds, or StreamPay's webhook. On a
phone the bank's OTP step often switches to the banking app, and the browser can
kill our tab. If the webhook also fails — StreamPay gives up after 5 attempts —
nothing else would ever ask about that payment, and the customer would have paid
for a booking we already released. `GET /api/cron/settle-pending`
(`lib/payments/reconcile.ts`) is the net: it asks StreamPay about every checkout
nobody came back for, refunds what needs refunding, and emails the problem list.

**What we chose.** It runs from `vercel.json` every 2 days (`0 5 */2 * *`, UTC),
because the Vercel Hobby plan only allows cron jobs once a day at most, and we
are not adding a second scheduler. To make a 2-day gap safe it looks back 7 days,
handles up to 50 checkouts per run (least recently checked first, so nothing is
starved), and keeps retrying a failed refund for up to 7 days.

**What that costs.** Only customers whose payment was missed by the return page,
the poll *and* the webhook are affected — rare once the webhook is registered
and tested. But for those customers:

- She can wait **up to 2 days** for her refund (plus the bank's 5–14 working days
  for it to reach her card). Her booking is already cancelled after 10 minutes,
  so for those 2 days she has paid and has nothing. That is the window in which
  she calls the salon or disputes the charge with her bank — a dispute costs the
  salon a fee even if it is resolved.
- Problems (refunds owed, stuck payments) are only emailed every 2 days, not daily.
- If more than ~50 checkouts are abandoned in 2 days, the backlog takes more
  than one run to clear.

**Payments are the most critical path in the app; 2 days is not where this
should stay.** Recommended, in order of preference:

1. **Vercel Pro** (also required anyway: the Hobby plan is for non-commercial
   use only, and a salon taking payments is commercial). Change the schedule to
   `*/5 * * * *` and add a daily `?report=1` entry. Nothing else changes.
2. If staying on Hobby: point a free external scheduler (cron-job.org, or a
   GitHub Actions `schedule:` workflow) at the same endpoint every 5–15 minutes,
   with `Authorization: Bearer <CRON_SECRET>`. It is idempotent, so running it
   from two places is harmless.

Until then, anyone can run it by hand at any time:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/settle-pending?report=1
```

---

## 4. Before go-live

The code is done; these are the steps only people with access can do.

**StreamPay account holder** (login to app.streampay.sa):

1. Settings → Webhooks → add `https://<domain>/api/payments/streampay/webhook`
   for `PAYMENT_SUCCEEDED`, and copy the signing secret it shows. There is no API
   for this. **Until it exists, the settle job is the only thing that catches a
   customer who closed her tab — see §3.**
2. Payment methods: cards (mada, Visa, Mastercard) and Apple Pay on; Tamara,
   installments and Amex off. Links send `payment_methods: null`, so the
   dashboard decides.
3. Apple Pay: ask StreamPay support to register the staging, and later the
   production, domain. The domain file is already served at
   `/.well-known/apple-developer-merchantid-domain-association`.
4. Sandbox keys on staging; live keys only at go-live.
5. Check the webhook delivery log in their dashboard now and then — failed
   deliveries show there.

**Deploy person** (Vercel + the database):

1. Vercel env vars: `PAYMENT_DRIVER=streampay` (production refuses payments
   without it), `STREAMPAY_API_KEY`, `STREAMPAY_API_SECRET`,
   `STREAMPAY_WEBHOOK_SECRET` (from step 1 above),
   `STREAMPAY_BASE_URL=https://stream-app-service.streampay.sa`,
   `SITE_URL=https://<domain>`, `PAYMENTS_ALERT_EMAIL` (who gets the problem
   report), and `CRON_SECRET` if it is not already set (the other crons use it
   too; Vercel sends it on every cron call). Redeploy after.
2. `npm run db:migrate` — migration `0027_streampay` (one table, two columns with
   defaults; no data changes). Must run before the first checkout, or every
   checkout fails.
3. `npm run streampay:sync` once — pushes the catalogue to StreamPay. Optional
   (checkout creates missing products), but makes the first payments faster.
4. After deploy, check Vercel → Crons lists `settle-pending?report=1`, and run it
   once by hand (the curl above) — expect `{"ok":true,...}`; a 401 means
   `CRON_SECRET` is wrong.
5. Smoke test: one booking paid with mada `4201320111111010`, then walk the table
   in [PAYMENTS-STREAMPAY.md §5](PAYMENTS-STREAMPAY.md). Must include: **pay, then
   close the tab immediately** — the booking must be confirmed by the webhook.

**Decisions** (the salon / accountant):

1. **Refund policy** for salon cancellations, chair treats and no-shows (§2).
2. **Gift-card VAT** — the sale is sent to StreamPay as VAT-exempt (a voucher is
   usually taxed when spent). To flip: `vatExempt` on the gift-card line in
   `app/api/gift-cards/route.ts`, then re-run `npm run streampay:sync`.
3. **Vercel Pro**, and with it the settle job every 5 minutes (§3).

---

## 5. To check in the sandbox

Things StreamPay's docs do not state and the code guesses at, defensively:

- The webhook signature's encoding (hex vs base64) and timestamp unit (s vs ms) —
  both are accepted. **If the guess is wrong every webhook is refused with a 401**,
  so this must be proven before go-live.
- That `custom_metadata` comes back as `data.metadata` on the webhook (there is a
  fallback lookup by payment-link id).
- That the embed's redirect lands inside the iframe rather than the top window
  (both are handled).
- mada with OTP inside the embedded checkout on iOS Safari, and on Android when
  it switches to the banking app.
- Whether a link whose total after coupons is very small (e.g. under 1 SAR) is
  accepted.
