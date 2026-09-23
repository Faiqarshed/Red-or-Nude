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

**Added by the hardening work** (docs/PAYMENT-HARDENING-PLAN.md; tests in
`tests/payment-hardening.test.ts`)

- **StreamPay not answering** is "still pending", never "failed". The page keeps
  checking and ends on "don't pay again"; the webhook answers 503 so StreamPay
  resends it. Five failed calls in a row email the owner once, and again when
  StreamPay is back.
- **Money on a payment we had marked failed** (its link expired while she was on
  her bank's page, or a status we did not know) is found: the settle job asks
  again at about 15 min, 1 h, 6 h, 24 h and 47 h, and a success webhook for it
  asks at once. It is confirmed or delivered if that is still possible, refunded
  otherwise, and the owner is told. A StreamPay status we do not know counts as
  still processing, with an alert; a `COMPLETED` link never counts as failed.
- **Refunds are safe to retry.** Before refunding, we ask StreamPay how much has
  already gone back. That also fixes a real bug: StreamPay's refund reply has no
  status field, and the old code read one, so every real refund would have been
  logged as failed.
- **Refunds made outside the app** (StreamPay's dashboard): the
  `PAYMENT_REFUNDED` webhook records them and freezes the gift card they bought;
  the owner is emailed to sort out a booking or membership.
  `PAYMENT_PARTIALLY_REFUNDED` emails the owner only.
- **Back from the bank's page, a dropped connection, a reload:** the checkout
  finds the hold she is paying for or has paid, and shows her ticket or reopens
  the same checkout. She is never offered a second Pay for it.
- **A lapsed hold's chair** is asked about before it is released: if she paid in
  the last seconds, she is confirmed instead of refunded. A lapsed hold with no
  checkout no longer shows its slot as taken.
- **Paid late for a time already gone** (a booking whose appointment started, a
  chair purchase after the visit ended): refunded, never confirmed. A chair
  purchase of 10 SAR or less is owed as wallet credit instead; until the wallet
  ships, it is listed in the daily report for the desk.
- **A purchase whose delivery died** is delivered again by the settle job before
  anything is refunded.
- **Gift cards:** each attempt has its own id, so two strangers buying the same
  card can no longer share a checkout. At most 5 new gift card checkouts an hour
  per IP and per buyer email.
- **The same points from two tabs** can only be spent once (checked again under
  the customer lock).
- **Two bookings can never overlap on one chair**: a database rule
  (`bookings_station_no_overlap`, migration 0028), not only the booking code.
- **Checkout countdown** on every payment page; pending bookings show as **Held**
  in admin; leaving the checkout releases the chair at once.

**Configuration safety**

- In production, payments are refused unless `PAYMENT_DRIVER` is set to
  `streampay` (or `fake` on purpose for a staff-only deploy). A forgotten
  variable can no longer make every booking free.
- The webhook is signature-checked (HMAC, 5-minute replay window). The return
  page only redirects to our own checkout pages; "any path on this site" could be
  tricked into another site with a tab character.
- In production, payments are also refused when `SITE_URL` is missing or not
  `https://`, and `STREAMPAY_DEBUG` is ignored (it would log personal data).

---

## 2. Limitations — what does not work yet

**Refund policy: decided Sept 2026, not built yet**

Money goes back to a card only *before* a booking is confirmed. Once it is
confirmed, money never goes back to the card. It becomes wallet credit (like
Foodpanda credits) that she spends on a later booking.

| Case | What happens |
| --- | --- |
| Paid after her hold expired, or paid for something we could not deliver (booking never confirmed) | Card refund, automatic. **Already built, stays as it is.** |
| She cancels, more than 3 h before the appointment | The amount she paid goes to her **wallet**. No card refund. |
| She cancels within 3 h | Not allowed (already enforced, `cancel_cutoff_hours` = 3). |
| The salon cancels, more than 3 h before | Goes to her **wallet**. |
| The salon cancels within 3 h | **Not allowed.** Admin cannot cancel inside the window. |
| She does not come / the salon marks a no-show | She gets **nothing**. |
| The salon reschedules | Up to the salon, and no money moves. Already works. |
| The wallet balance | **Admin cannot edit it.** Only cancellations add to it, and only bookings spend it. |

What the code does today, and what has to change:

- **Her own cancel refunds the card.** `app/api/my-bookings/cancel/route.ts`
  calls `refundBookings(...)`. It must credit the wallet instead. The copy
  "the amount goes back to your card" (`cancelConfirm`, `cancelConfirmGroup`,
  `cancelled`, `cancelledNoRefund` in `lib/dictionary.ts`) changes with it.
- **The salon's cancel moves no money and has no time limit.**
  `updateBookingStatus` in `app/(admin)/admin/(shell)/bookings/actions.ts` must
  refuse a cancel inside `cancel_cutoff_hours` (reuse `cancelRefusal` from
  `lib/cancellation.ts`), and credit the wallet otherwise. Pack credits already
  come back there.
- **There is no money wallet.** The account "wallet" is loyalty points only.
  Needed:
  - a `wallet_txns` ledger (customer, booking, amount, reason), with no admin
    editing;
  - the balance shown on /account;
  - a "Use my credit" option at checkout, sent to StreamPay as a coupon, the same
    way loyalty points are.
  - Credit per cancelled booking = what was paid by card for it + the wallet
    credit spent on it.
  - A guest's credit sits on her customer row, so she can spend it once she
    signs in with that email.
- **No-show gives back spent loyalty points.** The points ledger ignores rows on
  `cancelled` / `no_show` bookings (`isDead` in `lib/rewards.ts`), so points spent
  on a no-show come back. Under "no-show gets nothing" they should not.
- **Unused after the change:** `refundBookings` in `lib/payments/refund.ts`, and
  the `payments.refund` permission (`lib/auth/rbac.ts`). Remove both.
- **Chair-QR treats** are bought during the visit, when the booking can no longer
  be cancelled, so they never need crediting.
- **Ask the accountant:** a cancelled booking already has StreamPay's tax invoice.
  Should the wallet credit get a credit note? And spending it at checkout shows
  as a discount on the next invoice. Is that right for VAT?

**Things that are handled, but not the ideal way**

- **Late payment = refund, not the booking.** If she pays after her hold was
  released, she gets her money back rather than her chair. Deliberate: holding
  every abandoned checkout's chair until the settle job answers would block slots
  for other customers. Before a lapsed hold is released, StreamPay is asked about
  its checkout, so this now only happens when StreamPay could not answer.
- **Some limits are counted per server instance:** the owner-alert "once an
  hour", the StreamPay-down counter, the status-check answer reused for 5 s, and
  the first-line request limits. The gift card limit itself is counted in the
  database. Move them to a table only if several instances make the alerts noisy.
- **Card testing inside one checkout.** Our limit stops new gift card checkouts;
  it cannot see several cards tried inside one StreamPay checkout. Ask StreamPay
  what they limit per link.
- **Amount mismatch** (paid ≠ bill) is not refunded automatically, because there
  is no right number to refund. It is logged `REFUND OWED` and appears in the
  report. Should never happen: the link total is checked when it is created.
- **Partly refunded from StreamPay's dashboard before we settle** still confirms
  the booking / delivers the purchase (failing it would keep the rest of her
  money for nothing). Fully refunded counts as unpaid.
- **Two tabs buying the same pack at the same instant** can each open a
  checkout. It takes two pages and two separate payments; the result is two of
  the thing, refundable. (Gift cards no longer can: each attempt has its own id.)
- **Promo `max_uses` race** — two holds can both pass the last use
  (`lib/promo.ts`). Not new.
- **Gift cards come in the salon's preset amounts only; the custom amount is
  gone.** Each amount is its own StreamPay product, "Gift card 300 SAR" × 1
  (`giftCardLine` in `lib/payments/lines.ts`), made the first time it sells.
  Two other designs were rejected:
  - *A 1 SAR product × the amount* (what shipped first) put "Gift card × 300 @
    1.00" on StreamPay's invoice, which is confusing to a customer or an auditor.
  - *One product whose price is changed per sale* is unsafe: a payment link takes
    only a product id and uses whatever that product's price is at the moment
    the link is made. Two buyers at once would get each other's amount; our
    link-total check would then cancel one checkout.

  A custom amount would work with one product per amount, at the cost of one
  more StreamPay product per distinct amount ever sold. It was removed to keep
  the catalogue to the amounts the salon chose. `POST /api/gift-cards` refuses
  any amount that is not active in `gift_card_values` (`invalid-amount`); new
  amounts are added in /admin/gift-cards. Invoices issued before this change
  keep the old "× amount @ 1.00" lines.

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

**Invoicing: StreamPay's invoice is the only tax invoice**

- Decided Sept 2026. Our email is a booking confirmation (appointment, items,
  discounts, total, "prices include VAT") with a **View your tax invoice** link to
  StreamPay's invoice, whose URL is saved on the payment at settle
  (`payments.raw.invoiceUrl`, `invoiceNo`). Two tax documents for one sale was
  the audit risk, and ours was not ZATCA-compliant (no QR, numbers not
  sequential). StreamPay's totals and VAT matched ours on all 16 booking
  invoices checked, to the halala.
- **No PDF attachment.** StreamPay's API has no invoice PDF endpoint, and its
  public invoice page is a web app. Ask StreamPay support whether a PDF
  endpoint exists, or whether they email the invoice to the customer themselves.
- **Only bookings get our confirmation email.** Gift card buyers get the card
  receipt, and memberships get no email from us, so neither gets the invoice
  link yet. The VAT figures to report come from StreamPay's reports, not our
  database.
- For the accountant: the salon's legal name and VAT number must be set
  correctly on StreamPay's invoices (their dashboard settings).

---

## 4. Before go-live

The code is done; these are the steps only people with access can do.

**StreamPay account holder** (login to app.streampay.sa):

1. Settings → Webhooks → add `https://<domain>/api/payments/streampay/webhook`
   for **`PAYMENT_SUCCEEDED`, `PAYMENT_MARKED_AS_PAID`, `PAYMENT_REFUNDED` and
   `PAYMENT_PARTIALLY_REFUNDED`** (nothing else), and copy the signing secret it
   shows. There is no API for this. **Until it exists, the settle job is the only thing that catches a
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
   `SITE_URL=https://<domain>` (production refuses payments without an https
   one), `PAYMENTS_ALERT_EMAIL` (who gets the problem report and the alerts),
   `HEALTHCHECK_URL` (a healthchecks.io check the settle job pings every run; it
   emails you if the job stops), and `CRON_SECRET` if it is not already set.
   Redeploy after.
2. `npm run db:migrate` — migrations `0027_streampay` (one table, two columns
   with defaults) and `0028_no_chair_overlap` (enables the `btree_gist` extension
   and adds the overlap rule; checked: no existing overlaps on staging). Must
   run before the first checkout.
3. `npm run streampay:sync` once — pushes the catalogue to StreamPay. Optional
   (checkout creates missing products), but makes the first payments faster.
4. After deploy, check Vercel → Crons lists `settle-pending?report=1`, and run it
   once by hand (the curl above) — expect `{"ok":true,...}`; a 401 means
   `CRON_SECRET` is wrong.
5. Smoke test: one booking paid with mada `4201320111111010`, then walk the table
   in [PAYMENTS-STREAMPAY.md §5](PAYMENTS-STREAMPAY.md). Must include: **pay, then
   close the tab immediately** — the booking must be confirmed by the webhook.

**Decisions** (the salon / accountant):

1. ~~Refund policy~~: decided, wallet credit after confirmation (§2). Build it
   before go-live, and ask the accountant the credit-note question.
2. **Gift-card VAT** — the sale is sent to StreamPay as VAT-exempt (a voucher is
   usually taxed when spent). To flip: `vatExempt` on the gift-card line in
   `app/api/gift-cards/route.ts`, then re-run `npm run streampay:sync`.
3. **Production is on Azure.** Its scheduler runs the settle job every 5 minutes
   (`/api/cron/settle-pending`) and the report once a day
   (`/api/cron/settle-pending?report=1`); the look-back (`LOOKBACK` in
   `lib/payments/reconcile.ts`) then drops from 7 days to 48 hours. Vercel stays
   on its 2-day schedule while it is only for testing. **No live money before the
   5-minute schedule runs.**

**How long paying takes** (the senior's question: is a 15-minute hold right?).
Review after the first month of live payments:

```sql
select percentile_cont(0.5) within group (order by updated_at - created_at) as median,
       max(updated_at - created_at) as slowest
from payments where status = 'paid' and booking_id is not null and amount_halalas > 0
  and created_at > now() - interval '30 days';
```

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
- A refund from StreamPay's dashboard sends `PAYMENT_REFUNDED` with our ref in
  `data.metadata` (or the link id), and our record then shows it refunded and
  the gift card frozen.
- A real refund through our code: the reply is recorded as refunded (their
  reply has no status field; the code no longer expects one).
- StreamPay's payment record has a `pdf_link` field (their OpenAPI spec). If it
  is the invoice PDF, it can be attached to the confirmation email.
- **Real bank cards** (needs a real card; the sandbox OTP page is Moyasar's test
  page): one 1 SAR mada payment on live keys, and a card from a second bank if
  possible, landing back on our page.
