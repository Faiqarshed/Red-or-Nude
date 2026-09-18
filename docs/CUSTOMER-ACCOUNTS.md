# Customer accounts and loyalty — brief §2.8

Email identity, birthday at signup, and a points wallet redeemed against future
payments. Accounts are **optional**: guest checkout is exactly what it was, and
nothing on the booking flow requires signing in.

---

## 1. What changed, in one paragraph

A customer can now sign in with their email and a six-digit code. Doing so gives
them `/account`: every booking they have ever made without typing a reference, a
points balance, and a running reward they can spend at checkout. Points are
earned when a payment clears and spent when a booking is held. The nav's
**Bookings** link becomes **Profile** while signed in, and `/my-bookings`
redirects there.

---

## 2. The screens

| Route | Who | What |
|---|---|---|
| `/account` | anyone | Signed out: the sign-in form (which is also the sign-up form). Signed in: wallet, progress to the next reward, all bookings, profile details, sign out. |
| `/my-bookings` | guests only | Unchanged. A signed-in visitor is redirected to `/account`. |
| `/booking/payment` | anyone | Gains a reward picker, shown only when signed in. |

Header: a **Sign in** button beside the EN/AR toggle **when signed out, and
nothing there when signed in** — signed in it would only duplicate the nav's
Profile entry, and Sign out belongs on `/account` beside the customer's name,
next to the thing it signs out of. The nav's **Bookings** entry becomes
**Profile** while signed in, matched on href so reordering the nav can't swap
the wrong link. See [`components/SiteHeader.tsx`](../components/SiteHeader.tsx).

`/my-bookings` also carries a one-line **Sign in** offer under its heading,
because it can say *why* — every booking and the loyalty points, without a
reference — which a button in the header cannot. A signed-in customer never
sees it; that page redirects them.

---

## 3. Signing in — one screen, deliberately

```
email  ──▶  POST /api/account/otp     ──▶  code emailed
code   ──▶  POST /api/account/verify  ──┬─▶ known address  → session cookie
                                        └─▶ new address    → 15-min ticket
ticket + name + phone + birthday
       ──▶  POST /api/account/register ──▶ session cookie
```

**Sign-in and sign-up are the same form, and that is a security decision.** Two
forms means one of them says *"that email is already registered"* and the other
says *"no account found"* — either sentence lets someone walk a list of
addresses and learn who is a customer of this salon. Here a code goes to any
valid-looking address, and only the person who can read that inbox learns which
case they were in. `/api/account/otp` returns a byte-identical response both
ways, the same discipline as
[`app/api/my-bookings/otp/route.ts`](../app/api/my-bookings/otp/route.ts).

### Why the ticket exists

The code is consumed by its first successful verify, and `customers.phone` is
`NOT NULL` — so a new customer's row cannot be created until the profile
arrives on a *second* request, and that request has to prove the first one
happened. The ticket is a 15-minute token carrying only the verified address. It
is prefixed `signup:` so a **session** token cannot be posted in its place,
which would otherwise let a signed-in customer register an address they never
proved they own.

---

## 4. The security model

**An encrypted JWT in an httpOnly cookie**, minted with `encode`/`decode` from
`next-auth/jwt` — already a dependency, already what the staff side runs on. No
new package, no hand-written crypto, no passwords anywhere.

| | |
|---|---|
| Cookie | `ron_account` — `httpOnly`, `secure` in production, `sameSite: lax`, path `/` |
| Payload | the customer id, and nothing else |
| Encryption | JWE (A256CBC-HS512) from `AUTH_SECRET` + salt `ron_account` |
| Session lifetime | **30 days**, enforced by both `Max-Age` and the token's `exp` |
| Signup ticket | 15 minutes |
| Sign-in code | 10 minutes, single use, 5 attempts, hashed at rest |

`sameSite: "lax"` and not `"strict"`: customers arrive from a link in the code
email, and `strict` would drop the cookie on that navigation.

### Two audiences, two token spaces

`currentStaff()` in [`lib/auth/guard.ts`](../lib/auth/guard.ts) returns *any*
`session.user` as staff, and `/admin` itself carries no capability gate — so a
customer signed into the staff Auth.js instance would land on the staff
dashboard. They are kept apart by **salt**, not merely by cookie name: Auth.js
derives the encryption key from `secret + salt`, so a staff token pasted into
`ron_account` fails to decrypt rather than decoding into something this code
then has to be careful about. **Test that by hand — it takes five seconds.**

### Revocation

- `customers.blocked` — checked on every request in `currentCustomer()`, so a
  blocked customer is signed out on their next click.
- Rotating `AUTH_SECRET` — signs everybody out at once.

There is no sessions table. Every authenticated request loads the customer row
anyway (blocked flag, balance, bookings), so a stateless token costs no extra
query, and the revocation a table would buy is already covered above. The trade
is that a token captured before sign-out still decodes until it expires.

### What was rejected

| Option | Why not |
|---|---|
| Customers on the existing NextAuth instance | The `/admin` problem above. |
| A `sessions` table | Buys revocation we already have; costs a migration, inserts and a cleanup job. |
| Passwords | Not in the brief. Nothing to store, leak, reset, or brute-force separately. |
| Supabase Auth | `@supabase/supabase-js` is here for media storage only. Adopting it for identity means a second user store beside `customers` and its own email delivery, splitting off the branded AR/EN templates. |
| OAuth / social | Not in the brief, and an email is still needed for invoices. |

---

## 5. The wallet

### Earning

On payment confirmation, beside `countPromoUse` in
[`lib/payments/confirm.ts`](../lib/payments/confirm.ts) — never at hold time, so
an abandoned checkout mints nothing. One award per bill, so a group earns once.

The scheme is four settings rows, not a module constant and not a rate:

| Setting | Default | Meaning |
|---|---|---|
| `loyalty_first_sar` | `199` | spend that earns the first award |
| `loyalty_step_sar` | `200` | how much more spend each further award costs |
| `loyalty_step_points` | `50` | points per award, and the unit redemption counts in |
| `loyalty_point_halalas` | `20` | what one point is worth — 50 points is 10.00 SAR |

**Milestones, not a rate.** Awards land at 199, 399, 599 … and a bill *between*
two thresholds earns what the lower one earned. A 350 SAR bill is worth 50
points, not 87, because it has not reached 399. This is the salon's own rule,
stated in their words: "spend 199 and get 50 points, worth 10 riyals — and if a
person spends 350 we still give 50, because they haven't touched 399".

This replaced a linear `loyalty_sar_per_point` divisor feeding a three-rung
percentage ladder (100/200/300 points for 5/10/15% off). Both are gone. A
percentage rung could not answer "what is a point worth" with one number, and a
rate could not be stated to a customer as a target she is approaching — which is
what the account screen now shows, a bar filling toward her next 50.

Every setting is a whole number, and `loyalty_point_halalas` is in halalas
rather than riyals for the reason every other money column is: a fractional
setting is a float sitting in the middle of a money path, waiting to be rounded
the wrong way by someone who forgets. Milestones are counted first and
multiplied second, so there is no division left to round at all.

At the defaults the scheme returns **10 SAR per 200 spent — about 5%**.

**Per bill, not per lifetime.** One award per bill, so a group earns once, tied
to the anchor booking. Two separate visits therefore earn two awards: two 199
SAR visits earn 100 points where one 398 SAR bill earns 50. That is deliberate
and is marked `ponytail:` in [`lib/rewards.ts`](../lib/rewards.ts) — splitting
costs the customer a second appointment in a real chair, so it is a per-visit
scheme rather than a leak. The upgrade path, if the salon ever sees bookings
split to farm points, is lifetime accrual: milestones over total paid, minus
points already granted. Note that needs a join through `bookings` (there is no
`customer_id` on `payments`) and a decision about whose spend a group bill
counts toward.

Earned on what the customer **paid**, not on the bill before discounts —
otherwise a discount would partly pay for itself.

### Spending, and what it costs

Redemption is in **whole steps** — 50, 100, 150 — rather than any number the
customer likes. It keeps the offer describable ("50 points is 10 riyals off"),
and it means a stray `37` from a hand-edited request is refused rather than
priced. `rewardRefusal` names which of the two it was: `unknown` for an amount
that is not a whole step, `locked` for one the balance cannot reach.

`redeemable()` bounds the offer by the bill as well as the balance, because
offering 150 points against a 20 riyal bill is offering to burn 30 riyals of
reward for 20 riyals off. `rewardDiscount` then caps the discount at the bill,
exactly as `promoDiscount` does: a discount larger than the bill is a refund,
and a reward must never hand out money that was never taken.


Opt-in at checkout: the customer ticks one amount or none, exactly as she types
a code or doesn't. Order of operations, and it matters —

```
gross → group/refill discount → promo code → points
```

The reward is quoted against the **post-promo** total in both the preview
(`POST /api/loyalty/quote`) and the charge (`createBookings`), which is what
keeps the number on screen and the number charged identical. Points stack with
promos on purpose: spending them is a thank-you for money already spent, not an
alternative to an offer the customer also qualifies for.

The rules themselves now travel to the browser in the `GET /api/loyalty/quote`
response. They used to be a module constant the checkout imported directly; they
are settings rows so the salon can retune them without a deploy, and the
checkout cannot read the database. The *functions* are still imported straight
from [`lib/rewards.ts`](../lib/rewards.ts) by both sides, which is what keeps the
figure shown and the figure charged computed the same way. None of it is secret
— it is the offer, printed on the page.

Debited **at hold time**, inside the booking transaction. That is the opposite of
how promo uses are counted, deliberately: a promo code is a shared coupon, but
points are a per-customer balance, and deferring the debit would let one
customer hold several bookings in several tabs each claiming the same balance
and confirm them all. The `SELECT … FOR UPDATE` on the customer row is what
serialises it.

---

## 6. How points come back — read this before changing anything

**There is no code that refunds points, and there must not be.** The balance is
a *liveness-filtered* sum over the ledger:

```sql
select coalesce(sum(delta_points), 0)
  from loyalty_txns lt
  left join bookings b on b.id = lt.booking_id
 where lt.customer_id = $1
   and (lt.booking_id is null
        or (    b.status not in ('cancelled', 'no_show')
            and not (b.status = 'pending'
                     and b.created_at < now() - make_interval(mins => $hold))))
```

Every way a booking can die therefore returns its points with no write anywhere:

| What happened | Booking ends up | Released by |
|---|---|---|
| Customer cancels | `cancelled` | the status clause |
| Hold abandoned, sweep ran | `cancelled` | the status clause |
| **Payment declined, customer walks** | stays `pending` | **the clock clause** |
| **Gateway threw / charge failed** | stays `pending` | **the clock clause** |
| No-show after payment | `no_show` | the status clause |
| Paid booking cancelled later | `cancelled` | the status clause — earned points revoked too |

The clock clause is the one that is easy to miss. A declined payment
**deliberately** leaves its bookings `pending` so the customer can retry without
re-picking a slot, and `sweepExpiredHolds` only runs when some *other* customer
tries to book. Without a clock here, points spent on a declined payment would
stay locked until an unrelated stranger happened to book at the same branch.

> **Never make the balance depend on the sweep having run.**

A customer who retries a declined card inside the window keeps the same booking,
the same debit and the same discount. That is correct, not a leak.

The rule is written twice — once as SQL in `loyaltyBalance()` and once as pure
TypeScript in `spendableBalance()`. **If you change one, change the other**, and
extend `scripts/check-loyalty.ts`, which asserts every row of the table above.

---

## 7. Schema

`drizzle/0011_customer_accounts.sql`, hand-written because drizzle-kit reads the
`otps` change as a drop-and-create unless told interactively that it is a rename
— and a drop would throw away every sign-in code in flight.

- **`booking_otps` → `otps`**, keyed on a free-text `subject`
  (`booking:<uuid>` or `email:<address>`), so account sign-in reuses the same
  hashed / single-use / five-attempt rules instead of a second copy of
  security-critical code.
- **`customers`** gains `birthday` (a `date`, no time and no timezone — storing a
  birthday as an instant is how a Riyadh birthday lands a day early) and
  `email_verified_at`, which **is** the account flag. There is no accounts table.
- **`customers_account_email_unique`** — unique on `lower(email)`, but **partial**
  on `email_verified_at IS NOT NULL`. Checkout upserts on phone and writes
  whatever address was typed, so the same address legitimately lands on two rows
  when someone books from two numbers; a blanket unique index would turn that
  into a failed booking. Only real accounts need to be unique.
- **`loyalty_txns`** — the ledger. Deliberately **no running-balance column**, so
  the balance cannot drift from its own history, and so §6 works at all.

---

## 8. How to break it

The things most worth attacking, and what should happen.

| Attempt | Expected |
|---|---|
| Post a `customerId` in the `/api/bookings` body | Ignored — the session cookie is the only source. |
| Post `redeemPoints: 500` with a balance of 0 | `400 reward-invalid`, `rewardReason: "locked"`. The hold is refused, not priced wrong. |
| Post `redeemPoints: 37` (not a whole step) | `400 reward-invalid`, `rewardReason: "unknown"`. |
| Post `redeemPoints: 50.5` or `-50` | `400 reward-invalid`, `rewardReason: "unknown"` — refused before it is priced. |
| Tick 100 points against a 5 SAR bill | Never offered (`redeemable` bounds by the bill), and capped at 5 SAR if forced. |
| Paste the staff `authjs.session-token` into `ron_account` | Refused — different salt, fails to decrypt. |
| Edit a byte of `ron_account` | Refused, signed out. |
| Post a **session** token as a signup `ticket` | `401 ticket-expired` — the `signup:` prefix is checked. |
| Request codes for 100 addresses | Throttled per IP, and the response never differs between a known and an unknown address. |
| Request 10 codes for one address | Throttled per address; only the newest code works — issuing invalidates the previous one. |
| Guess a code six times | Burned after five attempts; a new one must be requested. |
| Block a customer mid-session | Signed out on their next request. |
| Hold two bookings in two tabs, both spending the whole balance | The second is refused — the customer row lock serialises them. |
| Sign up with a phone that already has a *different* verified email | `409 phone-in-use`. One person, one account. |

### Known ceilings

- A guest who books under phone A and later signs up with phone B ends up with
  two rows, and the older bookings stay off the account. Merging is real work
  for an edge case nobody has hit — revisit if support asks.
- The cancel / reschedule / refill routes still authenticate on the booking
  reference even for a signed-in customer, so the refill dialog still emails a
  code to someone who is already signed in. Accepting the session as a second
  credential is tidier but means a second auth path through three routes for no
  behaviour the customer can see.
- Rate limits are the in-memory ones from `lib/throttle.ts`: per serverless
  instance, reset on cold start. Enough to stop a script.

---

## 9. Testing

`npm run check:loyalty` — pure, no database, no network. Asserts the earn maths
and its flooring, every unlock boundary, the discount cap, and **every row of
the death-path table in §6**. That last group is the one that guards the
promise that points always come back.

The manual walkthrough is in [`docs/ACCOUNTS-TESTING.md`](./ACCOUNTS-TESTING.md).
