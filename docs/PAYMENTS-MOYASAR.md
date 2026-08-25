# Payments — brief §2.13, on Moyasar

What the gateway integration has to do, what the provider actually gives us, and
the order the work lands in.

Nothing here is built yet. This is the plan, written after reading Moyasar's
docs, so that the seam gets reshaped once rather than twice.

The provider is decided: **Moyasar**. The client's reason, verbatim — *"Moyasar
is the one platform that gives all the payment solutions at one place."* That
settles the open question in `docs/ADMIN-PANEL.md` §9 and `docs/BOOKING-V2.md`
§5, both of which still say Moyasar vs Tap is undecided.

---

## 1. Where we are today

Everything around the money is real. The money is not.

```
   POST /api/bookings          chairs LOCKED, rows written status = "pending"
        ▼
   POST /api/payments/confirm  lib/payments/confirm.ts
        │   writes `payments` rows, one per booking, sharing a providerRef
        │   calls driver.charge(...)  ← lib/payments/fake.ts, always "paid"
        │   flips bookings to confirmed, allocates ticket numbers
        └── invoice email, promo redemption counted
```

The pending/confirmed state machine, the group bill, ticket allocation, hold
sweeping, the invoice and the `refunds` table all exist and work. `fake.ts`
approves everything, which is why `docs/DEPLOYMENT.md` §0 says deploying with it
means customers book for free.

Three call sites touch the gateway. That is the entire blast radius:

| Call site | What it does |
|---|---|
| [`lib/payments/confirm.ts:84`](../lib/payments/confirm.ts) | charges a booking or group |
| [`app/api/gift-cards/route.ts:87`](../app/api/gift-cards/route.ts) | charges a gift card purchase |
| [`lib/payments/refund.ts:62`](../lib/payments/refund.ts) | refunds a cancellation |

---

## 2. Why this is not the one-file swap the docs promise

`docs/BOOKING-V2.md` §5 says: write one driver, flip `PAYMENT_DRIVER`, done. That
holds only because `charge()` is shaped as a function that returns a verdict
immediately, which `fake.ts` can do and a real gateway cannot.

Cards in Saudi go through 3-D Secure. The gateway's answer to "charge this card"
is not *paid* — it is `initiated`, plus a URL to send the customer to. They leave
for their bank's OTP page and come back some unknown number of seconds later, if
they come back at all.

So the shape of the seam is wrong, and that — not the driver file, which is small
— is the work of §2.13.

---

## 3. What Moyasar actually gives us

Read from the docs, not assumed. Links in §8.

**Auth.** `https://api.moyasar.com/v1/`, HTTP Basic, API key as the username and
an empty password. `pk_…` can perform exactly one operation, Create Payment, so
it is safe in the browser. `sk_…` does everything and is backend-only. Test keys
are prefixed `pk_test_` / `sk_test_`; live keys appear once the account is
activated.

**Amounts** are in the smallest currency unit. We store halalas. No conversion.

**The embedded form** (Moyasar.js) renders card, mada, STC Pay and Apple Pay from
one `Moyasar.init(...)` — `methods: ['creditcard', 'stcpay', 'applepay']`. STC
Pay's OTP round-trip is handled inside the form and lands on the same callback as
a card. There is no separate flow to build for it.

**`on_completed`** fires with the created payment *before* the browser leaves for
3DS. The docs call saving the id there "highly recommended", for exactly the
reason we care about: a dropped connection mid-redirect.

**The callback** is `callback_url?id=…&status=…&message=…`.

**Verification** is `GET /v1/payments/:id` with the secret key, then check
`status`, `amount` and `currency` before accepting the order. This is the
documented step, not our invention.

**`metadata`** is arbitrary key-value, echoed back in API responses *and* in
webhook messages. That is our link from their payment to our `providerRef`.

**Webhooks** POST a body containing `type` (`payment_paid`, `payment_failed`,
`payment_refunded`, …), `live`, `data` (the payment object), and `secret_token` —
a value we set, echoed back. Retries are 6 attempts: immediate, 1m, 10m, 30m, 1h,
2h, then dropped. Endpoints are told to return 2xx quickly.

**Refunds** are `POST /v1/payments/:id/refund` with an optional `amount` for a
partial. **Synchronous** — the response is the updated payment with status
`refunded`.

**Test cards** exist for every scheme, mada included (`4201320111111010` is the
approved one), with distinct numbers for insufficient funds, lost, stolen and
expired declines. Any two-word name, any future expiry, any 3-digit CVC.

### Two things the docs don't answer

1. **Do test keys need account activation?** The page only says live keys appear
   after activation. Ten minutes of signing up settles it; don't plan around an
   assumption either way.
2. **Apple Pay's prerequisites.** The config carries a `validate_merchant_url`
   pointing at Moyasar's own servers, which suggests they own merchant validation
   and we need no Apple Developer account of our own. Their separate "Apple
   Developer Account" guide is unread. Open, not confirmed as a blocker.

---

## 4. The flow we're building

Embedded form, not the hosted invoice page. The hosted page is fewer lines but
throws away the Figma payment step; embedded keeps our screen and still gives us
all four methods from one integration, which is the thing the client is buying.

```
   server computes the amount, hands the form its config
        │   metadata: { ref }   ← our existing payments.providerRef uuid
        ▼
   Moyasar.js creates the payment with pk_
        │
        ├── on_completed(payment) → POST /api/payments/attach
        │        writes their `id` onto our pending rows.  Fast path.
        ▼
   3-D Secure at the customer's bank
        ▼
   GET /api/payments/callback?id=…
        │   GET /v1/payments/:id with sk_
        │   verify status + amount + currency against our DB
        └── settle
                                        ┌── POST /api/payments/webhook
   (customer closed the tab)  ──────────┘    same payment, our ref in metadata
                                             same settle
```

`metadata` is the safety net: even if `on_completed` never fires, the webhook
alone can find our rows. **Settle must be idempotent** — it will genuinely run
twice, once from the browser and once from the webhook, and whichever loses does
nothing.

### The amount is a trust boundary

The publishable key can create a payment for any amount, from the browser. A
customer can pay 1 SAR for a 400 SAR booking. The server-side comparison against
the booking total on settle is the only thing that catches it. It is not
optional and it does not get simplified away.

### The webhook needs no queue

Six retries over three hours covers a handler that times out. Do the work, return
200. Adding a queue for this would be building infrastructure to solve a problem
the provider already solved.

---

## 5. The work, in order

**1. Test keys.** Sign up, find out what a bare account gets. Unblocks everything
below and answers §3's first open question.

**2. Make "pending" a legal answer.** `ChargeResult` in
[`lib/payments/index.ts`](../lib/payments/index.ts) gains `status: "pending"` and
somewhere to carry the handoff; `PaymentDriver` gains `verify(providerId)`. That
is the whole interface change.

**3. Split [`confirm.ts`](../lib/payments/confirm.ts).**
   - `startBookingPayment()` — resolve the group, write the `payments` rows
     pending with our `ref`, return what the form needs. Everything up to today's
     line 84, minus the charge.
   - `settleBookingPayment(providerId)` — fetch from Moyasar, verify, then run
     the existing transaction *unchanged*: mark paid, `allocateTickets`, flip to
     confirmed, invoice, count the promo. Idempotent.

**4. `app/api/payments/attach/route.ts`.** Records their payment id against our
pending rows from `on_completed`.

**5. `app/api/payments/callback/route.ts`.** Where the bank sends the customer
back. Calls settle, redirects to the success screen. **Ignores the `status` query
param entirely** — that came from a URL; we ask Moyasar directly.

**6. `app/api/payments/webhook/route.ts`.** Check `secret_token`, same settle,
return 2xx. This is what saves the customer who closed the tab. Without it they
have paid for a hold that gets swept.

**7. Guard the sweeper.** [`lib/bookings.ts:336`](../lib/bookings.ts) cancels any
pending booking older than `booking_hold_min` (15). Safe today because a fake
charge takes a millisecond; fatal once a customer can sit on an OTP page for five
minutes. Add "and has no pending payment row" — one `AND NOT EXISTS`. Without it
we take the money and give the chair away.

**8. Gift cards.** Same two-phase treatment in
[`app/api/gift-cards/route.ts`](../app/api/gift-cards/route.ts) — same settle
shape, different tail (issue the card instead of the ticket).

**9. The form.** Moyasar.js mounts inside
[`components/PaymentMethods.tsx`](../components/PaymentMethods.tsx). Our method
picker chrome stays; the card inputs inside it are replaced by theirs, so the PAN
never reaches our origin and we stay out of PCI scope — which
[`lib/card.ts`](../lib/card.ts) already says out loud. Most of that file is then
deletable. (It also has a dead branch today: `brandOf()` never returns `"mada"`
though `CardBrand` declares it.)

**10. Refunds.** [`refund.ts`](../lib/payments/refund.ts) calls their endpoint
instead of the fake. Because refunds are synchronous, this is a genuine swap —
its "never throws, log loudly, admin settles by hand" contract is correct and
stays exactly as written.

**11. Apple Pay.** Last, and possibly not a blocker at all — see §3. The site can
go live on card, mada and STC Pay while it is settled.

---

## 6. What blocks on the client

Only live keys, and Apple Pay if it turns out to need anything of ours. Live keys
need account activation: expect CR, IBAN, VAT certificate, owner ID, and a live
site with visible pricing, terms and a **refund policy** — gateways reject sites
without one, and we don't have those pages. Flag it now; it is weeks, and it is
theirs to drive, not ours.

Steps 2–10 are buildable on test keys. If even those stall, teach
[`fake.ts`](../lib/payments/fake.ts) to answer `pending` and bounce through a
stub page — the entire async flow is then exercisable with no gateway at all,
and that stub stays useful afterwards for local dev and tests.

---

## 7. Environment

```
PAYMENT_DRIVER=moyasar
MOYASAR_PUBLISHABLE_KEY=pk_test_…    # browser, Create Payment only
MOYASAR_SECRET_KEY=sk_test_…         # server only, never NEXT_PUBLIC_
MOYASAR_WEBHOOK_SECRET=…             # the secret_token we set and they echo
```

`getDriver()` branches on `PAYMENT_DRIVER` and returns `fakeDriver` for anything
else, so an unset environment stays safe-by-default in dev — and lethal in
production, which is why `docs/DEPLOYMENT.md` §0 exists.

---

## 8. Sources

- [Authentication](https://docs.moyasar.com/api/authentication)
- [Create Payment](https://docs.moyasar.com/api/payments/01-create-payment/)
- [Fetch Payment](https://docs.moyasar.com/api/payments/02-fetch-payment/)
- [Refund Payment](https://docs.moyasar.com/api/payments/05-refund-payment/)
- [Webhook Reference](https://docs.moyasar.com/api/other/webhooks/webhook-reference/)
- [Card Payments — basic integration](https://docs.moyasar.com/guides/card-payments/basic-integration)
- [Test Cards](https://docs.moyasar.com/guides/card-payments/test-cards)
- [STC Pay](https://docs.moyasar.com/guides/stc-pay/basic-integration)
- [Apple Pay](https://docs.moyasar.com/guides/apple-pay/basic-integration)
- [Get your API keys](https://docs.moyasar.com/guides/dashboard/get-your-api-keys)

Read August 2026. Verify §3 against the live docs before writing step 2 if this
sits for a while.
