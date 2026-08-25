# Customer accounts and loyalty — brief §2.8

Email identity, birthday at signup, and a points wallet redeemed against future
payments. Accounts are **optional**: guest checkout is exactly what it was, and
nothing on the booking flow requires signing in.

---

## 1. What changed, in one paragraph

A customer can now sign in with their email and a six-digit code. Doing so gives
them `/account`: every booking they have ever made without typing a reference, a
points balance, and a ladder of rewards they can spend at checkout. Points are
earned when a payment clears and spent when a booking is held. The nav's
**Bookings** link becomes **Profile** while signed in, and `/my-bookings`
redirects there.

---

## 2. The screens

| Route | Who | What |
|---|---|---|
| `/account` | anyone | Signed out: the sign-in form (which is also the sign-up form). Signed in: wallet, reward ladder, all bookings, profile details, sign out. |
| `/my-bookings` | guests only | Unchanged. A signed-in visitor is redirected to `/account`. |
| `/booking/payment` | anyone | Gains a reward picker, shown only when signed in. |

Header: **no account button.** The nav's **Bookings** entry becomes **Profile**
when signed in — matched on href, so reordering the nav can't swap the wrong
link — and the right-hand side carries only the EN/AR toggle in both states. See
[`components/SiteHeader.tsx`](../components/SiteHeader.tsx).

That leaves `/my-bookings` as the only route into an account from the site
chrome, which is why it carries a one-line **Sign in** offer under its heading.
It is the right place for it: a signed-out customer hunting for their bookings
lands there, and a signed-in one never sees it.

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

`loyalty_sar_per_point` (default `5`) is how many riyals buy one point. A
**divisor, not a multiplier**, deliberately: points are whole numbers
everywhere — an integer column, an integer balance, an integer on screen — and
the only way to earn less than a point per riyal with a multiplier is a
fractional setting like `0.2`. A float sitting in the middle of a money path is
a rounding bug waiting for someone who forgets. Dividing by an integer and
flooring cannot produce one, and `scripts/check-loyalty.ts` sweeps a range of
bills and divisors asserting the result is always a whole number.

**Floored, never rounded**: at 5 SAR a point, a 9.99 SAR bill earns 1, not 2.
Rounding up is a mint anyone can run by splitting a bill.

Earned on what the customer **paid**, not on the bill before discounts —
otherwise a discount would partly pay for itself.

### The ladder

| Points | Reward | Roughly |
|---|---|---|
| 100 | 5% off | ~500 SAR of custom |
| 200 | 10% off | ~1000 SAR |
| 300 | 15% off | ~1500 SAR |

**Linear on purpose: every 100 points is another 5%.** The first cut was
100/250/500 for 5/10/15%, which quietly punished loyalty — value per point is
`percent ÷ points`, so those rungs ran 0.050, 0.040, 0.033 and the dearest
reward was the *worst* deal. A customer who saved for the top rung was worse off
than one who spent at the bottom rung three times. A ladder must never make
climbing it the losing move, and the check script now asserts that value per
point never falls as the rungs rise.

At these numbers the scheme returns roughly **1.5%** of spend. Generosity is one
integer — `loyalty_sar_per_point` — and it needs no deploy.

A module constant in [`lib/loyalty.ts`](../lib/loyalty.ts), not a settings row —
`settings.value` is jsonb so a ladder would fit, but `SETTING_DEFAULTS` is a flat
map of primitives and this changes about as often as the price list. Move it if
marketing wants to retune rungs without a deploy.

### Spending

Opt-in at checkout: the customer ticks one rung or none, exactly as they type a
code or don't. Order of operations, and it matters —

```
gross → group/refill discount → promo code → reward percentage
```

The reward is quoted against the **post-promo** total in both the preview
(`POST /api/loyalty/quote`) and the charge (`createBookings`), which is what
keeps the number on screen and the number charged identical. Rungs stack with
promos on purpose: a rung is a thank-you for money already spent, not an
alternative to an offer the customer also qualifies for.

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
| Post `redeemPoints: 300` (between rungs) | `400 reward-invalid`, `rewardReason: "unknown"`. |
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
