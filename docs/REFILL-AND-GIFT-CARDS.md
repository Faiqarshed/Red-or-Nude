# Refill windows and gift cards

Two customer-facing features, plus the seams that let real WhatsApp, email and
payment providers be plugged in later without touching any of this code.

- [Part 1 — Walkthrough](#part-1--walkthrough)
- [Part 2 — Manual testing guide](#part-2--manual-testing-guide)
- [Part 3 — Plugging in the real services](#part-3--plugging-in-the-real-services)

---

## Part 1 — Walkthrough

### 1.1 The refill window

Some services earn a discounted follow-up booking, valid for a fixed number of
days: nails 30, lashes 14. The refill is never in the service catalogue. It
appears only as a button on the customer's own booking, reached with that
booking's reference; it counts down and disappears when the window closes. After that they book the full service.

**Where the window length comes from.** One column, `services.refill_days`
([lib/db/schema.ts](../lib/db/schema.ts)). `0` means the service has no refill at
all. The salon sets it per service in **Admin → Catalog** — 30 on Acrylic, 14 on
Lash Extensions, 0 on a Classic Manicure. There is deliberately no service
category or "refill service" row in the catalogue: the only question anyone asks
is *does it have a refill and for how long*, and a column answers it.

**What a refill costs.** One salon-wide percentage, `refill_discount_percent`
(default 50) in [lib/settings.ts](../lib/settings.ts). Add-ons and removal are
charged in full — they are the same work either way — so only the service line
moves. The chair is held for the same duration as the full service.

**The one rule, in one place.** `refillDaysLeft()` in
[lib/refill.ts](../lib/refill.ts) returns the days remaining, where **0 means no
refill is on offer** — there is no separate eligibility flag to fall out of sync
with the countdown. It is pure, dependency-free, and called by both the screen
and the server:

| Caller | Uses it to |
|---|---|
| [app/api/my-bookings/route.ts](../app/api/my-bookings/route.ts) | decide whether the button renders, and what number is on it |
| [lib/bookings.ts](../lib/bookings.ts) `createBookings()` | decide whether to accept the booking and charge the reduced price |

That is the point: the button can never promise something the API would refuse,
because there is only one copy of the rule.

A booking is eligible when **all** of these hold:

- its service has `refill_days > 0`
- the appointment has happened — `completed`, or `confirmed` with a start time in
  the past (staff do not always press End)
- no refill has been claimed against it already
- it is not itself a refill (a refill does not earn another — otherwise a
  customer would never pay full price again; flip the `isRefill` condition in
  `refillDaysLeft()` if the salon wants them to chain)
- `now <= startsAt + refill_days`

**How a customer reaches their booking.** Customers have no account. The
credential is the booking reference (`RON-4F2K`): generated server-side, shown
once on the success screen, and emailed to the address captured at checkout. Ask
for it at `/my-bookings` and you get **that one booking** back. Because the
reference is the only key, **email is now required at checkout** — that change is
in [app/api/bookings/route.ts](../app/api/bookings/route.ts) and the payment
form. Walk-ins created by staff are unaffected; email stays optional there.

A reference opens the booking it belongs to and nothing else. It originally
resolved the code to a customer and returned their whole history, which meant one
guessed or forwarded reference exposed every appointment that person had ever
made — far more than the holder of a single reference is entitled to, and a much
bigger prize for anyone walking the code space. On a group booking each guest's
row has its own reference, so a code opens that guest's booking rather than both
halves of the bill.

The lookup returns no name, phone or email — the reference proves *someone*
booked, not *who*. Unknown references return `404`, and the route is throttled to
10 attempts per minute per IP.

**Booking a refill.** The button links to `/booking?refill=RON-XXXX`. The page
re-validates the code server-side ([getRefillOffer()](../lib/bookings.ts)) and,
if the offer stands, narrows the catalogue it hands the booking UI down to that
one service at the reduced price. Narrowing the *data* rather than special-casing
the UI means pricing, the summary, add-ons and the slot picker all keep working
untouched — and the customer physically cannot swap the service. An expired,
unknown or already-claimed code silently renders an ordinary booking page.

At checkout the reference travels as `refillOfCode`, and the server re-decides
everything: window, service match, single guest, and the price. Nothing about the
discount is trusted from the browser.

**Two people, one window.** The eligibility read cannot stop two simultaneous
clicks — both see an unspent window. A partial unique index does:

```sql
CREATE UNIQUE INDEX bookings_refill_of_unique ON bookings (refill_of_booking_id)
WHERE status NOT IN ('cancelled', 'no_show');
```

The loser fails the constraint and is reported as `refill-expired` (HTTP 409).
Partial, so a cancelled refill hands the window back.

**Reminders.** [app/api/cron/refill-reminders/route.ts](../app/api/cron/refill-reminders/route.ts)
finds bookings whose window closes in exactly `refill_reminder_days` (default 3)
and messages the customer on both channels. It is guarded by `CRON_SECRET` and is
not scheduled yet — there is no provider to send with, so there is nothing to
schedule. See [Part 3](#34-cron).

### 1.2 Gift cards

Most of this already existed: the `gift_cards` table, the `gift_card_txns`
ledger, `issueGiftCard()`, admin issuing and adjustment, RBAC and audit. Three
things were missing.

**It is now paid for.** `POST /api/gift-cards` used to mint a spendable card to
anyone who could reach the endpoint. It now charges through the same driver a
booking uses and writes a `payments` row carrying `gift_card_id`, so gift-card
revenue lands in the same place as every other sale. Order matters: **charge
first, issue second.** A card issued before a declined charge is free money; a
charge that succeeds and then fails to issue logs `refund owed`, which is the
recoverable direction.

**The occasion is the card design.** `gift_card_designs` already held localized
names and artwork, so Marriage and Graduation were added alongside Birthday,
Anniversary and Congratulations rather than inventing an `occasion` column — from
the customer's side the artwork and the occasion are one choice. The occasion
message is the existing free-text field.

**It is delivered over WhatsApp.** The builder now takes a recipient WhatsApp
number (email still accepted; at least one is required). After payment the
success modal shows a **Send on WhatsApp** button — a plain `wa.me` link carrying
the occasion message and a link to `/gift/<CODE>`, a public page rendering the
card art, the code, the remaining balance and the expiry. No dependency, no API
key, no approved template: it works today and the buyer taps send. The automatic
send goes through the notify seam in parallel and stays silent until a provider
exists.

Denominations are seeded as 100 / 250 / 400 / 500 and stay admin-managed; the
custom-amount box remains, bounded 50–2000 SAR.

### 1.3 The notification seam

[lib/notify/](../lib/notify/) is deliberately the same shape as the existing
payment seam: a `NotifyDriver` interface, a `getDriver()` with one line to
change, and a log-only driver. Every place that should send a message already
calls `notify()`:

| Template | Sent from | Carries |
|---|---|---|
| `booking-confirmed` | [lib/payments/confirm.ts](../lib/payments/confirm.ts) | reference, ticket, station, service, time |
| `gift-card` | [app/api/gift-cards/route.ts](../app/api/gift-cards/route.ts) | code, amount, occasion message, card link |
| `refill-reminder` | [app/api/cron/refill-reminders/route.ts](../app/api/cron/refill-reminders/route.ts) | reference, service, days left |

`notify()` never throws: a paid booking must confirm whether or not a message
provider is having a good day.

### 1.4 Files

**New** — `lib/refill.ts`, `lib/notify/{index,log}.ts`,
`app/api/my-bookings/route.ts`, `app/(site)/my-bookings/*`,
`app/(site)/gift/[code]/*`, `app/api/cron/refill-reminders/route.ts`,
`drizzle/0003_round_vulture.sql`.

**Changed** — schema, settings, `lib/bookings.ts`, `lib/payments/confirm.ts`,
`lib/giftcards.ts`, both booking/gift selections and payment pages, the gift
builder, `GiftCardArt`, admin catalog and bookings screens, both dictionaries,
seed, and `scripts/check-booking.ts`.

---

## Part 2 — Manual testing guide

### 2.0 Setup

```bash
npm install
npm run db:migrate        # adds refill_days, refill_of_booking_id, recipient_phone
npm run db:seed           # only seeds a fresh database
npm run check             # asserts, no browser needed
npm run dev
```

`npm run check` covers the refill window maths — open at both ends, shut one
moment past, the three ways a booking earns no button, lashes' shorter window,
and that the discount always lands on whole halalas. It is the fastest signal
that something has drifted.

> `db:seed` skips the catalogue if branches already exist. On an existing
> database, set the window by hand in **Admin → Catalog** instead (step 2.1).

### 2.1 Give a service a refill window

1. Open `/admin/catalog`, click **Acrylic**.
2. **Refill window (days)** now sits beside Price and Duration. Set it to `30`.
   Save.
3. Confirm a Classic Manicure left at `0` never offers a refill later on.

### 2.2 Book, and get a reference

1. `/booking` → pick a branch, Acrylic, and a slot → Continue.
2. On the payment page, note that **Email is now required** and Confirm stays
   disabled without it. Fill name, phone (`05XXXXXXXX`) and email.
3. Pay. The success modal shows the ticket, the station, and the reference
   (`RON-XXXXX`) with "keep your reference" beneath it. **Copy the reference.**
4. In the terminal you should see:
   `[notify:log] booking-confirmed → email you@example.com` carrying that
   reference. That log line is the email a real provider would send.

### 2.3 Make it refillable

The window counts from the appointment, so a booking made for next week has not
happened yet. Push it into the past and mark it served:

```sql
UPDATE bookings
   SET starts_at = now() - interval '5 days',
       ends_at   = now() - interval '5 days' + interval '90 minutes',
       status    = 'completed'
 WHERE code = 'RON-XXXXX';
```

### 2.4 The refill button

1. `/my-bookings` → enter the reference → **View**.
2. The booking is listed with a **Book refill** button showing the reduced price
   and `25 days left`.
3. Click it. The booking page opens with:
   - a refill banner naming the service and the days remaining,
   - **one** service card, preselected, at half price,
   - add-ons, removal, branch and slot all still available.
4. Pick a slot, continue, pay. The total is the reduced price.
5. Reload `/my-bookings`. **The button is gone** from the original booking, and
   the new refill row shows a *Refill* badge and offers no button of its own.

### 2.5 The edge cases

| What to do | Expected |
|---|---|
| Re-open `/booking?refill=RON-XXXXX` for the used booking | ordinary booking page, all services, no banner |
| `/booking?refill=RON-NOPE9` (made-up) | same — silent fallback, never an error page |
| Set the window to 1 day in admin, back-date the parent 5 days, reload `/my-bookings` | no button |
| Look up a made-up reference | "No booking found with that reference" (404) |
| Submit the lookup 11 times in a minute | "Too many attempts" (429) |
| Check the lookup response in devtools | no name, phone or email in the payload |

Fire two refills at once to prove the database, not the read, decides:

```bash
BODY='{"branchId":"<BRANCH_UUID>","startsAt":"2026-09-01T09:00:00.000Z",
"members":[{"serviceId":"<SERVICE_UUID>","addonIds":[]}],
"customer":{"phone":"0500000001","email":"a@b.com"},"refillOfCode":"RON-XXXXX"}'

curl -s -X POST localhost:3000/api/bookings -H 'Content-Type: application/json' -d "$BODY" &
curl -s -X POST localhost:3000/api/bookings -H 'Content-Type: application/json' -d "$BODY" &
wait
```

Exactly one `201`; the other is `409 {"error":"refill-expired"}`.

### 2.6 The reminder

Back-date a *different* completed booking to exactly `30 - 3 = 27` days ago, then:

```bash
# .env.local needs CRON_SECRET=testsecret
curl -H 'Authorization: Bearer testsecret' localhost:3000/api/cron/refill-reminders
```

`{"scanned":N,"sent":2}` and two `[notify:log] refill-reminder` lines (email and
WhatsApp). Without the header, or with the wrong one: `401`.

### 2.7 Gift cards

1. `/gift-card` — presets read 100 / 250 / 400 / 500, the custom box still works,
   and Marriage and Graduation are among the designs.
2. Fill a recipient WhatsApp number and an occasion message. **Continue to
   Payment** stays disabled until there is a phone or an email.
3. Pay. The success modal shows the code and a green **Send on WhatsApp** button.
4. Click it — WhatsApp opens with the occasion message and a `/gift/CODE` link.
   **Copy link** is the fallback when no number was given.
5. Open the link: card art, code, remaining balance, expiry.
6. In the terminal: `[notify:log] gift-card → whatsapp …`.

Verify the money is real, and that a decline mints nothing:

```sql
SELECT g.code, g.initial_halalas, p.status, p.amount_halalas, p.provider
  FROM gift_cards g LEFT JOIN payments p ON p.gift_card_id = g.id
 ORDER BY g.created_at DESC LIMIT 5;
```

```bash
curl -s -X POST localhost:3000/api/gift-cards -H 'Content-Type: application/json' \
  -d '{"amountSar":500,"method":"card","recipientPhone":"0512345678","simulate":"decline"}'
# → 402 {"error":"payment-declined"} and NO new row in gift_cards
```

Also check: no recipient at all → `400 no-recipient`; `amountSar: 10` → `400`.

### 2.8 Nothing regressed

- A normal solo booking still completes.
- A two-guest group booking still completes at 10% off, two consecutive tickets.
- An admin walk-in still completes **without** an email.
- `/admin/bookings` → open a refill → the drawer shows **Refill of RON-XXXXX**,
  which is how staff know why it was cheaper.

---

## Part 3 — Plugging in the real services

Nothing below changes existing code. Each is a new file plus one line.

### 3.1 WhatsApp

Write a driver next to the log one:

```ts
// lib/notify/whatsapp.ts
import type { NotifyDriver, NotifyMessage, NotifyResult } from "./index";

export const whatsappDriver: NotifyDriver = {
  async send(message: NotifyMessage): Promise<NotifyResult> {
    if (message.channel !== "whatsapp") return { ok: false, error: "wrong-channel" };

    const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: message.to.replace(/\D/g, ""),          // digits, country code, no leading zero
        type: "template",
        template: {
          name: message.template.replace(/-/g, "_"), // booking_confirmed, gift_card, refill_reminder
          language: { code: message.lang === "ar" ? "ar" : "en" },
          components: [{ type: "body", parameters: [/* map message.data */] }],
        },
      }),
    });

    if (!res.ok) console.error(`[notify:whatsapp] http ${res.status}`);
    return { ok: res.ok };
  },
};
```

Then branch in `getDriver()` — the one line in [lib/notify/index.ts](../lib/notify/index.ts):

```ts
function getDriver(): NotifyDriver {
  return process.env.NOTIFY_DRIVER === "whatsapp" ? whatsappDriver : logDriver;
}
```

Env: `NOTIFY_DRIVER=whatsapp`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`.

**The catch that bites people:** WhatsApp does not let you send arbitrary text to
someone who has not messaged you first. Every one of these is a business-initiated
message, so all three need **pre-approved templates** with numbered placeholders,
submitted in the Meta Business Manager (or through Unifonic, which resells the
same thing with a KSA-local contract and its own template console). Approval takes
hours to days. Register the template names to match `NotifyTemplate` and the
mapping above needs no lookup table.

The payloads each template receives:

| Template | `data` fields |
|---|---|
| `booking-confirmed` | `startsAt`, `tickets[]` — each with `code`, `ticketNo`, `station`, `serviceName`, `totalHalalas` |
| `gift-card` | `code`, `amountSar`, `senderName`, `recipientName`, `message`, `cardUrl` |
| `refill-reminder` | `code`, `serviceName`, `daysLeft`, `bookingUrl` |

`cardUrl` and `bookingUrl` are relative — prefix them with the public origin
inside the driver.

None of this affects the **Send on WhatsApp** button on the gift-card success
screen. That is a `wa.me` link sent by the buyer's own WhatsApp, needs no
approval, and should stay whatever else is wired up.

### 3.2 Email

Identical shape, different transport — the seam does not care:

```ts
// lib/notify/email.ts  (Resend shown; any HTTP mail API is the same five lines)
export const emailDriver: NotifyDriver = {
  async send(message) {
    if (message.channel !== "email") return { ok: false, error: "wrong-channel" };
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Red or Nude <hello@redornude.sa>",
        to: message.to,
        subject: subjectFor(message),   // per template, per language
        html: renderTemplate(message),  // message.data → HTML, RTL for Arabic
      }),
    });
    return { ok: res.ok };
  },
};
```

Since a real deployment wants **both** channels, route on
`message.channel` rather than picking one driver:

```ts
function getDriver(): NotifyDriver {
  if (process.env.NOTIFY_DRIVER !== "live") return logDriver;
  return {
    send: (m) => (m.channel === "email" ? emailDriver.send(m) : whatsappDriver.send(m)),
  };
}
```

Remember the domain needs SPF/DKIM before anything reaches an inbox, and Arabic
mail needs `dir="rtl"` on the body — `message.lang` is already supplied.

### 3.3 Payments

The gateway seam predates this work and is unchanged: `PaymentDriver` in
[lib/payments/index.ts](../lib/payments/index.ts), with
[fake.ts](../lib/payments/fake.ts) approving everything. Both bookings **and**
gift cards now go through it, so one driver covers both.

```ts
// lib/payments/moyasar.ts
export const moyasarDriver: PaymentDriver = {
  name: "moyasar",
  async charge({ ref, amountHalalas, method }) {
    const res = await fetch("https://api.moyasar.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.MOYASAR_SECRET_KEY}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      // Moyasar counts halalas too, so no conversion.
      body: JSON.stringify({ amount: amountHalalas, currency: "SAR", description: ref, callback_url: … }),
    });
    const raw = await res.json();
    return { status: raw.status === "paid" ? "paid" : "failed", providerRef: raw.id, raw };
  },
};
```

```ts
export function getDriver(): PaymentDriver {
  return process.env.PAYMENT_DRIVER === "moyasar" ? moyasarDriver : fakeDriver;
}
```

Two things a real gateway needs that the stand-in does not:

1. **A webhook.** Cards in Saudi go through 3-D Secure, so the customer leaves
   the site and the browser cannot be trusted to come back. Add
   `app/api/payments/webhook/route.ts`, verify the provider's signature, look the
   payment up by `provider_ref`, and drive the same confirmation path
   `confirmBookingPayment()` uses. Until that exists, a customer who closes the
   tab mid-3DS has paid for a hold that will be swept.
2. **Refunds.** The `refunds` table exists and nothing writes to it. Both
   `[payments] charged … but could not confirm` and `[giftcards] charged … but
   could not issue` currently mean *a human settles this from the log*. Wire the
   provider's refund call to those two branches.

Env: `PAYMENT_DRIVER=moyasar`, `MOYASAR_SECRET_KEY`, `MOYASAR_WEBHOOK_SECRET`.

### 3.4 Cron

The reminder endpoint is written and guarded but nothing calls it, because until
§3.1 or §3.2 lands it would only write log lines. When a provider is live, add to
`vercel.json`:

```json
{
  "crons": [{ "path": "/api/cron/refill-reminders", "schedule": "0 6 * * *" }]
}
```

That is 06:00 UTC — 09:00 in Riyadh. Set `CRON_SECRET` in the Vercel project and
make sure Vercel's cron invocation carries it as `Authorization: Bearer …`;
without a match the route answers `401` and sends nothing.

One property to keep in mind: the job messages the cohort with *exactly*
`refill_reminder_days` left. Running daily nudges every booking once. Skip a day
and that day's cohort is never nudged — acceptable while this is a courtesy, and
the fix if it ever matters is a `reminder_sent_at` column plus a range check
rather than an equality one.

---

## Part 4 — Granting a refill, and unlocking it

Two additions to the flow above: the salon can grant a window by hand, and the
customer proves their identity before the offer is shown.

### 4.1 Admin grants

**Admin → Bookings → a booking → Grant refill.** Enter days from today.

Stored as `bookings.refill_expires_at`, a **deadline rather than a day count**,
so it cannot drift when someone edits the service's `refill_days` afterwards — a
customer told "you have until the 18th" keeps until the 18th.

Counted from **today, not from the appointment**, because this exists for "give
her another two weeks" and that is what the customer means by it.

It does three things, all through the same field:

| Days | Effect |
| --- | --- |
| > 0 on a service with a window | extends or **shortens** it |
| > 0 on a service with `refill_days: 0` | creates an offer where there was none |
| 0 (Revoke) | drops back to the service's own window, which may still be open |

A grant sets a deadline and nothing else. **Every other rule in
`refillDaysLeft()` still applies**: a booking that has not happened yet, one
whose refill was already claimed, or a refill of its own stays ineligible however
generous the grant. `npm run check:fields` asserts exactly that.

Granting is `bookings.manage` only and writes an `audit_log` row
(`grant-refill` / `revoke-refill`) — a refill is a discount, so who gave it is a
money question.

### 4.2 The customer unlocks it with an emailed code

The booking reference is a weak credential: it travels in emails and gets
forwarded. So the listing at `/my-bookings` says only **whether** a refill exists
(`hasRefill`) — the countdown, the price and the booking link are not in that
response at all. Tapping it opens a dialog, which emails a six-digit code to the
address on file; entering it returns the offer.

```
POST /api/my-bookings/otp     { code }        → emails a code, returns f•••@gmail.com
POST /api/my-bookings/refill  { code, otp }   → { daysLeft, expiresAt, priceSar, bookUrl }
```

Reference + inbox is two factors with no account, which is the most that can be
asked of a customer who never signed up.

The rules the code is held to (`lib/otp.ts`), and why each exists:

- **Hashed at rest.** This row guards customer data; a database dump must not
  contain live codes. SHA-256 unsalted and unstretched *on purpose* — six digits
  is a keyspace of one million, so any hash is table-reversible and bcrypt would
  buy only latency on a request the customer is waiting for. What hashing buys is
  that a leak has nothing live in it.
- **Single use**, consumed on the first success.
- **Ten minutes** — long enough to switch to an inbox, short enough that a
  forwarded email is not a standing key.
- **Five attempts**, then the code is burned. Six digits falls to an unthrottled
  verify in minutes.
- **One live code per booking** — requesting a new one invalidates the old, so
  two emails can never both work.
- **Constant-time comparison**, so a wrong code cannot be narrowed by timing.

Two throttles on the request endpoint, because it has two abuse shapes: per IP
(walking the reference space) and **per booking** (mailbombing a customer whose
reference you know — no IP limit alone stops that).

The request endpoint **never reveals whether a reference exists**: an unknown
code and a real one return the same shape. Otherwise it would be a yes/no oracle
for guessed references.

> Unlike the invoice, a failed OTP send **surfaces** as a `502` rather than only
> logging. An invoice that fails still leaves a valid booking; a code that never
> arrives leaves the customer stuck at a dialog they cannot pass.

### 4.3 What this does not change

The customer still **books their own slot** — the dialog ends at a link to
`/booking?refill=RON-XXXX`, and that page re-validates the whole offer
server-side. Nothing returned by the verify endpoint is trusted afterwards.
