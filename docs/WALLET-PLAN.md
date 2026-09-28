# Wallet plan

## Context
Once a booking is confirmed, money never goes back to the card. It becomes **wallet credit** (decided in PAYMENT-HARDENING-PLAN.md, "Refund rule"). Gift cards also become wallet credit. Today:
- no money wallet exists (the /account "wallet" holds loyalty points);
- her own cancel still refunds the card (`refundBookings`);
- a salon cancel moves no money;
- nothing can spend a gift card: `adjustGiftCardBalance` is called only by the admin adjust action.

Goal: one wallet per customer. It is filled by cancellations, gift cards and small chair refunds, and spent at every checkout except buying gift cards. A guest's credit belongs to her **email**, and waits until she signs in with it.

Fixed decisions:
- **Spent at:** bookings (with their chair add-ons), memberships, chair QR purchases. **Not** gift card purchases: credit turned into a gift card code can be sold for cash, and a stolen card behind the credit is charged back later.
- **Never expires.** An unclaimed gift card keeps its own `expiresAt`. Once claimed into the wallet, the credit never expires.
- **A guest is her email, not her phone.** The phone can change and proves nothing. Every credit is tagged with the email of the booking or card it came from, and only a sign-in with that email reaches it.
- **Every change is a row.** Spends, releases, reversals and corrections are all written to the ledger, so "why did my balance change?" is answered from the table alone.
- **She never sees a negative balance.** Shown and spendable: `max(0, sum)`. A debt from a reversal is kept in the table and paid off by her next credits first.
- **Only the owner corrects, with a reason.** No staff action writes to the ledger. The owner can add a `correction` row from the "Needs your decision" page, with a required reason, recorded in the audit log.
- **Gift card email:** the brand card image goes inline (cid attachment), so it shows without "load images".

## Open questions
**For the client (sent, waiting):**
1. **Salon cancel inside 3 h.** The technician is off sick at 11:00 for a 12:00 booking. Offer a reschedule first and credit if she declines? Must the salon enter a reason? Until answered, the build treats a salon cancel as always allowed, with a reason, crediting the wallet. That is what `setBookingStatus` does today ("she should not lose an appointment she paid for over a decision that was not hers"). The alternative is marking a no-show, which gives her nothing.
2. **VAT** (the accountant): gift cards taxed at sale or at redemption; a credit note for a cancelled booking; credit spent as a StreamPay coupon. **Needed before build step 3**: if credit must be a payment method and not a discount, steps 3 and 4 change, because StreamPay links only take coupons.
3. **One sentence for the refund policy.** Card refunds still happen when she pays late, pays the wrong amount, pays twice, or buys something we can't deliver. Proposed: "A payment that bought nothing goes back to the card; everything else goes to the wallet." Written into PAYMENTS-STATUS.md once agreed.

**For StreamPay support:**
4. What status does a chargeback show on a payment: `REFUNDED`, or something like `DISPUTED`? Is there a disputes API or webhook? Today there is no chargeback event (`app/api/payments/streampay/webhook/route.ts`), and the daily comparison is what finds one.

**Settled:** StreamPay's payment page has no field for typing a coupon (checked in the sandbox). If one appears, a payment below our amount is already refunded and nothing is given for it (`confirm.ts` "wrong-amount", `purchase.ts` "wrong-amount").

## How money enters and leaves

| Event | Wallet |
|---|---|
| She cancels more than 3 h before | **+** card paid on that booking + wallet spent on it |
| Salon cancels (reason required) | **+** same amount. Inside 3 h: see open question 1 |
| She cancels within 3 h | Not allowed (already enforced) |
| A cancelled booking with a cancel credit set back to confirmed | Refused. The desk makes a new booking |
| No-show (`resolveNoShow`, marked no-show) | Nothing. Spent points are not returned either |
| Gift card bought for an email that has an account | **+** full card value on delivery. The card becomes `redeemed` |
| Gift card code entered at checkout | **+** the card's whole balance, then spent on the bill. Anything left stays in the wallet |
| Gift card's email signs up later | **+** every active card sent to that email is claimed at `createAccount` |
| Chair purchase of 10 SAR or less we couldn't deliver | **+** amount (turns `owedCredit` into credit) |
| A payment that funded credit is refunded outside the app or charged back | **−** that credit (the refunded share of it, if partial). Below 0: shown as 0, owner alerted |
| Gift card refunded in StreamPay's dashboard after it was claimed | **−** the claim, the same way |
| Checkout uses credit | **−** min(available, bill), kept so at least 1 SAR is left to charge or the bill is fully covered |
| Checkout abandoned, declined, or hold lapsed | **+** a `release` row for that spend |
| A released checkout's payment turns up paid (revive) | **−** a new spend if the balance still covers it. Otherwise nothing is delivered, and the card part is refunded as a late payment |
| Owner correction | **±** with a reason, audited |

Examples:
- Card 100, bill 500: 100 off, 400 charged.
- Card 250, bill 250: nothing charged, booking confirmed on the zero-bill path.
- Card 500, bill 250: free, and 250 left in the wallet. A guest gets an email: "250 SAR is in your Red or Nude wallet. Sign in with <email> to use it."

## Gaps found in the code (and how each is closed)
1. **No way to spend a gift card.** Closed by the claim-into-wallet step at checkout. `adjustGiftCardBalance` (`lib/giftcards.ts:124`) doesn't check `status` or `expiresAt`, so the claim checks both.
2. **No cancellation email exists.** `notifyCustomer("booking-cancelled")` only logs to the console (`lib/notify/log.ts`). A real email is added.
3. **A guest row is one per phone, and its email is overwritten.** Each guest booking overwrites the row's email (`createBookings`, `lib/bookings.ts:1155-1187`), and bookings save no email of their own. Two people sharing a phone share a row, so credit tagged from the row's email can name the wrong person, and `createAccount` turns the whole row into whoever signs up. Closed:
   - guest rows become one per email (`customers_guest_email_unique` replaces `customers_guest_phone_unique`); the phone is only a contact detail;
   - `bookings.customer_email` is saved at booking time; every credit's `owner_email` comes from the booking (or the gift card), never from the customer row;
   - the balance counts only rows whose `owner_email` is the account's verified email.
4. **A no-show also ends at `cancelled`** (`resolveNoShow`, `bookings/actions.ts:283`). Credit is never derived from the status. Only the two cancel paths write it.
5. **`bookings.customerId` can be null** (walk-in, deleted customer). Walk-ins have no payment, so the amount is 0. Money on a customer-less booking goes to the "Needs your decision" page instead of crediting.
6. **Purchases have no zero-bill path.** `startPurchase` always calls StreamPay. A zero path like `confirmBookingPayment`'s (`lib/payments/confirm.ts:217`) is added.
7. **`refundPaid` refuses a 0 total** (`refund.ts:101`). An undelivered purchase paid fully by credit is marked `refunded` without StreamPay, and its spend gets a `release` row.
8. **A guest mistypes her email.** Credit on `sara@gmial.com` can never be reached. Before a guest's credit is written, she confirms the address ("Your credit will be saved to s***@gmial.com. Is this right?"), and common domain typos (gmial, hotmial, yaho) are flagged. If it still goes wrong, staff check the booking's phone against her claim and the owner moves the credit with a `correction`.
9. **StreamPay minimum:** a link under 1 SAR after coupons is untested (PAYMENTS-STATUS ~L422). Credit is capped so at least 1 SAR remains, unless it covers the whole bill.
10. **The gift card image is a remote URL and always brand red.** It is attached inline instead. The chosen design stays unsupported (INVOICE-EMAIL.md §8).
11. **The salon cancel is two separate writes.** `setBookingStatus` (`bookings/actions.ts:103-140`) saves the status with no transaction and no check of the previous status, then returns pack credits in a try/catch that only logs. A crash between them leaves a cancelled booking with no credit. Closed in Cancellation below.
12. **Purchases take no customer lock.** `startPurchase` (`purchase.ts:88`) has no transaction, so two tabs could spend one balance twice. Closed by `spendWallet` below.
13. **A chargeback reverses nothing.** Chargebacks reach us only through the daily comparison (`reconcile.ts` `compareWithGateway`, 120 days back), which calls `refundedOutside` like the refund webhook does. `refundedOutside` only freezes gift cards. Closed by `reverseCredit` below.

## Design

### Data (migration 0031)
- `wallet_txns`: `id`, `customer_id` (fk customers), `owner_email` (lowercased, **every row**), `delta_halalas` int (non-zero), `reason` (`cancel-customer | cancel-salon | gift-card | chair-credit | spend | release | reversal | correction`), `booking_id`, `payment_id`, `gift_card_id`, `reverses_id` (fk wallet_txns: the row a `release` or `reversal` undoes), `note` (required on `correction` and `cancel-salon`), `actor_id`, `created_at`.
  - Partial unique indexes make every write idempotent, following the `pack_txns_return_unique` pattern (`schema.ts:1050`):
    - one cancel credit per booking;
    - one spend per booking;
    - one spend per purchase payment;
    - one claim per gift card;
    - one chair credit per payment;
    - one `release` and one `reversal` per `reverses_id`.
- `bookings.customer_email` text, saved at booking time.
- `bookings.wallet_discount_halalas` int default 0, stored per member row like `points_discount_halalas`.
- Guest identity: `customers_guest_email_unique` on `lower(email)` where not verified, replacing `customers_guest_phone_unique`. The migration first merges guest rows that already share an email, the way `createAccount` merges them. No wallet rows exist yet, so no money moves.
- Card claim: set the card to `redeemed` with balance 0, and add a `gift_card_txns` row (`reason: "to-wallet"`, `bookingId` when claimed at checkout). No new gift card column.

### `lib/wallet.ts` (one file)
- `walletBalance(customerId, ownerEmail, executor?)`: SUM(delta) over the customer's rows whose `owner_email` matches. Returns `{ total, available }`, `available = max(0, total)`. Nothing is derived from payment status: releases are rows.
- `spendWallet(tx, customerId, ownerEmail, halalas, { bookingId | paymentId })`: **the only way to spend.** Locks the customer row (`select … for update`, as `createBookings` does), reads the balance inside the lock, refuses more than `available`, writes the `spend` row.
- `releaseSpend(tx, spendId)`: writes the matching `release` row. Called in the same transaction as every write that ends a checkout: `markFailed` (`purchase.ts:435`), `releaseWebHold` (`lib/bookings.ts:748`) and the hold sweep (`payment-timeout`), and the undelivered-zero-bill path (gap 7).
- `claimGiftCard(tx, code, customerId, ownerEmail)`:
  - lock the card;
  - require `active`, not expired, balance > 0;
  - insert `+balance` and zero the card.
  - A card already claimed returns `claimed-by` with a masked email.
- `creditCancelled(tx, bookingIds, reason, note?)`: amount per booking = `paidOn` (export it from `lib/payments/refund.ts`) + `wallet_discount_halalas`. `owner_email` = `bookings.customer_email`. Null customer with money → "Needs your decision".
- `reverseCredit(tx, paymentId, refundedHalalas)`: for each credit that payment funded (a cancel credit through its booking, a gift card claim through its card, a chair credit), writes a `reversal` of the refunded share. Below 0 → alert and "Needs your decision". Called from `refundedOutside` (`refund.ts:245`) for full **and** partial refunds, which covers dashboard refunds, the refund webhooks and chargebacks found by the daily comparison.
- `creditOwedChair(ref)`: `refundOrCredit` (`purchase.ts:268`) credits now instead of marking. A one-off pass converts existing `owedCredit` rows **only where the payment is still `paid`**, and emails her.

### Checkout
- **Bookings.** `/api/bookings` takes `giftCardCode?` and `useWallet?`. In `createBookings`' transaction, after points (`lib/bookings.ts:1322`), under the existing customer row lock:
  1. claim the code if one was given;
  2. spend `min(available, remaining bill)` through `spendWallet`. Signed in, `available` is her balance. For a guest it is only what this code just brought in;
  3. apply the 1 SAR cap;
  4. split the spend across member rows.
  - `bookingLines` (`lib/payments/lines.ts:35`) adds a discount "Wallet credit". A bill fully covered goes down the existing zero path.
- **Preview:** `/api/wallet/quote` (modelled on `/api/loyalty/quote`) returns the balance and the value of a typed code, **without claiming**.
- **Purchases** (`startPurchase`, `lib/payments/purchase.ts:88`):
  - takes `wallet?: { customerId, halalas }`, **signed-in only**; the pending payment insert and `spendWallet` run in **one transaction**;
  - passes `discounts: [{ label: "Wallet credit", halalas }]`;
  - adds a zero-bill path.
  - Routes: the membership/pack route and the chair treat route (QR alone is not identity). **Not** `app/api/gift-cards`: it refuses `wallet` and gift card codes.
- **Revive** (`revivePayment`, `lib/payments/settle.ts:74`): before a revived payment confirms or delivers, a spend that was released is taken again through `spendWallet`. If the balance no longer covers it, nothing is confirmed or delivered, and the card part is refunded under the late-payment rule.
- **UI:** `app/(site)/booking/payment/page.tsx` gets a "Gift card number" field and a "Use my credit (X SAR)" switch when signed in. `payableTotal` subtracts it, and the `nothingToPay` copy stops saying "your membership covers this". The same switch goes on the membership and chair pay pages, not the gift card page.

### Cancellation
- **Customer** (`app/api/my-bookings/cancel/route.ts:141`): `creditCancelled(..., "cancel-customer")` replaces `refundBookings`, inside the transaction of the guarded status update. Copy in `lib/dictionary.ts` (`cancelConfirm`, `cancelConfirmGroup`, `cancelled`, `cancelledNoRefund`) changes from "back to your card" to "to your wallet".
- **Salon** (`setBookingStatus`, `app/(admin)/admin/(shell)/bookings/actions.ts`):
  - the admin form sends the status it showed; the update is `where status = <that status>`, and zero rows back answers "This booking changed. Reload." instead of acting twice;
  - entering `cancelled` requires a reason, and the status change, `creditCancelled(..., "cancel-salon", reason)` and `returnPackCredits` run in **one transaction**, so a crash leaves all or none;
  - leaving `cancelled` is refused while the booking has a cancel credit;
  - inside `cancel_cutoff_hours`: open question 1. Until then it is allowed with a reason.
- **No-show:** `isDead` (`lib/rewards.ts:215`) stops treating `no_show` and no-show-resolved rows as dead, so spent points are kept.
- **Remove** `refundBookings` and the `payments.refund` permission (`lib/auth/rbac.ts:42,70`).

### Gift card delivery and emails
- `deliver()` (`purchase.ts:313`): if `recipientEmail` matches a verified account, claim the card into that wallet right away.
- **Recipient email** (`lib/giftcard/email.ts`), card image always inline:
  - account holder: "Your X SAR gift card from <buyer> is in your Red or Nude wallet."
  - no account: the code, plus "Enter it at checkout. What's left goes to your wallet. Or sign in with this email and it's added now."
- Inline image: `SendMailInput.attachments` gains `cid?`, and nodemailer passes it through. The PNG is fetched from `/api/gift-card-image`, best-effort, falling back to the remote `<img>`.
- **Buyer receipt** says which of the two happened.
- **`lib/wallet-email.ts` → `sendWalletEmail(kind, …)`** on `brandedEmail` + `sendReceipt`:
  - cancel credit (hers and the salon's): this is the missing cancel email;
  - gift card leftover;
  - chair credit;
  - reversal;
  - owner correction.
  - A guest's version adds "Sign in with <email> at /account to use it."
- **`createAccount`** (`lib/account/create.ts`):
  - also moves `wallet_txns` whose `owner_email` matches onto the account;
  - then claims active, unexpired cards sent to that email.

### Account screen
- `app/(site)/account/page.tsx` adds `walletBalance` and the last 10 rows to its `Promise.all`.
- `AccountView.tsx` gets a "Wallet" card for money next to the points card (`Wallet` at :441 is renamed `Points`) and a short history. Strings go in `lib/dictionary.ts` in both languages. The card shows `available`, never a negative number.

### Admin: "Needs your decision"
- An owner-only page listing what the code can't settle alone:
  - a balance below 0 after a reversal;
  - money on a cancelled booking with no customer;
  - a customer saying her email was mistyped (staff add it with the booking code and phone they checked);
  - a revived payment that could not be confirmed or delivered.
- Each item has **Correct**: an amount (+ or −), a required reason, written as a `correction` row and to the audit log, and emailed to her. Marking an item done without a correction also needs a reason.
- Skipped: a read-only balance in the admin customer screen. Add it when support asks.

## Build order
One commit per step, docs in the same commit. Step 3 waits for the VAT answer (open question 2).
1. Migration (guest identity by email, `customer_email`, `wallet_txns`), `lib/wallet.ts`, and its balance and lock tests.
2. Cancellation: customer and salon (one transaction, guarded status, reason, no un-cancel), remove `refundBookings`, no-show points, the cancel email.
3. Booking checkout: code and wallet, quote route, UI.
4. Purchase checkouts: `startPurchase` wallet in one transaction and zero path, two routes, releases, revive re-spend, UI.
5. Gift card delivery claim, `createAccount` claim/merge, inline image, emails.
6. `owedCredit` conversion, `reverseCredit` in `refundedOutside`.
7. "Needs your decision" page and owner correction.
8. PAYMENTS-STATUS.md §2 updated to "built".

## Verification
**Tests** (`tests/wallet.test.ts`, fake driver as in `tests/streampay.test.ts`):
- cancel more than 3 h before → credit = card + wallet spent; a second cancel call → no second credit;
- salon cancel → credit, reason stored; without a reason → refused; no-show → nothing, and points stay spent;
- salon cancel with a stale status (someone changed it meanwhile) → refused, nothing written;
- a crash after the status write in a salon cancel → status rolled back, no credit (all or none);
- cancelled with credit → set back to confirmed is refused;
- card 100 / bill 500 → 400 charged; 250/250 → zero path, confirmed; 500/250 → free, 250 left;
- a bill leaving 0.50 SAR → credit capped, 1 SAR charged;
- **two checkouts at once** (a booking and a membership, 300 SAR balance, 300 each) → one succeeds, one is refused;
- abandoned hold → `release` row, balance back; a guest retyping the code → `claimed-by`;
- **revive after release**: spend released, credit spent on a booking, then the old payment turns up paid → not delivered, card part refunded; with enough balance → re-spent and delivered;
- **shared phone**: Sara books with phone 050 and sara@, cancels; Noura books with 050 and noura@; Noura signs up → Noura has no credit; Sara signs up → she has it;
- signup claims an active card sent to that email and skips an expired one;
- gift card purchase with `wallet` → refused;
- a purchase fully covered by credit → delivered with no StreamPay call; undelivered → `release` row;
- **chargeback** on a payment that funded a cancel credit (found by the daily comparison) → `reversal` row; already spent → available 0, owner alerted; partial refund → reversal of the refunded share;
- a claimed card refunded outside → reversal row + owner alert when below 0;
- owner correction without a reason → refused; with one → row + audit entry;
- `owedCredit` on a `paid` payment converts once; on a `refunded` one it doesn't.

**Checks:** `npx tsc --noEmit`, `npm test`, `next build`.

**Sandbox:** a discounted link's total equals ours; the tax invoice shows the "Wallet credit" coupon; a 1 SAR link is accepted; the gift card email shows the image in Gmail with images off.
