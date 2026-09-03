# Brief for every hardening agent

Read this and `docs/_testing/glossary.md` before writing a line. Phase numbers
refer to the `nextjs-drizzle-hardening` skill, which you must invoke first.

## The stack is already decided and already works

Do not choose one, do not install anything, do not propose PGlite.

- **Vitest**, `npm test` → `vitest run`. Config at `vitest.config.mts`.
- **Real local Postgres**, `red_or_nude_test`, already migrated with 34 tables.
- `tests/setup.ts` imports `scripts/_test-db.ts` before any test module loads.
  That gate refuses to run unless `TEST_DATABASE_URL` is on this machine and
  names a database ending in `_test`, then rewrites `DATABASE_URL` to it.
- `resolve.conditions: ["react-server"]` is set, which is what makes
  `server-only` and `next/headers` importable. Same as the `--conditions`
  flag the `check:*` scripts pass.
- `fileParallelism: false` — one shared database.

`tests/harness.test.ts` proves all of the above. It passes. If your tests fail,
it is your test or the source, not the plumbing.

## Files you must not touch

Eight agents are working in this repo at once. Editing any of these causes a
conflict that costs everyone:

- `package.json`, `package-lock.json`
- `vitest.config.mts`, `tests/setup.ts`, `tests/helpers/fixtures.ts`
- `tests/harness.test.ts`
- `docs/_testing/glossary.md`, this file
- **Any application source file.** You write tests. You do not fix bugs — see below.
- Any other agent's `tests/<area>/` directory or `docs/_testing/*-<area>.md`

Need a fixture the shared `Fixtures` class lacks? Put it in your own
`tests/<area>/helpers.ts`. Do not widen the shared one.

## Where your work goes

```
tests/<area>/*.test.ts              your tests, one file per surface
tests/<area>/helpers.ts             your own fixtures, if you need any
docs/_testing/requirements-<area>.md   Phase 1 register
docs/_testing/surface-map-<area>.md    Phase 2 map + the three reconciliation lists
docs/_testing/test-cases-<area>.md     Phase 9 register
docs/_testing/known-bugs-<area>.md     anything real you find
```

## Using the fixtures

```ts
import { afterEach } from "vitest";
import { Fixtures } from "../helpers/fixtures";

const fx = new Fixtures();
afterEach(() => fx.cleanup());

const branch = await fx.branch({ stationCount: 3 });  // + a week of 10:00–22:00 hours
const svc    = await fx.service({ priceHalalas: 25_000, durationMin: 60 });
const cust   = await fx.customer({ verified: true }); // verified => a real account
const tech   = await fx.staff("technician", branch.id);
const bkg    = await fx.booking({ branchId: branch.id, serviceId: svc.id });
```

`cleanup()` deletes **only rows this instance created**, by id. When the code
under test inserts rows itself, claim them: `fx.claim(bookings, row.id)` or
`await fx.claimBookingsOf(branch.id)`.

**The one rule that is not negotiable: never `db.delete(table)` without a
`where` that names ids you created.** On 2026-09-01 a check script's
`db.delete(bookings).where(eq(bookings.branchId, branchId))` ran against the
real database and destroyed eighty bookings past the restore window. That
incident is why `scripts/_test-db.ts` exists. Do not reintroduce the pattern.

## Running

```bash
npx vitest run tests/<area>          # yours only — other agents are running too
npx vitest run tests/<area> -t "..."  # one case
```

Never run the whole suite; you will trip over another agent's fixtures.

## Conventions to match

Read `scripts/check-roles.ts`, `scripts/check-pulse.ts` and
`scripts/check-booking.ts` first. Copy their voice:

- Assertion messages are **sentences in salon vocabulary**, not restatements of
  the code. `"the front desk cancels bookings, it does not delete them"`, not
  `"expected false"`.
- A file-top comment saying what the file protects and why it would be easy to
  break. Look at the top of `check-pulse.ts` for the standard.
- One-line comment on each non-obvious case. Someone is reading these to learn
  the codebase.
- Use the repo's own nouns from the glossary. Never invent domain terms.
- Every security test names the attack it performs.

## The source is spec too, not just `docs/`

The skill says `docs/` is the specification. In this repo that is half the
picture, and following it alone will produce a thin suite.

`lib/db/schema.ts` is 974 lines and most of it is comment. `lib/auth/rbac.ts`
carries dated grant-and-revoke history for every odd permission.
`lib/db/index.ts` explains a measured performance decision and what it does
*not* buy. `scripts/_test-db.ts` documents an incident. None of that is in
`docs/`, and all of it is behaviour someone decided on purpose.

So:

1. **Enumerate from the code first.** Every exported function in your area,
   every branch inside it, every guard, early return, thrown error and Zod
   field. *Then* read `docs/` for what it adds. `docs/` does not set the
   boundary of what you test — a function it never mentions still gets the
   full Phase 5 checklist. An undocumented server action is precisely where a
   hole lives.
2. **A comment that asserts behaviour is a requirement.** Register it like any
   other, cited `source: lib/<file>.ts:<line>`.
3. **Phase 2's "code without spec" list should be the largest of the three.**
   Every entry gets a Phase 4 characterization test tagged
   `// @characterization`.
4. **A comment contradicting `docs/` is a contradiction to report** — same rule
   as docs-versus-code. Stop and ask; never pick a side and test it as spec.

## A failing test that found a real bug

Do not edit it to pass. Do not fix the source. Log it in
`docs/_testing/known-bugs-<area>.md` with the failing assertion and what you
believe correct behaviour to be, mark the test `it.fails(...)` or skip it with
a comment pointing at the bug entry, and report it in your final summary.

Where `docs/` and the code disagree, **stop and report the contradiction** —
never pick an interpretation and test it as if it were spec.

## Definition of done

Report as `n/m register rows implemented for <surface>`, never "added some
tests". Paste real `vitest` output in your final summary — never claim green
without it.
