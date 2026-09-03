# Requirements register — money

Phase 1 of `nextjs-drizzle-hardening`, area `money`: everything that moves riyals.

**Source rule (coordinator correction, 2026-09-02):** the source *is* a
specification. A rule asserted in a code comment and nowhere in `docs/` is still
a requirement; its citation is the comment. Rows below cite `docs/…:Lnn` and
`lib/…:Lnn` interchangeably, and the `Src` column says which kind it is.

`<ENT>` codes from `docs/_testing/glossary.md`: `PAY` payments, `RFD` refunds,
`MNY` the pure maths in `lib/money.ts`, `INV` the invoice.

| REQ | Source | Src | Statement | Type | Pri |
|---|---|---|---|---|---|
| REQ-MNY-001 | lib/db/schema.ts:3 | comment | "every amount is an INTEGER count of halalas (1 SAR = 100 halalas)" | validation | P0 |
| REQ-MNY-002 | lib/db/schema.ts:4-6 | comment | Postgres `numeric` is deliberately rejected; integer minor units keep the maths in plain JS numbers | validation | P0 |
| REQ-MNY-003 | lib/db/schema.ts:7 | comment | "Format for display with `formatSAR` in lib/money.ts — never with toFixed alone." | validation | P2 |
| REQ-MNY-004 | docs/ADMIN-PANEL.md:333 | doc | "**Money is integer halalas**, not `numeric`." | validation | P0 |
| REQ-MNY-005 | lib/money.ts:11 | comment | `sarToHalalas` rounds: `Math.round(sar * 100)` | validation | P1 |
| REQ-MNY-006 | lib/money.ts:29-30 | comment | `vatOn` "Rounds half-up to the halala, so subtotal + vat always equals the total that gets charged" | validation | P1 |
| REQ-MNY-007 | lib/money.ts:34 | comment | "Prices shown to customers are VAT-inclusive; split one back out" — `vatIncludedIn` extracts, never adds | validation | P0 |
| REQ-MNY-008 | docs/BOOKING-V2.md:116 | doc | "Saudi prices already include 15% VAT, so we never *add* VAT — we pull it back out to report it." | validation | P0 |
| REQ-MNY-009 | docs/BOOKING-V2.md:122 | doc | `discount = round(combined gross x 10%)` — "the only rounding anywhere" | validation | P0 |
| REQ-MNY-010 | lib/money.ts:43-44 | comment | `shareAmount`: "The returned shares sum to `amount` exactly — that is the whole point." | validation | P0 |
| REQ-MNY-011 | lib/money.ts:59-60 | comment | Leftover halalas go to the largest fractional remainders, "ties broken by position so it's deterministic" | validation | P1 |
| REQ-MNY-012 | lib/money.ts:82-83 | comment | `splitGroupPrice`: "A single guest, or a percent of 0, returns the gross amounts untouched" | validation | P0 |
| REQ-MNY-013 | docs/REVIEWS-AND-PROMOS.md:289-290 | doc | "the two guests' totals sum **exactly to the bill**. Not 'within a halala' — exactly." | validation | P0 |
| REQ-MNY-014 | docs/BOOKING-V2.md:133-135 | doc | The two guests' VAT figures may sum to one halala different from VAT on the whole bill — that is correct | validation | P1 |
| REQ-MNY-015 | lib/money.ts:53 | comment | `shareAmount` returns all zeros when `amount <= 0` or the weights sum to 0 | validation | P1 |
| REQ-PAY-001 | lib/payments/confirm.ts:9-12 | comment | A group is charged once (one gateway transaction) but recorded as **one `payments` row per booking sharing a `providerRef`** | state | P0 |
| REQ-PAY-002 | lib/payments/confirm.ts:12-13 | comment | "every row's amount equal to its booking's total (so the numbers never lie)" | validation | P0 |
| REQ-PAY-003 | lib/payments/confirm.ts:5-6 | comment | Only a successful charge flips a hold to `confirmed` and issues the ticket number | state | P0 |
| REQ-PAY-004 | lib/payments/confirm.ts:75-76 | comment | Any member not `pending` → `expired`; "there is nothing to charge for" | state | P0 |
| REQ-PAY-005 | lib/payments/confirm.ts:63 | code | An unknown booking code → `not-found` | state | P0 |
| REQ-PAY-006 | lib/payments/confirm.ts:118-119 | comment | A decline "Deliberately leaves the bookings pending" so the customer can retry without re-picking the slot | state | P0 |
| REQ-PAY-007 | lib/payments/confirm.ts:105-110 | code | A charge that throws marks every `payments` row of that ref `failed` and returns `failed` | side-effect | P0 |
| REQ-PAY-008 | lib/payments/confirm.ts:152-154 | comment | **"Still pending, or someone swept it while the gateway was thinking. The row count is the whole concurrency story here."** A concurrent confirm must not double-charge | state | P0 |
| REQ-PAY-009 | lib/payments/confirm.ts:195-196 | comment | The promo redemption is counted at confirmation, once per bill — "a group is one redemption, not two" | side-effect | P0 |
| REQ-PAY-010 | lib/payments/confirm.ts:199-201 | comment | Loyalty points are minted at confirmation, not at hold — "an abandoned checkout must not mint points" | side-effect | P0 |
| REQ-PAY-011 | lib/payments/confirm.ts:186-190 | comment | The invoice and the confirmation message are awaited but "Neither can fail the payment" | side-effect | P1 |
| REQ-PAY-012 | lib/payments/confirm.ts:249-251 | comment | The confirmation message failing is swallowed: "the money is taken and the chair is theirs whether or not a message provider is having a good day" | side-effect | P1 |
| REQ-PAY-013 | lib/payments/confirm.ts:266-268 | comment | Charge succeeded but confirm failed → loud log, `refund owed`, result `expired` | side-effect | P0 |
| REQ-PAY-014 | app/api/payments/confirm/route.ts:16-22 | code | Body is exactly `{ code: 4..20 chars, method: card/mada/stc/apple, simulate?: "decline" }`. No amount is accepted | validation | P0 |
| REQ-PAY-015 | app/api/payments/confirm/route.ts:19-20 | comment | `simulate` is "Only honoured outside production" | security | P0 |
| REQ-PAY-016 | app/api/payments/confirm/route.ts:24-29 | code | Status map: not-found 404, expired 409, payment-declined 402, failed 500; malformed JSON 400; schema failure 400 | contract | P1 |
| REQ-PAY-017 | docs/PAYMENTS-MOYASAR.md:71 | doc | "**Amounts** are in the smallest currency unit. We store halalas. No conversion." | validation | P0 |
| REQ-PAY-018 | docs/PAYMENTS-MOYASAR.md:158-162 | doc | "The publishable key can create a payment for any amount, from the browser… The server-side comparison against the booking total on settle is the only thing that catches it. It is not optional." | security | P0 |
| REQ-PAY-019 | docs/PAYMENTS-MOYASAR.md:187 | doc | "`app/api/payments/webhook/route.ts`. Check `secret_token`, same settle, return 2xx." | security | P0 |
| REQ-PAY-020 | docs/PAYMENTS-MOYASAR.md:144-146 | doc | "**Settle must be idempotent** — it will genuinely run twice, once from the browser and once from the webhook, and whichever loses does nothing." | state | P0 |
| REQ-PAY-021 | docs/PAYMENTS-MOYASAR.md:240 | doc | `MOYASAR_WEBHOOK_SECRET` is "the secret_token we set and they echo" | security | P0 |
| REQ-PAY-022 | docs/PAYMENTS-MOYASAR.md:243-245 | doc | "`getDriver()` branches on `PAYMENT_DRIVER` and returns `fakeDriver` for anything else, so an unset environment stays safe-by-default in dev" | security | P0 |
| REQ-PAY-023 | lib/payments/index.ts:57 | comment | "Branch on `process.env.PAYMENT_DRIVER` here **once there is a second driver**." | security | P0 |
| REQ-PAY-024 | lib/payments/fake.ts:1-6 | comment | The fake driver "approves everything, unless a dev caller asks for a decline"; deploying with it means "customers book for free" | security | P0 |
| REQ-PAY-025 | lib/payments/fake.ts:34-37 | comment | The fake driver's refund has "No decline path here on purpose" | contract | P2 |
| REQ-PAY-026 | app/api/gift-cards/route.ts:9-11 | comment | "Order matters — money first, card second. A card issued before a declined charge is free money" | state | P0 |
| REQ-PAY-027 | app/api/gift-cards/route.ts:28-29 | code | Gift-card amount is client-chosen but bounded 50–2000 SAR — "the bound is what's enforced" | validation | P0 |
| REQ-RFD-001 | lib/payments/refund.ts:4-8 | comment | Refunding a party is one gateway call for the summed amount and one `refunds` row per payment | state | P0 |
| REQ-RFD-002 | lib/payments/refund.ts:29-34 | comment | `refundBookings` **never throws**; a gateway outage must not fail the cancellation | contract | P0 |
| REQ-RFD-003 | lib/payments/refund.ts:59-61 | comment | Only `status = 'paid'` rows are refunded. No paid rows → `ok:false`; "an unpaid hold being cancelled, or a booking already refunded" are both ordinary | state | P0 |
| REQ-RFD-004 | lib/payments/refund.ts:65-67 | comment | Every row of one bill shares a `providerRef`; the first row's ref is the transaction | state | P1 |
| REQ-RFD-005 | lib/payments/refund.ts:70-73 | code | Paid rows with a null `providerRef` → `ok:false`, loud log, no refund row | state | P1 |
| REQ-RFD-006 | lib/payments/refund.ts:77-80 | code | A declined refund writes **no** `refunds` row and leaves `payments.status` as `paid` | side-effect | P0 |
| REQ-RFD-007 | docs/CANCEL-RESCHEDULE-ADDON.md:151-152 | doc | On a declined refund "no `refunds` row is written, `payments.status` stays `paid`" | side-effect | P0 |
| REQ-RFD-008 | docs/CANCEL-RESCHEDULE-ADDON.md:138 | doc | Cancelling twice leaves "**only one** `refunds` row" | state | P0 |
| REQ-RFD-009 | docs/CANCEL-RESCHEDULE-ADDON.md:142 | doc | Cancelling an unpaid `pending` hold refunds nothing | state | P0 |
| REQ-RFD-010 | lib/payments/refund.ts:90-93 | comment | `refunds.actorId` is null for a self-service cancellation — the audit log carries the "who" | observability | P2 |
| REQ-RFD-011 | lib/db/schema.ts:73 | code | `payment_status` declares `partially_refunded` | state | P1 |
| REQ-RFD-012 | docs/NO-SHOW-RELEASE.md:130 | doc | "**Nothing here touches money.** `refundBookings` is not called, no `refunds` row" on a no-show release | side-effect | P1 |
| REQ-INV-001 | lib/invoice/data.ts:6-8 | comment | Every figure is read back off the booking rows, never recomputed from the catalog | validation | P0 |
| REQ-INV-002 | lib/invoice/data.ts:10-13 | comment | "the invoice *reports* the VAT already inside the total — it never adds any. Per guest, subtotal + VAT = total, and the guests' figures sum to the bill" | validation | P0 |
| REQ-INV-003 | docs/INVOICE-EMAIL.md:64-66 | doc | "Per guest, `subtotal + VAT = total`. A group is **one** invoice listing both guests" | validation | P0 |
| REQ-INV-004 | lib/invoice/data.ts:76-78 | comment | The invoice number is deterministic: "the same booking always renders the same invoice number" | validation | P1 |
| REQ-INV-005 | lib/invoice/data.ts:81-88 | comment | `INV-YYYYMM-XXXX` from the issue month plus the anchor code, uniqueness riding on `bookings.code` | validation | P2 |
| REQ-INV-006 | lib/invoice/data.ts:101-104 | comment | "no customer email means no invoice, which is a normal outcome for walk-ins" — returns `null`, not an error | state | P1 |
| REQ-INV-007 | lib/invoice/data.ts:117-119 | comment | Caller order is ticket order; the `WHERE IN` does not preserve it and it is re-imposed | contract | P1 |
| REQ-INV-008 | lib/invoice/data.ts:158-160 | comment | The method and `providerRef` come from a **paid** payments row on the bill | validation | P0 |
| REQ-INV-009 | lib/invoice/template.ts:8-10 | comment | "The whole document flips to RTL for Arabic" — direction follows `customer.lang` | localization | P1 |
| REQ-INV-010 | lib/invoice/template.ts:82 | comment | "Customer data lands inside an HTML document — never interpolate it raw." | security | P0 |
| REQ-INV-011 | docs/INVOICE-EMAIL.md:39-41 | doc | The send "cannot fail the payment" — `sendBookingInvoice` catches everything | side-effect | P0 |
| REQ-INV-012 | lib/invoice/send.ts:6-8 | comment | "every failure below is swallowed and logged. Nothing here is allowed to throw into confirmBookingPayment" | side-effect | P0 |
| REQ-INV-013 | docs/INVOICE-EMAIL.md:53-55 | doc | Walk-ins/phone bookings legitimately have no address; `sendBookingInvoice` reports `no-email` | state | P1 |
| REQ-INV-014 | lib/invoice/data.ts:66-70 | comment | The invoice carries only what the invoice needs of the customer — name, email, phone, lang | security | P0 |
| REQ-INV-015 | docs/INVOICE-EMAIL.md:70-77 | doc | Not ZATCA-compliant: the number is unique and stable but **not sequential** | validation | P3 |

## AMBIGUOUS / contradictory — not tested as spec

| # | The two sides | Question for the owner |
|---|---|---|
| A-1 | `docs/PAYMENTS-MOYASAR.md:243` says "`getDriver()` branches on `PAYMENT_DRIVER`" in the present tense; `lib/payments/index.ts:57` says "Branch on `process.env.PAYMENT_DRIVER` here **once there is a second driver**" and the function unconditionally returns `fakeDriver`. `.env.example:75` and `.env.local:37` both already set `PAYMENT_DRIVER=moyasar`. | Which is authoritative? The doc's §7 safety argument ("safe-by-default in dev — and lethal in production") only holds if the branch exists. Today the variable is inert, so an operator who set it believes money is moving when it is not. Logged as BUG-MONEY-002. |
| A-2 | `docs/PAYMENTS-MOYASAR.md:187` specifies `app/api/payments/webhook/route.ts` with a `secret_token` check; `docs/PAYMENTS-MOYASAR.md:6` says "Nothing here is built yet. This is the plan"; `docs/BOOKING-V2.md:344` lists "**No webhook**" as a known limit. | Is the Moyasar doc a specification or a design note? It is written as spec (numbered work items, env table) but disclaims itself in line 6. Treated here as **spec-without-code** — tested as a failing/skipped P0, never as if it existed. Logged as BUG-MONEY-001. |
| A-3 | `lib/payments/confirm.ts:152-154` claims the per-member `UPDATE` row count is "the whole concurrency story"; the `WHERE` on the line above filters on `bookings.id` only, with no `status` predicate, so the count is always 1. | Comment-vs-code contradiction. The comment states the requirement; the code does not implement it. Logged as BUG-MONEY-003 (P0, double charge). |
| A-4 | `lib/db/schema.ts:73` declares `partially_refunded`; nothing in the repo ever writes it (`grep` finds exactly one hit, the enum declaration). `lib/payments/refund.ts` sets every row to `refunded` whatever the amount. | Is `partially_refunded` reserved for the real gateway, or a state the refund path should already be reaching? Logged as BUG-MONEY-005. |
