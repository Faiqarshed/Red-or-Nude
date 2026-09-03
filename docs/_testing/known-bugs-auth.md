# Known bugs — auth and accounts

Found by `tests/auth/`. Reported first, fixed only on the owner's instruction —
a test that finds a real bug is never quietly edited to pass. BUG-AUTH-001 was
fixed on 2026-09-03, in its own commit, after the behaviour had been
demonstrated and the design agreed. Both are now fixed.

---

## BUG-AUTH-001 — account takeover via the register route  ·  **P0**  ·  FIXED 2026-09-03

**Where** `app/api/account/register/route.ts:70-125`
**Test** `tests/auth/accounts.test.ts` — "refuses a phone whose row already has a
different verified address", plus three more covering the untouched victim row,
the withheld session cookie, and two signups racing for one guest number.
**Demo** `npx tsx --conditions=react-server scripts/prove-takeover.ts`

### The attack

1. The attacker proves an inbox they own — `attacker@example.test` — through the
   ordinary OTP flow, and gets a 15-minute signup ticket.
2. They POST to `/api/account/register` with that ticket, any name, and **the
   victim's phone number**. Nothing else.
3. The response is `200 {"ok":true}` and they are handed a session cookie.

The victim's row is now:

| column | before | after |
|---|---|---|
| `name` | Victim | Attacker |
| `email` | victim@example.test | attacker@example.test |
| `email_verified_at` | *(set)* | *(reset to now)* |
| `id` | unchanged | **unchanged** |

Because the id is unchanged, the attacker inherits everything hanging off it:
booking history, the loyalty ledger (`loyalty_txns.customer_id`), saved
birthday, notes. The victim cannot sign in — their address is no longer on any
row — and the OTP route will happily mint them a *new* empty account.

The only secret required is a phone number, which is not a secret.

### Why the existing guard does not fire

The route expects the database to stop this. Its catch block reads:

```ts
} catch (err) {
  // Almost certainly the partial unique index: this phone's row already
  // carries a *different* verified address. One person, one account.
  return NextResponse.json({ error: "phone-in-use" }, { status: 409 });
}
```

`customers_account_email_unique` (`lib/db/schema.ts:361`) is
`unique (lower(email)) where email_verified_at is not null`. It forbids **two
rows** holding the same verified address. It cannot see a **single row's**
address being changed to one nobody else holds — so the `onConflictDoUpdate`
succeeds, nothing throws, and the 409 is unreachable by this path.

The pre-flight check above it (`already-registered`, line 62) asks whether the
*attacker's* address is taken. It never asks what the phone's row already is.

### The fix, 2026-09-03

The phone number is treated as a **label**, not a key. Nothing on the route
proves the caller owns it — they typed it — so it may claim a guest row and may
never open a row that already belongs to somebody.

Two parts, because a check alone would race:

1. Before the upsert, refuse when the number already belongs to a row with
   `email_verified_at` set. This produces the `phone-in-use` 409 that was
   already written and unreachable.
2. `setWhere: isNull(customers.emailVerifiedAt)` on the `onConflictDoUpdate`.
   Postgres evaluates it against the conflicting row while holding it, so two
   concurrent signups for one number cannot both pass. When it declines,
   nothing is returned and the route answers 409 rather than dereferencing an
   undefined row.

**When SMS OTP lands** (brief §2.8 calls it a later upgrade) this inverts and
three things must move together, or the hole reopens facing the other way. They
are written out in full in the route's own comment: the check follows whichever
channel was *proved* rather than following the phone column; an account must
always keep at least one proved channel, so a recycled number can only be
released from an account that has a verified address; and the unproved channel
returns to being a label, reserving nothing, because locking one lets a stranger
squat somebody's number.

### Still open — the guest row

A number attached to a *guest* row (someone who gave it at the desk and never
made an account) can still be claimed by a stranger, who inherits that guest's
walk-in bookings. Much smaller than the takeover — no account, no login, no
sign-in stolen — and it is the same behaviour that makes the legitimate case
work: a walk-in who later signs up online keeps her history.

Three ways to close it if it ever matters: drop the guest merge entirely
(costs the feature), require staff confirmation to merge, or verify the phone
by SMS. Deliberately left as-is, decided 2026-09-03.

#### In plain words: why one code is a hole and two codes are a cost

Think of a customer's row as a door with two keys on it: an **email** and a
**phone number**.

Today only the email is a real key — you have to prove it with a code. The phone
is a name tag: you type it and nobody checks.

| What is code-checked | What you get |
|---|---|
| Email only (**today**) | The phone is the way in. Type someone's number, take their row. |
| Phone only | The email becomes the way in. Same hole, other side. |
| **Both** | Closed. The cost is that signing up now needs two codes. |
| Neither | Anyone can be anyone. |

**Example.** Noura walks into the salon and gives her number at the desk. She
never makes an account. A stranger signs up online, proves *his own* inbox with
a code, and types **Noura's number** in the phone box. He now sees the two
appointments Noura had. He does not get an account of hers — she never had one —
but her history is his.

**The trap is doing half of it.** If SMS is added and the phone becomes the
proved key, but the typed email is still allowed to find an existing row, the
same thing happens the other way round: prove any phone, type the victim's email
address, take the row. So the rule has to be *whichever one you proved is the
only one allowed to find an existing customer* — the check follows the code, not
the column. That is what the three numbered points in the route's own comment
(`app/api/account/register/route.ts:92-105`) exist to say.

**And one more, even with both.** A phone number can be given to somebody else
later. Whoever holds Noura's old number and proves it still gets her walk-in
history, because a guest row has nothing else on it to fall back on. Two codes
close the guessing; nothing closes recycling except a second proved channel, and
a walk-in row has none.

So the decision is: **one code and a small hole, or two codes and the friction**.
Today it is one code, on purpose, and this is the hole it leaves.

### Note

The upsert-on-phone is deliberate and documented — a guest who booked from a
number keeps their history when they later sign up. That behaviour is right and
is covered by a passing test. What is missing is the case where the row being
claimed **already belongs to a verified account**.

---

## BUG-AUTH-002 — a mistyped phone number is silently truncated  ·  P3  ·  FIXED 2026-09-03

**Where** `lib/phone.ts:29-37`
**Test** `tests/auth/accounts.test.ts` — "silently truncates a phone number with
extra digits on the end" (characterization, passing).

`toNationalDigits` ends with `d.slice(0, NATIONAL_LENGTH)`, and the comment says
trailing digits are "dropped rather than silently reordered". Dropping them is
still silent: `05120000119999` registers as `0512000011` with a `200`, and that
is the number the salon will ring and the OTP will go to. Reordering would be
worse; refusing would be right.

Low severity on its own. It sharpens BUG-AUTH-001, though — an attacker does not
need the victim's number exactly, only a string that truncates to it.

### The fix, 2026-09-03

The 9-digit cap now lives only on the *field*. `toNationalDigits` still
truncates, because PhoneField calls it on every keystroke and a customer must
see what will be stored. `validateSaudiMobile` no longer inherits that cap: it
counts the digits actually supplied and returns `length` for ten or more. An API
caller posting raw JSON that no field ever truncated now gets a 400 instead of a
different number from the one they sent. `scripts/check-fields.ts` asserted the
old behaviour and was updated with it.

---

## Not bugs, recorded so they are not re-investigated

- **Wrong-code reasons are distinguishable** (`no-code` / `wrong` /
  `too-many-attempts`). Deliberate, and `lib/otp.ts:118` explains why: they are
  distinguishable *to someone who already read the code from the inbox*, which
  is not an enumeration oracle. `/api/account/otp` is the enumeration surface
  and it does answer identically for known and unknown addresses — asserted.
- **A burnt code reports `no-code`, not `too-many-attempts`,** from the sixth
  attempt onward. Burning sets `consumed_at`, and the lookup filters on it, so
  there is no longer a live row to report attempts for. Correct; the test asserts
  the fifth attempt is the one that says `too-many-attempts`.
