// Mutation check: put each bug back, one at a time, and confirm the suite
// notices.
//
//   node tests/mutations.mjs
//
// A green suite proves nothing on its own — a test that asserts the wrong thing
// is green too. This reverts each fix in turn and requires the run to fail, and
// to fail in the file that claims to cover it.
//
// Two kinds of mutant. The coarse ones delete a fix outright, which any test
// touching the area will catch. The subtle ones change one index or one word —
// `some` to `every`, a boundary moved by one, a key with a field dropped. Those
// are the ones a loose test waves through, and they are the real measure of
// whether these suites assert the rule or merely visit the code.
//
// Multi-line anchors are written as arrays so nothing has to be escaped.
// Sources are restored from an in-memory copy afterwards, including on a throw.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = (p) => path.join(root, p);
const lines = (...xs) => xs.join("\n");

const CONFIRM = "lib/payments/confirm.ts";
const CANCEL = "app/api/my-bookings/cancel/route.ts";
const ENGINE = "lib/bookings.ts";
const ROUTE = "app/api/bookings/route.ts";
const PACKS = "lib/packs.ts";
const CLIENT = "lib/booking.ts";

/** Exact-string edit that preserves the file's own line endings. */
function mutate(rel, from, to) {
  const p = file(rel);
  const raw = fs.readFileSync(p, "utf8");
  const crlf = raw.includes("\r\n");
  const s = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  const hits = s.split(from).length - 1;
  if (hits !== 1) throw new Error(`${rel}: anchor matched ${hits} times, wanted 1`);
  const out = s.replace(from, to);
  fs.writeFileSync(p, crlf ? out.replace(/\n/g, "\r\n") : out);
}

const PACK_GUARD = "  if (input.members.length > 1 && input.members.some((m) => m.customerPackId)) {";

const PER_QUEUE_TICKETS = lines(
  "      const numbers: string[] = new Array(members.length);",
  "      for (const indexes of byQueue.values()) {",
  "        const lead = members[indexes[0]];",
  "        const issued = await allocateTickets(",
  "          tx,",
  "          lead.branchId,",
  "          utcToLocalDate(lead.startsAt),",
  "          indexes.length,",
  "        );",
  "        indexes.forEach((at, k) => (numbers[at] = issued[k]));",
  "      }",
);

const ANCHOR_TICKETS = lines(
  "      const numbers = await allocateTickets(",
  "        tx,",
  "        anchor.branchId,",
  "        utcToLocalDate(anchor.startsAt),",
  "        members.length,",
  "      );",
);

const PER_FLOOR_ASSIGN = lines(
  "    for (const indexes of byQueue.values()) {",
  "      const lead = members[indexes[0]];",
  "      await assignIfToday(lead.branchId, lead.startsAt);",
  "    }",
);

const CANCEL_FAN_OUT = lines(
  "  const floors = new Map<string, (typeof members)[number]>();",
  "  for (const m of members) floors.set(`${m.branchId}:${utcToLocalDate(m.startsAt)}`, m);",
  "  for (const m of floors.values()) await assignIfToday(m.branchId, m.startsAt);",
);

const mutations = [
  // ---- coarse: the fix, removed ------------------------------------------
  {
    name: "tickets: take the whole run from the anchor's queue",
    expect: "tests/tickets.test.ts",
    apply: () => mutate(CONFIRM, PER_QUEUE_TICKETS, ANCHOR_TICKETS),
  },
  {
    name: "staffing: deal only the anchor's floor on payment",
    expect: "tests/staffing.test.ts",
    apply: () =>
      mutate(CONFIRM, PER_FLOOR_ASSIGN, "    await assignIfToday(anchor.branchId, anchor.startsAt);"),
  },
  {
    name: "staffing: deal only the anchor's floor on cancellation",
    expect: "tests/cancel-route.test.ts",
    apply: () =>
      mutate(CANCEL, CANCEL_FAN_OUT, "  await assignIfToday(anchor.branchId, anchor.startsAt);"),
  },
  {
    name: "refusal: throw without the guest",
    expect: "tests/refusal.test.ts",
    apply: () =>
      mutate(ENGINE, 'new BookingAbort("slot-taken", i)', 'new BookingAbort("slot-taken")'),
  },
  {
    name: "refusal: drop the guest on the way out of the catch",
    expect: "tests/refusal.test.ts",
    apply: () =>
      mutate(
        ENGINE,
        "      return { ok: false, error: err.reason, guestIndex: err.guestIndex };",
        "      return { ok: false, error: err.reason };",
      ),
  },
  {
    name: "refusal: drop the guest from the JSON the browser reads",
    expect: "tests/api.test.ts",
    apply: () => mutate(ROUTE, "        guestIndex: result.guestIndex,\n", ""),
  },
  {
    name: "packs: let a group spend a pack credit",
    expect: "tests/pack-credit.test.ts",
    apply: () => mutate(ENGINE, PACK_GUARD, "  if (false) {"),
  },

  // ---- subtle: the fix, quietly wrong ------------------------------------
  {
    // Equivalent mutant: it cannot change behaviour, so surviving is the right
    // answer and the runner is told to expect that. Every member of a queue
    // shares its branch and its day — that pair is the key the queue is built
    // on — so the branch reads the same off any of them. Kept because a future
    // change to the key would make this a real mutant overnight.
    name: "equivalent: read each queue's branch off the last guest",
    equivalent: true,
    apply: () =>
      mutate(
        CONFIRM,
        "        const lead = members[indexes[0]];",
        "        const lead = members[indexes[indexes.length - 1]];",
      ),
  },
  {
    name: "subtle: hand each queue's numbers out in reverse",
    expect: "tests/tickets.test.ts",
    apply: () =>
      mutate(
        CONFIRM,
        "        indexes.forEach((at, k) => (numbers[at] = issued[k]));",
        "        indexes.forEach((at, k) => (numbers[at] = issued[indexes.length - 1 - k]));",
      ),
  },
  {
    name: "subtle: key the queues by day alone, losing the branch",
    expect: "tests/tickets.test.ts",
    apply: () =>
      mutate(
        CONFIRM,
        "    const key = `${m.branchId}:${utcToLocalDate(m.startsAt)}`;",
        "    const key = `${utcToLocalDate(m.startsAt)}`;",
      ),
  },
  {
    name: "subtle: deal only the first floor the party touches",
    expect: "tests/staffing.test.ts",
    apply: () =>
      mutate(
        CONFIRM,
        PER_FLOOR_ASSIGN,
        PER_FLOOR_ASSIGN.replace(
          "for (const indexes of byQueue.values())",
          "for (const indexes of [...byQueue.values()].slice(0, 1))",
        ),
      ),
  },
  {
    name: "subtle: name the guest before the one who lost her chair",
    expect: "tests/refusal.test.ts",
    apply: () =>
      mutate(
        ENGINE,
        'new BookingAbort("slot-taken", i)',
        'new BookingAbort("slot-taken", Math.max(0, i - 1))',
      ),
  },
  {
    name: "subtle: guard the pack only when every guest names one",
    expect: "tests/pack-credit.test.ts",
    apply: () =>
      mutate(
        ENGINE,
        PACK_GUARD,
        "  if (input.members.length > 1 && input.members.every((m) => m.customerPackId)) {",
      ),
  },
  {
    name: "subtle: let a two-guest party slip past the pack guard",
    expect: "tests/pack-credit.test.ts",
    apply: () =>
      mutate(
        ENGINE,
        PACK_GUARD,
        "  if (input.members.length > 2 && input.members.some((m) => m.customerPackId)) {",
      ),
  },

  // ---- the race fixes -------------------------------------------------------
  {
    name: "races: stop recognising a second live payment attempt",
    expect: "tests/concurrency.test.ts",
    apply: () =>
      mutate(
        CONFIRM,
        '    if (e.message.includes("payments_booking_live_unique")) return true;',
        '    if (false) return true;',
      ),
  },
  {
    name: "races: drop the lock on the purchase before recounting",
    expect: "tests/concurrency.test.ts",
    apply: () =>
      mutate(
        PACKS,
        "  await tx.execute(sql`select 1 from customer_packs where id = ${customerPackId} for update`);",
        "  await tx.execute(sql`select 1 from customer_packs where id = ${customerPackId}`);",
      ),
  },
  {
    name: "subtle: let the recounted balance go one past zero",
    expect: "tests/concurrency.test.ts",
    apply: () =>
      mutate(
        PACKS,
        "  if (spendableCredits(ledger, holdMin, now) <= 0) return false;",
        "  if (spendableCredits(ledger, holdMin, now) < 0) return false;",
      ),
  },

  // ---- the stranded pack credit ---------------------------------------------
  {
    name: "packs: count every -1 again, however its booking ended",
    expect: "tests/pack-stranded.test.ts",
    apply: () =>
      mutate(
        PACKS,
        "  if (status === null) return false; // not attached to a booking at all",
        "  return false; // not attached to a booking at all",
      ),
  },
  {
    name: "packs: copy isDead() wholesale, returning the credit on every cancel",
    expect: "tests/pack-stranded.test.ts",
    apply: () =>
      mutate(
        PACKS,
        '  if (status === "cancelled") return row.bookingCancelReason === "payment-timeout";',
        '  if (status === "cancelled" || status === "no_show") return true;',
      ),
  },
  {
    name: "subtle: strand a hold the moment it reaches its window, not past it",
    expect: "tests/pack-stranded.test.ts",
    apply: () =>
      mutate(
        PACKS,
        "  return now.getTime() - createdAt.getTime() > holdMin * 60_000;",
        "  return now.getTime() - createdAt.getTime() >= holdMin * 60_000;",
      ),
  },

  // ---- the group picker's own chair count ------------------------------------
  {
    name: "party: count every friend on the day, overlapping or not",
    expect: "tests/party-holds.test.ts",
    apply: () =>
      mutate(
        CLIENT,
        lines(
          "    const taken = partyHolds.filter((h) => {",
          "      const from = Date.parse(h.startsAt);",
          "      return start < from + h.durationMin * 60_000 && from < end;",
          "    }).length;",
        ),
        "    const taken = partyHolds.length;",
      ),
  },
  {
    name: "subtle: count a friend who finishes exactly as this guest starts",
    expect: "tests/party-holds.test.ts",
    apply: () =>
      mutate(
        CLIENT,
        "      return start < from + h.durationMin * 60_000 && from < end;",
        "      return start <= from + h.durationMin * 60_000 && from < end;",
      ),
  },
  {
    name: "subtle: measure the overlap against the friend's hour, not hers",
    expect: "tests/party-holds.test.ts",
    apply: () =>
      mutate(
        CLIENT,
        "    const end = start + durationMin * 60_000;",
        "    const end = start + 60_000;",
      ),
  },
  {
    name: "subtle: always leave one chair, whatever the party asked for",
    expect: "tests/party-holds.test.ts",
    apply: () =>
      mutate(
        CLIENT,
        "    return taken > 0 && s.freeCount - taken < guests",
        "    return taken > 0 && s.freeCount - taken < 1",
      ),
  },
  {
    name: "races: seat her anyway when the credit turned out to be gone",
    expect: "tests/concurrency.test.ts",
    apply: () =>
      mutate(
        ENGINE,
        '          if (!spent) throw new BookingAbort("pack-credit-gone", i);',
        "          void spent;",
      ),
  },
  {
    name: "groups: judge cancellation on the anchor alone again",
    expect: "tests/cancel-route.test.ts",
    apply: () =>
      mutate(
        CANCEL,
        "  const refused = members.map((m) => cancelRefusal(m, cutoff)).find(Boolean);",
        "  const refused = cancelRefusal(anchor, cutoff);",
      ),
  },
];

const touched = [CONFIRM, CANCEL, ENGINE, ROUTE, PACKS, CLIENT];
const originals = new Map(touched.map((rel) => [rel, fs.readFileSync(file(rel))]));
const restore = () => originals.forEach((buf, rel) => fs.writeFileSync(file(rel), buf));

function runSuite() {
  try {
    execFileSync("npx", ["vitest", "run", "--reporter=json", "--outputFile=.mutation.json"], {
      cwd: root,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
  } catch {
    // A failing run is the expected outcome here, so the exit code is not news.
  }
  const report = JSON.parse(fs.readFileSync(file(".mutation.json"), "utf8"));
  const failed = report.testResults
    .flatMap((f) => f.assertionResults.map((a) => ({ file: f.name, status: a.status })))
    .filter((a) => a.status === "failed");
  fs.rmSync(file(".mutation.json"), { force: true });
  return failed;
}

let bad = 0;
try {
  console.log("Baseline: every fix in place.\n");
  const baseline = runSuite();
  if (baseline.length) {
    console.log(`  FAIL — not green to start with (${baseline.length} failing)\n`);
    bad++;
  } else {
    console.log("  ok — green\n");
  }

  for (const m of mutations) {
    restore();
    m.apply();
    const failed = runSuite();
    const here = failed.some((a) => a.file.replace(/\\/g, "/").endsWith(m.expect));

    if (m.equivalent) {
      if (failed.length) {
        console.log(`  WRONGLY CAUGHT — ${m.name}`);
        console.log(`             an equivalent mutant failed ${failed.length} test(s)
`);
        bad++;
      } else {
        console.log(`  survived, as it must — ${m.name}
`);
      }
      continue;
    }

    if (!failed.length) {
      console.log(`  SURVIVED — ${m.name}`);
      console.log(`             nothing failed; ${m.expect} does not really cover this\n`);
      bad++;
    } else if (!here) {
      console.log(`  CAUGHT ELSEWHERE — ${m.name}`);
      console.log(`             expected ${m.expect} to fail; it did not\n`);
      bad++;
    } else {
      console.log(`  caught — ${m.name}`);
      console.log(`           ${failed.length} test(s) failed, including in ${m.expect}\n`);
    }
  }
} finally {
  restore();
  console.log("Sources restored.");
}

console.log(
  bad === 0
    ? `\nAll ${mutations.length} mutants were caught.`
    : `\n${bad} mutant(s) went unnoticed.`,
);
process.exit(bad === 0 ? 0 : 1);
