# Known bugs — booking lifecycle and admin access

Found by `tests/lifecycle/`. Reported first, fixed on the owner's instruction.

---

## BUG-LIFE-001 — the dev login bypass is gated on `NODE_ENV`, not on an opt-in  ·  P2  ·  FIXED 2026-09-03

**Where** `lib/auth/guard.ts:20-35` (`devFallbackStaff`)
**Test** `tests/lifecycle/status.test.ts` — "hands an unauthenticated caller the
CEO when NODE_ENV is not production" (characterization, passing).

### What it does

`currentStaff()` falls back to `devFallbackStaff()` for any request with no
session. That function returns early **only** when `NODE_ENV === "production"`;
otherwise it selects the seeded CEO — or any active staff row — and hands it
back as the session. Every `requireCan` downstream then passes.

An unauthenticated `POST` to any admin Server Action therefore succeeds as CEO.
Proven in the test above: with no session at all, `setBookingStatus` returns
`{ ok: true }`.

### Why the comment is not quite right

The function is documented as "Local dev only (`next dev`; never true for
`next start`/deployed builds)". That holds only because `next start` sets
`NODE_ENV=production` itself. It is a property of the Next CLI, not of this
code. Anything that runs the app with `NODE_ENV` unset, `development`,
`staging`, or `test` — a self-hosted staging box, a Docker image with a custom
entrypoint, a `tsx`/`node` server, a preview harness — gets a full admin panel
that needs no login.

### Severity

P2 rather than P0: the deployment target is Vercel (`vercel.json`), which builds
and runs with `NODE_ENV=production`, so the shipped configuration is safe today.
It is one environment variable away from not being.

The safer shape is an explicit opt-in — `ADMIN_DEV_LOGIN=1` and a
`NODE_ENV !== "production"` check together — so the bypass has to be asked for
rather than merely not-prevented.

### Testing consequence, worth knowing

Under vitest `NODE_ENV` is `"test"`, so **any "signed out is refused" assertion
passes for the wrong reason unless the test stubs `NODE_ENV`.** Both suites that
touch admin actions do stub it — see `tests/admin/helpers.ts:74-85`, which
documents this, and `tests/lifecycle/status.test.ts`. Anyone adding a new
authorization test must do the same or they are asserting nothing.

### The fix, 2026-09-03

Both conditions now have to hold: a non-production build **and**
`ADMIN_DEV_LOGIN=1`, set by hand. A machine that has not opted in cannot be
opted into by accident, and forgetting the variable produces a login screen
rather than an open one. Added to `.env.example` with a warning against setting
it on a deployed box. The testing consequence below is unchanged and still
applies — an authorization test that does not stub `NODE_ENV` still asserts
nothing.

---

## Verified sound — recorded so it is not re-litigated

- **`refuseBookingAction` enforces ownership, not merely a session.** An
  attacker signed in as themselves cannot act on a victim's booking whose
  reference they hold; a code issued for one booking does not open another; a
  blocked customer loses the power immediately. All asserted.
- **The cancellation window is closed exactly on the deadline** and never open
  and closed in the same millisecond. Each refusal reason is distinct, so the
  API does not tell someone who already cancelled that their window closed.
- **`POST /api/my-bookings` leaks no name, phone or email**, which is what makes
  the open read safe. Asserted by searching the serialized response for each.
- **`setBookingStatus` allows out-of-order corrections deliberately.** No
  transition-legality matrix was written, because the code explicitly calls
  those corrections "the owner's call". What is asserted instead: the
  capability split, the `too-early` check-in guard, and that re-saving a status
  does not reset the clock the commission figures are read from.
