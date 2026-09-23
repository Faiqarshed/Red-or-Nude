# Payments — StreamPay

How money is taken, what StreamPay is sent, and how to test and go live.
What is deliberately *not* done yet is in [PAYMENTS-STATUS.md](PAYMENTS-STATUS.md).

Driver switch: `PAYMENT_DRIVER=streampay`. Anything else uses
[`lib/payments/fake.ts`](../lib/payments/fake.ts), which approves everything —
dev, tests, and nothing public.

---

## 1. The one rule

**We price, StreamPay collects.** Every total and every discount is worked out
by our own engine ([`lib/bookings.ts`](../lib/bookings.ts)) and sent to StreamPay as
real products plus **fixed-amount** coupons. StreamPay never computes a
percentage for us, so its total can only ever be ours.

After creating a payment link we compare `link.amount_in_smallest_unit` with our
total. If they differ, the link is deactivated and the attempt fails — nobody is
ever charged a number the screen didn't show.

## 2. What each thing on the bill becomes

| Ours | StreamPay | Key in `streampay_ids` |
|---|---|---|
| Service | product × qty | `product:service:<id>` |
| Refill (flat price) | its own product per service, "… — Refill" | `product:refill:<serviceId>` |
| Add-on, treat | product | `product:addon:<id>` |
| Removal | product | `product:removal:<id>` |
| Membership pack | product | `product:pack:<id>` |
| Gift card | one product per amount ("Gift card 300 SAR" × 1), VAT-exempt | `product:giftcard:<SAR>` |
| Service covered by pack credit | left off (products must be ≥ 1 SAR) | — |
| Group discount | fixed coupon "Group discount −X" | `coupon:Group discount:<halalas>` |
| Promo code | fixed coupon "`CODE` −X" | `coupon:<CODE>:<halalas>` |
| Loyalty points | fixed coupon "Loyalty points −X" | `coupon:Loyalty points:<halalas>` |
| Total = 0 | never reaches StreamPay | — |

- Products are made **once per catalogue item**, when the admin saves it (and
  again at checkout if missing or out of date). A price change archives the old
  StreamPay price and makes a new one.
- Coupons are made the first time a label + amount pair is seen, then reused.
- Promo rules (dates, max uses, minimum spend) stay entirely in our app — StreamPay
  coupons have none of those fields.
- Prices are VAT-inclusive on both sides.
- The customer is a StreamPay *consumer* keyed by phone (else email), so the
  checkout doesn't ask for her details again.

The receipt is built by [`lib/payments/lines.ts`](../lib/payments/lines.ts) from the
snapshots on the booking rows, including `promo_discount_halalas` and
`points_discount_halalas`. The group share is `discount − promo − points`.

## 3. The flow

```
POST /api/bookings            chair held, status = pending
POST /api/payments/confirm    pending payments rows claim the party (double-tap guard)
     │                        → StreamPay payment link, valid 10 min (PAY_WINDOW_MIN)
     ▼
components/StreamPayCheckout  Embed SDK renders the link in an iframe on our page
     │  she pays (3-D Secure inside it)
     ▼
/api/payments/return?ref=…    StreamPay's redirect lands here, inside the iframe
     │  settles server-side (full-window: back to the page with ?paid=ref)
     ▼
GET /api/payments/status      polled by the page every 3 s → tickets / gift code / pack
                                        ┌── POST /api/payments/streampay/webhook
 (she closed the tab)  ─────────────────┤   signature-checked, same settle
                                        └── GET /api/cron/settle-pending
 (the webhook missed too)                   every 2 days (vercel.json); asks
                                            StreamPay about every checkout older
                                            than PAY_WINDOW_MIN
```

**The settle job** ([`reconcile.ts`](../lib/payments/reconcile.ts)) is the net under
the webhook, which StreamPay stops retrying after five failures. Each run settles
up to 50 unanswered checkouts from the last 7 days through the same
`settlePayment`, least recently asked first, refunds paid purchases that
delivered nothing, and mails `PAYMENTS_ALERT_EMAIL` anything left for a person.
It runs every two days — see [PAYMENTS-STATUS.md](PAYMENTS-STATUS.md) for why that
is a compromise.

**Settle** ([`confirm.ts`](../lib/payments/confirm.ts) `settleBookingPayment`,
[`purchase.ts`](../lib/payments/purchase.ts) `settlePurchase`) is the only place a
payment is accepted. It:

- asks StreamPay (`GET /invoices?payment_link_id=…&include_payments=true`) — never
  trusts a URL param or a webhook body;
- claims the rows `pending → paid` atomically, so the return page, the status poll
  and the webhook can all arrive, and exactly one confirms;
- checks the paid amount equals the bill.

Gift cards, packs and chair treats store what is being bought in
`payments.raw.intent` *before* the charge and are delivered in settle. If delivery
fails after payment (a second tap already added that treat), the money is refunded
on the spot.

**Late payment.** The hold sweeper spares a booking with a checkout younger than
`PAY_WINDOW_MIN`. If money still arrives for a hold that is gone, settle refunds it
in full automatically and logs `late payment auto-refunded`.

**Refunds** go through `POST /payments/{payment_id}/refund`; the StreamPay
payment id is kept on `payments.raw.paymentId` when the payment settles. Every
refund first asks `GET /payments/{payment_id}` how much has already gone back,
so a retry, or a refund someone made in the dashboard, is recorded instead of
sent twice. The refund reply has no status field: a 2xx is the refund.

**Webhook events** (register these four): `PAYMENT_SUCCEEDED` and
`PAYMENT_MARKED_AS_PAID` settle the payment; `PAYMENT_REFUNDED` records a refund
made outside the app and freezes the gift card it bought;
`PAYMENT_PARTIALLY_REFUNDED` alerts the owner. When StreamPay cannot answer our
"was it paid?", the webhook replies 503 so it is sent again.

**Written-off payments.** A payment marked failed is asked about again (about
15 min, 1 h, 6 h, 24 h, 47 h), and at once on a success webhook: money that
landed after its link expired is confirmed or refunded, never lost. Details and
the reasons for each rule: [PAYMENT-HARDENING-PLAN.md](PAYMENT-HARDENING-PLAN.md).

## 4. Environment

```
PAYMENT_DRIVER=streampay
STREAMPAY_API_KEY=…            # app.streampay.sa → Settings → API keys
STREAMPAY_API_SECRET=…         # the code sends base64(key:secret) as x-api-key
STREAMPAY_WEBHOOK_SECRET=…     # shown when the webhook is registered
STREAMPAY_BASE_URL=https://stream-app-service.streampay.sa
SITE_URL=https://…             # redirect URLs are built from this
PAYMENTS_ALERT_EMAIL=…         # "payments need attention" mail, each settle-job run
```

Production refuses every payment unless `PAYMENT_DRIVER` is `streampay`, or
`fake` for a staff-only deploy — a forgotten variable must not make bookings free.

The settle job needs `CRON_SECRET` in Vercel (Vercel sends it on every cron call).

Test and live keys use the same base URL; the key decides which.

## 5. Testing against the sandbox

1. Test keys in `.env.local`, `PAYMENT_DRIVER=streampay`, `npm run db:migrate`.
2. `npm run streampay:sync` — pushes the catalogue; check the products in their
   dashboard.
3. Expose the dev server (`cloudflared tunnel --url http://localhost:3000` or
   ngrok), set `SITE_URL` to that URL, and register
   `<SITE_URL>/api/payments/streampay/webhook` in the StreamPay dashboard for
   `PAYMENT_SUCCEEDED`.
4. Test cards (their docs reuse Moyasar's): mada `4201320111111010` approves,
   `4201320000311101` declines (insufficient funds); Visa `4111111111111111`
   approves. Any two-word name, future expiry, any CVC.

Walk these:

| Case | Expect |
|---|---|
| One guest + promo + points | Invoice lists the service and two named coupons; total = screen |
| Group of 3 | One link, services aggregated by quantity, a "Group discount" coupon |
| Declined card, then Pay again | Same checkout resumes; a good card then confirms |
| Pay, close the tab before the return page | Webhook confirms; the ticket is in /my-bookings |
| Let the hold lapse mid-checkout, then pay | Auto-refund; log line says so |
| Gift card 75 SAR | Code issued after payment; line is 75 × 1 SAR, VAT-exempt |
| Membership, chair-QR treat | Delivered after payment |
| Customer cancels inside the window | Refund appears in StreamPay |
| Apple Pay on Safari | Works once StreamPay has registered the domain |

`npm test` covers the parts that need no network: receipt arithmetic, webhook
signatures, concurrent settles, late-payment refunds ([`tests/streampay.test.ts`](../tests/streampay.test.ts)).

## 6. Going live

- Live keys and webhook secret in production env; webhook registered against the
  production `SITE_URL`.
- `npm run streampay:sync` against production.
- In the StreamPay dashboard: cards + Apple Pay on; Tamara, installments, Amex off
  (links send `payment_methods: null`, so the dashboard decides).
- Apple Pay: `public/.well-known/apple-developer-merchantid-domain-association`
  is StreamPay's file, served as is. Ask their support to register the production
  domain in their payment gateway.
- Set `PAYMENTS_ALERT_EMAIL`; the report is the list of what needs a person.

## 7. Files

| File | Role |
|---|---|
| `lib/payments/index.ts` | Driver seam, `PAY_WINDOW_MIN` |
| `lib/payments/streampay.ts` | API client, product/coupon/consumer sync, driver, webhook signature |
| `lib/payments/fake.ts` | Stand-in driver |
| `lib/payments/lines.ts` | Booking → receipt lines + discounts |
| `lib/payments/confirm.ts` | Booking start + settle |
| `lib/payments/purchase.ts` | Gift card / pack / treat start + settle |
| `lib/payments/settle.ts` | One entry point by ref |
| `lib/payments/refund.ts` | Refunds, and the "you were refunded" email for automatic ones |
| `lib/payments/reconcile.ts` | Settle job + problem report |
| `app/api/cron/settle-pending` | Its endpoint, scheduled in `vercel.json` |
| `app/api/payments/{confirm,status,streampay/webhook}` | Routes |
| `app/api/payments/return` | Where StreamPay redirects |
| `components/StreamPayCheckout.tsx` | The embed + status polling |
| `scripts/streampay-sync.ts` | Catalogue backfill |
