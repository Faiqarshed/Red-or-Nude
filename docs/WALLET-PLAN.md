# Wallet plan

## Context
Once a booking is confirmed, money never goes back to the card. It becomes **wallet credit** (decided in PAYMENT-HARDENING-PLAN.md, "Refund rule"). Gift cards also become wallet credit. Today:
- no money wallet exists (the /account "wallet" holds loyalty points);
- her own cancel still refunds the card (`refundBookings`);
- a salon cancel moves no money;
- nothing can spend a gift card: `adjustGiftCardBalance` is called only by the admin adjust action.

Goal: one wallet per customer. It is filled by cancellations, gift cards and small chair refunds, and spent at every checkout. A guest's credit waits on her customer row until she signs in with her email.

Fixed decisions:
- **Spent at every checkout:** bookings (with their chair add-ons), memberships, buying gift cards, chair QR purchases.
- **Never expires.** An unclaimed gift card keeps its own `expiresAt`. Once claimed into the wallet, the credit never expires.
- **Guest = claim by signing in.** We never mark an email verified without the code. Her credit sits on her customer row, tagged with her email. The first sign-in with that email (`createAccount`) moves it to the account.
- **Gift card email:** the brand card image goes inline (cid attachment), so it shows without "load images".
- **Admin cannot edit the balance.** No action or screen writes to the ledger by hand.

## How money enters and leaves

| Event | Wallet |
|---|---|
| She cancels more than 3 h before | **+** card paid on that booking + wallet spent on it |
| Salon cancels more than 3 h before | **+** same amount |
| Either cancels within 3 h | Not allowed (customer: already enforced; admin: new refusal) |
| No-show (`resolveNoShow`, marked no-show) | Nothing. Spent points are not returned either |
| Gift card bought for an email that has an account | **+** full card value on delivery. The card becomes `redeemed` |
| Gift card code entered at checkout | **+** the card's whole balance, then spent on the bill. Anything left stays in the wallet |
| Gift card's email signs up later | **+** every active card sent to that email is claimed at `createAccount` |
| Chair purchase of 10 SAR or less we couldn't deliver | **+** amount (turns `owedCredit` into credit) |
| Gift card refunded in StreamPay's dashboard after it was claimed | **−** the claim. If already spent, the balance goes negative and the owner is alerted |
| Checkout uses credit | **−** min(credit, bill), kept so at least 1 SAR is left to charge or the bill is fully covered |
| Checkout abandoned, declined, or hold lapsed | The spend stops counting (ledger rule, no write) |

Examples:
- Card 100, bill 500: 100 off, 400 charged.
- Card 250, bill 250: nothing charged, booking confirmed on the zero-bill path.
- Card 500, bill 250: free, and 250 left in the wallet. A guest gets an email: "250 SAR is in your Red or Nude wallet. Sign in with <email> to use it."

## Gaps found in the code (and how each is closed)
1. **No way to spend a gift card.** Closed by the claim-into-wallet step at checkout. `adjustGiftCardBalance` (`lib/giftcards.ts:124`) doesn't check `status` or `expiresAt`, so the claim checks both.
2. **No cancellation email exists.** `notifyCustomer("booking-cancelled")` only logs to the console (`lib/notify/log.ts`). A real email is added.
3. **Guest row email is overwritten.** One guest row per phone, and each guest booking overwrites its email (`createBookings`, `lib/bookings.ts:1155-1187`). Credit tied only to the row could reach whoever booked last with that phone. Closed: every wallet row on a guest row stores `owner_email`, and `createAccount` moves rows by that email, not the row's.
4. **A no-show also ends at `cancelled`** (`resolveNoShow`, `bookings/actions.ts:283`). Credit is never derived from the status. Only the two cancel paths write it.
5. **`bookings.customerId` can be null** (walk-in, deleted customer). Walk-ins have no payment, so the amount is 0. Money on a customer-less booking calls `alertOwner` instead of crediting.
6. **Purchases have no zero-bill path.** `startPurchase` always calls StreamPay. A zero path like `confirmBookingPayment`'s (`lib/payments/confirm.ts:217`) is added.
7. **`refundPaid` refuses a 0 total** (`refund.ts:101`). An undelivered purchase paid fully by credit is marked `refunded` without StreamPay, which releases the spend.
8. **Guest abandons after entering a code.** The card is already in her wallet. Typing the code again answers: "This card is in the wallet of <m***@mail>. Sign in with that email to spend it."
9. **StreamPay minimum:** a link under 1 SAR after coupons is untested (PAYMENTS-STATUS ~L422). Credit is capped so at least 1 SAR remains, unless it covers the whole bill.
10. **The gift card image is a remote URL and always brand red.** It is attached inline instead. The chosen design stays unsupported (INVOICE-EMAIL.md §8).
11. **Accountant (blocking go-live, not the build):** (a) Gift card money was VAT-exempt at sale. Spending it as a StreamPay coupon reduces the taxable amount. Is that right, or must it be a payment method? (b) Does cancellation credit need a credit note? (c) Buying a VAT-exempt gift card with credit.

## Design

### Data (migration 0031)
- `wallet_txns`: `id`, `customer_id` (fk customers), `owner_email` (lowercased, set on guest rows), `delta_halalas` int (non-zero), `reason` (`cancel-customer | cancel-salon | gift-card | gift-card-reversed | chair-credit | spend`), `booking_id`, `payment_id`, `gift_card_id`, `created_at`.
  - Partial unique indexes make every write idempotent, following the `pack_txns_return_unique` pattern (`schema.ts:1050`):
    - one cancel credit per booking;
    - one spend per booking;
    - one spend per purchase payment;
    - one claim and one reversal per gift card;
    - one chair credit per payment.
- `bookings.wallet_discount_halalas` int default 0, stored per member row like `points_discount_halalas`.
- Card claim: set the card to `redeemed` with balance 0, and add a `gift_card_txns` row (`reason: "to-wallet"`, `bookingId` when claimed at checkout). No new gift card column.

### `lib/wallet.ts` (one file)
- `walletBalance(customerId, executor?)`: SUM(delta), read the way `loyaltyBalance` / `packCredits` read. A `spend` row stops counting when its booking was never paid, using the `neverRedeemed` rule (`lib/packs.ts:66`): `payment-timeout`, or pending past its hold with no open checkout. For a purchase spend: payment `failed`/`refunded`, or pending past `PAY_WINDOW_MIN` with no link. The rule is a pure function with one copy, as in packs/rewards.
- `claimGiftCard(tx, code, customerId, ownerEmail)`:
  - lock the card;
  - require `active`, not expired, balance > 0;
  - insert `+balance` and zero the card.
  - A card already claimed returns `claimed-by` with a masked email (gap 8).
- `creditCancelled(tx, bookingIds, reason)`: amount per booking = `paidOn` (export it from `lib/payments/refund.ts`) + `wallet_discount_halalas`. Null customer with money → `alertOwner`.
- `reverseGiftCardClaim(tx, giftCardId)`: called from `refundedOutside` (`refund.ts:245`) next to the card freeze.
- `creditOwedChair(ref)`: `refundOrCredit` (`purchase.ts:268`) credits now instead of marking. A one-off pass converts existing `owedCredit` rows **only where the payment is still `paid`**, and emails her.

### Checkout
- **Bookings.** `/api/bookings` takes `giftCardCode?` and `useWallet?`. In `createBookings`' transaction, after points (`lib/bookings.ts:1322`), under the existing customer row lock:
  1. claim the code if one was given;
  2. spend `min(available, remaining bill)`. Signed in, `available` is the whole balance. For a guest it is only what this code just brought in.
  3. apply the 1 SAR cap;
  4. split the spend across member rows and write the `spend` rows.
  - `bookingLines` (`lib/payments/lines.ts:35`) adds a discount "Wallet credit". A bill fully covered goes down the existing zero path.
- **Preview:** `/api/wallet/quote` (modelled on `/api/loyalty/quote`) returns the balance and the value of a typed code, **without claiming**.
- **Purchases** (`startPurchase`, `lib/payments/purchase.ts:88`):
  - takes `wallet?: { customerId, halalas }`, **signed-in only**, and writes the `spend` row with `payment_id` in the same transaction as the pending payment insert;
  - passes `discounts: [{ label: "Wallet credit", halalas }]`;
  - adds a zero-bill path.
  - Routes: `app/api/gift-cards`, the membership/pack route, the chair treat route (QR alone is not identity).
  - A gift card code at a purchase checkout is also signed-in only. Guests can't hold a leftover there: a gift card buyer has no customer row.
- **UI:** `app/(site)/booking/payment/page.tsx` gets a "Gift card number" field and a "Use my credit (X SAR)" switch when signed in. `payableTotal` subtracts it, and the `nothingToPay` copy stops saying "your membership covers this". The same switch goes on the gift card, membership and chair pay pages.

### Cancellation
- **Customer** (`app/api/my-bookings/cancel/route.ts:141`): `creditCancelled(..., "cancel-customer")` replaces `refundBookings`, inside the transaction of the guarded status update. Copy in `lib/dictionary.ts` (`cancelConfirm`, `cancelConfirmGroup`, `cancelled`, `cancelledNoRefund`) changes from "back to your card" to "to your wallet".
- **Salon** (`setBookingStatus`, `app/(admin)/admin/(shell)/bookings/actions.ts:116-133`): refuse a cancel inside `cancel_cutoff_hours` with `cancelRefusal` (`lib/cancellation.ts:58`). Otherwise `creditCancelled(..., "cancel-salon")`, next to `returnPackCredits`.
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
  - card reversal.
  - A guest's version adds "Sign in with <email> at /account to use it."
- **`createAccount`** (`lib/account/create.ts:60-62`):
  - also moves `wallet_txns` whose `owner_email` matches;
  - then claims active, unexpired cards sent to that email.

### Account screen
- `app/(site)/account/page.tsx` adds `walletBalance` and the last 10 rows to its `Promise.all`.
- `AccountView.tsx` gets a "Wallet" card for money next to the points card (`Wallet` at :441 is renamed `Points`) and a short history. Strings go in `lib/dictionary.ts` in both languages.
- Skipped: a read-only balance in the admin customer screen. Add it when support asks.

## Build order
One commit per step, docs in the same commit.
1. Migration, `lib/wallet.ts` and its balance rule test.
2. Cancellation: customer and salon, remove `refundBookings`, no-show points, the cancel email.
3. Booking checkout: code and wallet, quote route, UI.
4. Purchase checkouts: `startPurchase` wallet and zero path, three routes, UI.
5. Gift card delivery claim, `createAccount` claim/merge, inline image, emails.
6. `owedCredit` conversion, `refundedOutside` reversal.
7. PAYMENTS-STATUS.md §2 updated to "built".

## Verification
**Tests** (`tests/wallet.test.ts`, fake driver as in `tests/streampay.test.ts`):
- cancel more than 3 h before → credit = card + wallet spent; a second cancel call → no second credit;
- admin cancel inside 3 h → refused; outside → credit; no-show → nothing, and points stay spent;
- card 100 / bill 500 → 400 charged; 250/250 → zero path, confirmed; 500/250 → free, 250 left;
- a bill leaving 0.50 SAR → credit capped, 1 SAR charged;
- abandoned hold → spend released, balance back; a guest retyping the code → `claimed-by`;
- a guest with the same phone and a new email → the old email's credit doesn't follow the row; signup with the old email gets it;
- signup claims an active card sent to that email and skips an expired one;
- a purchase fully covered by credit → delivered with no StreamPay call; undelivered → spend released;
- a claimed card refunded outside → reversal row + owner alert when negative;
- `owedCredit` on a `paid` payment converts once; on a `refunded` one it doesn't.

**Checks:** `npx tsc --noEmit`, `npm test`, `next build`.

**Sandbox:** a discounted link's total equals ours; the tax invoice shows the "Wallet credit" coupon; a 1 SAR link is accepted; the gift card email shows the image in Gmail with images off.
