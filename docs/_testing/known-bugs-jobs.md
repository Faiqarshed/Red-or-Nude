# Known bugs — scheduled jobs

Found by `tests/jobs/`. Reported first, fixed on the owner's instruction.

---

## BUG-JOBS-001 — `staff-codes` is never scheduled, so no staff code is ever issued  ·  P2  ·  FIXED 2026-09-03

**Where** `vercel.json:4` versus `app/api/cron/staff-codes/route.ts:3-4`
**Test** `tests/jobs/cron-auth.test.ts` — "schedules staff-codes on the 1st, as
its comment instructs" (`it.fails`).

The route's own header comment gives the entry to add, verbatim:

```
// Schedule this for the 1st of the month in vercel.json:
//   { "crons": [{ "path": "/api/cron/staff-codes", "schedule": "0 1 1 * *" }] }
```

`vercel.json` contains one cron entry, for `assign-day`. The job is guarded,
idempotent, tested and reachable — and nothing has ever called it in production.

The effect: the per-employee monthly ~90% discount codes of brief §3.3 are never
minted. Nobody gets an error; the feature is simply silent. That is the failure
mode worth naming — an unscheduled job looks identical to a job with nothing to
do.

**Fix** is one line in `vercel.json`. Left undone because changing deployment
configuration is not a test's call, and because Vercel's Hobby plan allows a
limited number of cron entries — whoever adds it should check that budget
against `tech-reminders` below.

### The fix, 2026-09-03

The entry the route's comment specifies, added to `vercel.json` verbatim:
`{ "path": "/api/cron/staff-codes", "schedule": "0 1 1 * *" }`. The test asserts
both the entry and the exact schedule, so the two cannot drift apart again.

For whoever manages the Vercel plan: that is the second cron entry, and
`tech-reminders` still wants a quarter-hourly run that no plan tier offers.

---

## Not bugs, recorded so they are not re-investigated

Two other jobs are also unscheduled, and both say so in their own header
comments. The test encodes each route's stated intent rather than a blanket
"everything must be scheduled" rule, so these do not fail:

- **`refill-reminders`** — *"Nothing schedules this yet — it sends through the
  notify seam, which is a log driver until a real provider is configured, so
  there is nothing to schedule for."* Correct: scheduling it today would loop
  over customers and write log lines.
- **`tech-reminders`** — *"NOT scheduled in vercel.json. It wants a
  quarter-hourly run, and Vercel's Hobby plan refuses any cron more frequent
  than once a day."* Correct, and the comment names the alternatives (GitHub
  Actions, cron-job.org, an owned box).

Also checked and sound:

- **All four jobs fail closed when `CRON_SECRET` is unset.** An empty secret
  refuses every caller rather than opening the gate — asserted per job.
- **The guard rejects** a missing header, a wrong secret, an empty bearer token,
  the bare secret without the `Bearer` scheme, the secret in a different header,
  a lowercase `bearer` scheme, and the CVE-2025-29927 `x-middleware-subrequest`
  bypass header. And it accepts a correctly authorised call — a guard that
  refuses everyone is also broken.
- **The scheme comparison is case-sensitive**, which RFC 7235 says it should not
  be. Pinned rather than reported: refusing too much is the safe direction here,
  and the only caller is a scheduler configured by hand.
- **Trailing whitespace in the header is not a bypass.** `Bearer <secret> `
  compares equal because HTTP field values are trimmed of optional whitespace
  before the handler ever sees them — platform behaviour, not app behaviour.
- **The route directory is enumerated in the test**, so a fifth cron job added
  without the guard fails "is exactly the four this file knows about" rather
  than shipping untested.
