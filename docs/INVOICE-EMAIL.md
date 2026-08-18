# Invoice email

Every paid web booking emails the customer a simplified tax invoice. Sent through
Resend, rendered server-side, in the customer's own language.

This closes the "email/SMS" gap that `docs/BOOKING-V2.md` §1 listed as out of
scope — for invoices only. SMS and gift-card receipts are still not built.

---

## 1. Where it happens

```
POST /api/payments/confirm
     │
     ▼
confirmBookingPayment()                     lib/payments/confirm.ts
     │  charge → confirm bookings → issue tickets
     │
     ▼
sendBookingInvoice(bookingIds)              lib/invoice/send.ts
     ├─ buildBookingInvoice()               lib/invoice/data.ts
     ├─ renderInvoiceEmail()                lib/invoice/template.ts
     └─ sendMail()                          lib/email/resend.ts
     ▼
response returned to the browser
```

**The send is awaited, not fired and forgotten.** On a serverless host the
function is frozen the instant the response is returned, so a detached promise
would simply never run. It adds a few hundred milliseconds to the confirm call.

**It cannot fail the payment.** `sendBookingInvoice` catches everything and
returns an outcome; `sendMail` never throws. By the time it runs the card has
been charged and the tickets issued — the booking is real whether or not the mail
lands. Failures are logged loudly (`[invoice] … was not delivered`) so someone can
find them and resend by hand.

## 2. Where the email address comes from

`bookings` has no email column; `customers.email` does, and the invoice reads it
back through `bookings.customer_id`.

The checkout form at `/booking/payment` now collects it alongside name and phone,
and **requires** it — `Confirm Payment` stays disabled until the address parses.
`POST /api/bookings` requires it too, so the field can't be bypassed by calling
the route directly.

Walk-ins and phone bookings go through `createBookings` directly and are still
allowed to have no email. `buildBookingInvoice` returns `null` for them, and
`sendBookingInvoice` reports `no-email` — a normal outcome, not an error.

A returning customer's email is updated on the `customers.phone` upsert, so the
invoice goes to the address typed at checkout rather than one from last year.

## 3. What the invoice says

Every figure is read out of the booking rows, never recomputed from the catalog —
`serviceName`, `servicePriceHalalas`, the `booking_addons` snapshots and the VAT
split were all frozen at booking time so a reprint next year still says what the
customer was charged today.

KSA prices are VAT-inclusive, so the invoice *reports* the VAT already inside the
total; it never adds any. Per guest, `subtotal + VAT = total`. A group is **one**
invoice listing both guests — one card was charged once — and the guests' totals
add back up to the bill. See `docs/BOOKING-V2.md` "The discount maths" for why
the two guests' VAT can differ by a halala from VAT on the whole bill.

Invoice numbers are `INV-YYYYMM-XXXXX`, derived from the issue month and the
anchor booking's code. Deterministic, so a reprint is byte-identical, and unique
because `bookings.code` is — with no extra table, migration or lock in the
payment path.

> **Not ZATCA-compliant yet.** A compliant simplified invoice also needs a
> *sequential* number per taxpayer, the TLV QR code, and the signed XML. This is
> unique and stable but not sequential. It needs replacing before the salon files
> these — the same milestone as swapping `lib/payments/fake.ts` for a real
> gateway.

Seller identity comes from two settings, both editable without a deploy:

| Key | Default | Notes |
| --- | --- | --- |
| `business_legal_name` | `Red or Nude` | Printed on every invoice. |
| `vat_number` | *(empty)* | 15 digits from ZATCA. The line is hidden while empty. |

## 4. The template

`lib/invoice/template.ts` renders HTML and a plain-text twin. Written for mail
clients, not browsers: tables for layout, inline styles only, no flexbox, no web
fonts, no external images — Gmail strips `<style>` blocks in some views and
Outlook renders with Word's engine.

The whole document flips to RTL for Arabic, which is why alignment is expressed
as `start`/`end` variables rather than hardcoded left/right.

Customer-supplied text is interpolated into HTML, so everything goes through
`esc()`. `scripts/preview-invoice.ts` asserts this.

The plain-text part is the one written here, never auto-generated. An invoice is
a record of what was charged; it must arrive exactly as written.

## 5. Checking it

```
npm run preview:invoice                        # render only
npm run preview:invoice -- --send you@you.com  # render, then really send one
```

Without `--send` this is pure — no database, no network, nothing sent. It renders
both languages to `.preview/invoice-{ar,en}.html` (gitignored) and asserts that
the totals add up and that customer text is escaped. Open the files in a browser.

`--send` posts one through the same `sendMail()` the payment path uses, so a
green result means the real transport works rather than a mock.

## 6. Configuration

```
RESEND_API_KEY=        # resend.com/api-keys
MAIL_FROM_EMAIL=       # must be on a domain verified at resend.com/domains
MAIL_FROM_NAME=
MAIL_REPLY_TO=         # optional; omit and replies go nowhere
```

With no key set, invoices are **skipped with a warning** rather than failing the
payment — local development and CI need no credentials.

Before this works for real customers:

1. Verify the sending domain at resend.com/domains and publish the DNS records it
   gives you, or every send comes back `403 / rejected`.
2. Point `MAIL_FROM_EMAIL` at an address on that domain. The default,
   `onboarding@resend.dev`, needs no domain but **only delivers to the Resend
   account's own address** — fine for a first smoke test, useless in production.
3. Set the four variables in Vercel (Production **and** Preview).

The transport is one file, `lib/email/resend.ts`, talking to one endpoint with
`fetch`. Nothing else in the codebase knows which provider sends the mail, so
switching again means rewriting that file and nothing else.

## 7. The overlap with `lib/notify/`

Two outbound paths now run back to back in `confirmBookingPayment`, and they were
built independently on parallel branches:

| | `sendConfirmations` → `notify()` | `sendBookingInvoice` → Resend |
| --- | --- | --- |
| Purpose | "You're booked" + the reference for `/my-bookings` | The tax invoice |
| Shape | Generic: channel, template, `data` bag | One fully rendered AR/EN email |
| Channels | WhatsApp and email | Email only |
| Delivers? | **No** — `lib/notify/log.ts` only prints | **Yes** |

Right now they don't collide: only the invoice actually sends, and it already
prints the booking reference per guest, so the customer does receive the one
thing `sendConfirmations` exists to deliver.

**They will collide the moment `notify()` gets a real driver** — one payment
would send two emails covering overlapping ground.

Worth deciding before that happens. The options, roughly:

1. **`notify()` owns delivery; the invoice becomes a template.** Most consistent
   with the seam's intent, and gives WhatsApp for free. Costs work: `notify()`'s
   `data` bag would have to carry, or defer to, a fully rendered document, which
   is not what a template-variable interface is shaped for.
2. **Add a Resend driver to `notify()` and let the invoice keep its own path.**
   Smallest change. Keeps one HTTP client and one API key, while the invoice
   stays a rendered document rather than a template.
3. **Fold the booking confirmation into the invoice email.** One email after
   payment, carrying reference, tickets and invoice together. Fewest messages for
   the customer; loses the WhatsApp channel for confirmations.

Option 2 is the smallest correct step and doesn't foreclose the others. This is a
call for whoever owns the notification design, not something to settle inside a
merge — which is why both paths are still wired up as their authors wrote them.

## 8. The gift card email

A successful gift card purchase emails the card itself. Same transport, same
failure isolation, same shape as the invoice:

```
POST /api/gift-cards
     │  charge → issueGiftCard() → payments row
     ▼
sendGiftCardEmails()                        lib/giftcard/email.ts
     ├─ renderGiftCardEmail()               (exported for the preview script)
     └─ sendMail()                          lib/email/resend.ts
```

**Two emails, deliberately different.** The recipient gets the card — amount,
code, and the buyer's personal message. The buyer gets a short receipt with the
code but *not* the message they wrote, so a wrong address or a spam folder isn't
an unrecoverable loss. If buyer and recipient are the same address, only one is
sent.

**Email does not go through `notify()`.** WhatsApp still does. Routing both
through `notify()` would mean a real notify driver sends the card twice — the
same collision described in §7. `lib/giftcard/email.ts` owns email delivery for
gift cards; `notify()` owns WhatsApp, and is still log-only.

Two gaps worth knowing:

- **`buyerEmail` is never collected.** The gift card builder asks for the
  recipient's email and phone, not the buyer's, so the buyer receipt is wired but
  dormant — `sendGiftCardEmails` reports `buyer: "skipped"`. Add a buyer email
  field to `GiftSelection` and the builder form to switch it on.
- **A phone-only purchase delivers nothing.** `recipientEmail` and
  `recipientPhone` are individually optional (one is required). With only a
  phone, delivery falls to `notify()` on WhatsApp, which still just prints.

### The card image

The email shows the card as a real picture, not a styled table. `<GiftCardArt>`
can't run in an inbox, and text can't be positioned over a background image in
Outlook (Word's renderer, no absolute positioning), so the card is rendered to a
PNG by `app/api/gift-card-image/route.tsx` using `next/og` — which ships with
Next, so no new dependency.

Two deliberate limits on what goes *in* the image:

- **Latin only.** Satori loads no Arabic font by default, so Arabic would render
  as empty boxes. Names and the personal message stay as HTML text around the
  image, where they remain translatable, selectable and readable to a screen
  reader.
- **No card code.** It must stay copyable, and Gmail proxies and caches remote
  images — a code baked into an image URL is a code sitting in a third-party
  cache. The code is real text in the panel underneath.

Most clients block remote images until the reader allows them, so the amount and
code are repeated as text below the image. The email is fully usable with images
off. `amount` is clamped to the same 50–2000 bounds the purchase endpoint
enforces, so the route can't render a card claiming an arbitrary value.

It needs `SITE_URL` — emails are read outside our origin, so the URL must be
absolute. It falls back to `AUTH_URL`, then localhost.

> The image draws the brand red card. It does **not** use the selected design's
> artwork, because `design-{congrats,birthday,anniversary}.webp` are Figma comps
> with `750` and `Sarah` baked into the pixels — see the artwork question still
> open on the gift card section. Once clean templates exist, this route can take
> a design id and composite the real background.

### Checking it

```
npm run preview:giftcard                        # render only
npm run preview:giftcard -- --send you@you.com  # render, then really send one
```

Renders both languages in both variants to `.preview/giftcard-{ar,en}-{recipient,buyer}.html`
and asserts the code reaches both HTML and text parts, that the buyer copy omits
the personal message, and that sender names are escaped.
