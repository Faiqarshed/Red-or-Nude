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
const REORDER = "lib/admin/reorder.ts";
const HISTORY = "app/(admin)/admin/(shell)/customers/data.ts";
const REWARDS = "lib/rewards.ts";
const LINES = "lib/admin/addon-lines.ts";
const TREAT = "lib/station-treat.ts";
const DBERR = "lib/db/errors.ts";
const CATALOG = "app/(admin)/admin/(shell)/catalog/actions.ts";
const PROMO = "app/(admin)/admin/(shell)/promo-codes/actions.ts";
const STAFFCODE = "lib/staff-codes.ts";
const WALLET = "lib/wallet.ts";
const STATUS = "app/(admin)/admin/(shell)/bookings/actions.ts";
const DECIDE = "app/(admin)/admin/(shell)/wallet-decisions/actions.ts";
const RBAC = "lib/auth/rbac.ts";
const PURCHASE = "lib/payments/purchase.ts";
const LOYALTY = "lib/loyalty.ts";
const MONEY = "lib/money.ts";
const PAYLINES = "lib/payments/lines.ts";
const SPAY = "lib/payments/streampay.ts";
const GIFTADMIN = "app/(admin)/admin/(shell)/gift-cards/actions.ts";
const GIFTROUTE = "app/api/gift-cards/route.ts";

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
  "        const issued = await allocateTickets(tx, lead.branchId, utcToLocalDate(lead.startsAt), indexes.length);",
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
    apply: () => mutate(ENGINE, "      return { ok: false, error: err.reason, guestIndex: err.guestIndex, walletBalance: err.walletBalance };", "      return { ok: false, error: err.reason, walletBalance: err.walletBalance };"),
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
        '  if (status === null) return row.reason === "booking" || !!row.reason?.startsWith("return:");',
        "  if (status === null) return false;",
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
    // Was "always leave one chair, whatever the party asked for", anchored on a
    // `guests` parameter subtractPartyHolds no longer takes — the rule is now
    // per-guest, so there is no party size in scope to compare against. Same
    // boundary, retargeted at the rule that is actually there: one off by one
    // and she is offered a chair her own friend is already sitting in.
    name: "subtle: let the party take one more chair than the branch has",
    expect: "tests/party-holds.test.ts",
    apply: () =>
      mutate(
        CLIENT,
        "    return taken > 0 && s.freeCount - taken < 1",
        "    return taken > 0 && s.freeCount - taken < 0",
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
        "  const blocked = members.find((m) => cancelRefusal(m, cutoff));",
        "  const blocked = cancelRefusal(anchor, cutoff) ? anchor : undefined;",
      ),
  },
  // ---- the admin screens' own reads ------------------------------------------
  //
  // Both reads were rewritten for speed, and both are the shape of change that
  // renumbers or drops the wrong rows without anything going red.
  {
    name: "reorder: let Postgres decide the CASE result type",
    expect: "tests/reorder.test.ts",
    apply: () =>
      mutate(
        REORDER,
        "    .set({ sort: sql`(case ${cases} end)::int` })",
        "    .set({ sort: sql`case ${cases} end` })",
      ),
  },
  {
    name: "reorder: renumber the whole table, not just the list the arrows belong to",
    expect: "tests/reorder.test.ts",
    apply: () =>
      mutate(
        REORDER,
        lines(
          "    .from(table)",
          "    .where(within)",
        ),
        lines(
          "    .from(table)",
        ),
      ),
  },
  {
    name: "history: go back to the newest bookings in the salon, whoever they belong to",
    expect: "tests/customer-history.test.ts",
    apply: () =>
      mutate(
        HISTORY,
        "    .where(inArray(bookings.customerId, ids))",
        "    .where(sql`true`)",
      ),
  },
  {
    name: "subtle: rank every booking together instead of per customer",
    expect: "tests/customer-history.test.ts",
    apply: () =>
      mutate(
        HISTORY,
        "        partition by ${bookings.customerId} order by ${bookings.startsAt} desc",
        "        order by ${bookings.startsAt} desc",
      ),
  },
  // ---- the milestone rule ----------------------------------------------------
  //
  // The client's rule in their own words: "spend 199, get 50 points worth 10
  // riyals — and if a person spends 350 we still give 50, because they haven't
  // touched 399". Each mutant below breaks one clause of that sentence.
  {
    name: "milestones: pay out on the threshold being passed, not reached",
    expect: "tests/branch.test.ts",
    apply: () =>
      mutate(
        REWARDS,
        "  if (totalHalalas < first) return 0;",
        "  if (totalHalalas <= first) return 0;",
      ),
  },
  {
    name: "subtle: count the milestone the bill is working toward, not the one it reached",
    expect: "tests/branch.test.ts",
    apply: () =>
      mutate(
        REWARDS,
        "  return Math.floor((totalHalalas - first) / step) + 1;",
        "  return Math.ceil((totalHalalas - first) / step) + 1;",
      ),
  },
  {
    name: "rewards: let a reward bigger than the bill pay the difference out",
    expect: "tests/branch.test.ts",
    apply: () =>
      mutate(
        REWARDS,
        "  return Math.max(0, Math.min(pointsValue(points, rules), totalHalalas));",
        "  return Math.max(0, pointsValue(points, rules));",
      ),
  },
  {
    name: "rewards: show points over a whole step as riyals she cannot spend",
    expect: "tests/points-worth.test.ts",
    apply: () =>
      mutate(
        REWARDS,
        "  return pointsValue(Math.floor(balance / step) * step, rules);",
        "  return pointsValue(balance, rules);",
      ),
  },
  {
    name: "subtle: accept any number of points, not whole steps",
    expect: "tests/branch.test.ts",
    apply: () =>
      mutate(
        REWARDS,
        "  if (!Number.isInteger(points) || points <= 0 || points % step !== 0) return \"unknown\";",
        "  if (!Number.isInteger(points) || points <= 0) return \"unknown\";",
      ),
  },
  // ---- the treat on the technician's ticket ----------------------------------
  {
    name: "treats: put the coffee back among the nail add-ons",
    expect: "tests/treats.test.ts",
    apply: () =>
      mutate(
        LINES,
        "    if (r.atCheckout) lines.treats.push(",
        "    if (false) lines.treats.push(",
      ),
  },
  {
    name: "subtle: send the nail work to the treats row instead",
    expect: "tests/treats.test.ts",
    apply: () =>
      mutate(
        LINES,
        "    if (r.atCheckout) lines.treats.push(",
        "    if (!r.atCheckout) lines.treats.push(",
      ),
  },
  // ---- a treat ordered from the chair ----------------------------------------
  {
    name: "station: let an add-on run past the time the chair is free",
    expect: "tests/station-treat.test.ts",
    apply: () => mutate(TREAT, "  if (extraMin > 0 && (await stationFreeWindow(station.branchId, station.id, booking.endsAt)) < extraMin) {", "  if (false) {"),
  },
  {
    name: "station: charge the card before checking she has not already ordered",
    expect: "tests/station-treat.test.ts",
    apply: () =>
      mutate(
        TREAT,
        "  if (existing) return { ok: false, reason: \"already-added\" };",
        "  if (false) return { ok: false, reason: \"already-added\" };",
      ),
  },
  {
    name: "subtle: let the sticker keep selling for a minute after she leaves",
    expect: "tests/station-treat.test.ts",
    apply: () =>
      mutate(
        TREAT,
        "        gt(bookings.endsAt, now),",
        "        gt(bookings.endsAt, new Date(now.getTime() - 60_000)),",
      ),
  },
  {
    name: "station: put the treat's receipt in booking_id after all",
    expect: "tests/station-treat.test.ts",
    apply: () => mutate(PURCHASE, "      .set({ treatBookingId: intent.bookingId, updatedAt: new Date() })", "      .set({ bookingId: intent.bookingId, updatedAt: new Date() })"),
  },
  // ---- one active thing per name ---------------------------------------------
  {
    name: "catalog: report a name clash as a generic failure again",
    expect: "tests/catalog-names.test.ts",
    apply: () =>
      mutate(
        CATALOG,
        '  return /_active_name_(en|ar)_unique$/.test(violatedConstraint(err) ?? "");',
        "  return false;",
      ),
  },
  {
    name: "subtle: catch the English clash but let the Arabic one through",
    expect: "tests/catalog-names.test.ts",
    apply: () =>
      mutate(
        CATALOG,
        '  return /_active_name_(en|ar)_unique$/.test(violatedConstraint(err) ?? "");',
        '  return /_active_name_en_unique$/.test(violatedConstraint(err) ?? "");',
      ),
  },
  {
    name: "catalog: let the switch turn a second row on under a taken name",
    expect: "tests/catalog-names.test.ts",
    apply: () =>
      mutate(
        CATALOG,
        lines(
          '    if (isDuplicateName(err)) return { ok: false, error: "duplicate-name" };',
          '    console.error("[catalog] activate failed", err);',
        ),
        '    console.error("[catalog] activate failed", err);',
      ),
  },
  // ---- reading which constraint refused --------------------------------------
  {
    name: "db errors: go back to matching the wrapped query text",
    expect: "tests/db-errors.test.ts",
    apply: () =>
      mutate(
        DBERR,
        "?.cause?.constraint_name || null;",
        "?.message || null;",
      ),
  },
  // ---- a staff code is not a campaign ----------------------------------------
  {
    name: "promo: let marketing retune a staff member’s own code",
    expect: "tests/staff-codes.test.ts",
    apply: () =>
      mutate(
        PROMO,
        '      if (before.staffId) return { ok: false, error: "staff-code" };',
        '      if (false) return { ok: false, error: "staff-code" };',
      ),
  },
  {
    name: "promo: let marketing switch a staff member’s own code off",
    expect: "tests/staff-codes.test.ts",
    apply: () =>
      mutate(
        PROMO,
        '  if (current.staffId) return { ok: false, error: "staff-code" };',
        '  if (!current.staffId) return { ok: false, error: "staff-code" };',
      ),
  },
  {
    name: "staff codes: issue one that belongs to nobody",
    expect: "tests/staff-codes.test.ts",
    apply: () =>
      mutate(
        STAFFCODE,
        lines("    code,", "    staffId,"),
        lines("    code,", "    staffId: null,"),
      ),
  },
  {
    name: "staff codes: hand everyone the same code again",
    expect: "tests/staff-codes.test.ts",
    apply: () =>
      mutate(
        STAFFCODE,
        '  const code = `STF${randomBytes(4).toString("hex").toUpperCase()}`;',
        '  const code = "STFSARA0000";',
      ),
  },
  {
    name: "subtle: call a code used only after its second use",
    expect: "tests/staff-codes.test.ts",
    apply: () =>
      mutate(STAFFCODE, "    used: row.uses > 0,", "    used: row.uses > 1,"),
  },
  {
    name: "subtle: keep a code live for the instant its month ends",
    expect: "tests/staff-codes.test.ts",
    apply: () =>
      mutate(
        STAFFCODE,
        "    active: row.active && !(row.endsAt && row.endsAt <= now),",
        "    active: row.active && !(row.endsAt && row.endsAt < now),",
      ),
  },

  // ---- a late payment says it was refunded, not "nothing was charged" --------
  {
    name: "late payment: call it expired on the arrival that refunds it",
    expect: "tests/streampay.test.ts",
    apply: () =>
      mutate(
        CONFIRM,
        '    return { ok: false, error: verdict.amountHalalas > 0 ? "not-delivered" : "expired" };',
        '    return { ok: false, error: "expired" };',
      ),
  },
  {
    name: "late payment: call it expired once the webhook has refunded it",
    expect: "tests/streampay.test.ts",
    apply: () =>
      mutate(CONFIRM, '    if (rows.some((r) => r.status === "refunded")) return { ok: false, error: "not-delivered" };\n', ""),
  },
  {
    name: "late payment: call it expired while its refund waits to be retried",
    expect: "tests/streampay.test.ts",
    apply: () =>
      mutate(
        CONFIRM,
        '    return { ok: false, error: rows.some((r) => r.amountHalalas > 0) ? "not-delivered" : "expired" };',
        '    return { ok: false, error: "expired" };',
      ),
  },

  // ---- the wallet: who a guest is, and one balance spent once --------------
  {
    name: "wallet: spend without locking the wallet",
    expect: "tests/wallet.test.ts",
    apply: () => mutate(WALLET, "  const email = ownerEmail.trim().toLowerCase();\n  await lockWallet(tx, email);\n\n  if ((await walletBalance(email, tx)).available < halalas) return null;", "  const email = ownerEmail.trim().toLowerCase();\n\n  if ((await walletBalance(email, tx)).available < halalas) return null;"),
  },
  {
    name: "subtle: lock the row she books as, not her email",
    expect: "tests/wallet.test.ts",
    apply: () => mutate(WALLET, "  const email = ownerEmail.trim().toLowerCase();\n  await lockWallet(tx, email);\n\n  if ((await walletBalance(email, tx)).available < halalas) return null;", "  const email = ownerEmail.trim().toLowerCase();\n  await tx.execute(sql`select 1 from customers where id = ${customerId} for update`);\n\n  if ((await walletBalance(email, tx)).available < halalas) return null;"),
  },
  {
    name: "wallet: count another email's credit as hers",
    expect: "tests/wallet.test.ts",
    apply: () =>
      mutate(
        WALLET,
        "    .where(eq(walletTxns.ownerEmail, ownerEmail.trim().toLowerCase()));",
        "    ;",
      ),
  },
  {
    name: "subtle: let her spend a debt as if it were money",
    expect: "tests/wallet.test.ts",
    apply: () =>
      mutate(WALLET, "  return { total: row.total, available: Math.max(0, row.total) };", "  return { total: row.total, available: row.total };"),
  },
  {
    name: "subtle: let a spend go one halala past her balance",
    expect: "tests/wallet.test.ts",
    apply: () =>
      mutate(
        WALLET,
        "  if ((await walletBalance(email, tx)).available < halalas) return null;",
        "  if ((await walletBalance(email, tx)).available + 1 < halalas) return null;",
      ),
  },
  {
    name: "identity: let a booking take over a phone's row that already has an email",
    expect: "tests/wallet.test.ts",
    apply: () =>
      mutate(
        ENGINE,
        "    .where(and(guest, isNull(customers.email), eq(customers.phone, g.phone)))",
        "    .where(and(guest, eq(customers.phone, g.phone)))",
      ),
  },
  {
    name: "identity: tag a signed-in booking with the email typed in the form",
    expect: "tests/wallet.test.ts",
    apply: () =>
      mutate(
        ENGINE,
        "            customerEmail: input.customerId ? customer.email?.toLowerCase() ?? null : email,",
        "            customerEmail: email,",
      ),
  },

  // ---- the salon's cancel: guarded, with a reason, all or none --------------
  {
    name: "salon cancel: write the status whatever it has become",
    expect: "tests/salon-cancel.test.ts",
    apply: () =>
      mutate(
        STATUS,
        "        .where(and(eq(bookings.id, id), eq(bookings.status, from)))",
        "        .where(eq(bookings.id, id))",
      ),
  },
  {
    name: "salon cancel: let the desk cancel without saying why",
    expect: "tests/salon-cancel.test.ts",
    apply: () =>
      mutate(
        STATUS,
        '  if (entering("cancelled") && !why) return { ok: false, error: "reason-required" };',
        "",
      ),
  },

  // ---- a no-show keeps its points ----------------------------------------
  {
    name: "no-show: void her points as if she had cancelled",
    expect: "tests/no-show-points.test.ts",
    apply: () => mutate(REWARDS, '  if (status === "no_show" || row.noShow) return false;\n', ""),
  },
  {
    name: "subtle: void what a no-show earned, keeping only what it spent",
    expect: "tests/no-show-points.test.ts",
    apply: () =>
      mutate(
        REWARDS,
        '  if (status === "no_show" || row.noShow) return false;',
        '  if (row.deltaPoints < 0 && (status === "no_show" || row.noShow)) return false;',
      ),
  },
  {
    name: "subtle: forget the sweep's no-show once the desk closes it",
    expect: "tests/no-show-points.test.ts",
    apply: () => mutate(REWARDS, '  if (status === "no_show" || row.noShow) return false;', '  if (status === "no_show") return false;'),
  },

  // ---- cancelling into the wallet -------------------------------------------
  {
    name: "cancel credit: give back the card part and forget what her wallet paid",
    expect: "tests/cancel-credit.test.ts",
    apply: () => mutate(WALLET, "    const amount = b.cardPart + b.walletPart;", "    const amount = b.cardPart;"),
  },
  {
    name: "cancel credit: let a credited cancel be set back to confirmed",
    expect: "tests/cancel-credit.test.ts",
    apply: () =>
      mutate(STATUS, '    if (credited) return { ok: false, error: "has-credit" };', ""),
  },
  {
    name: "cancel credit: decide open question 1 by crediting inside the window",
    expect: "tests/cancel-credit.test.ts",
    apply: () =>
      mutate(STATUS, '    if (now >= cancelDeadline(before, cutoff)) return { ok: false, error: "held" };', ""),
  },
  {
    name: "cancel credit: cancel without crediting her wallet",
    expect: "tests/cancel-credit.test.ts",
    apply: () => mutate(CANCEL, "      creditedHalalas: await creditCancelled(tx, ids, \"cancel-customer\"),", "      creditedHalalas: 0,"),
  },

  // ---- taking credit back when its payment went back -----------------------
  {
    // Equivalent while a group cancels as one: every payment on the bill then
    // funds a credit, and StreamPay cannot refund more than the card paid, so
    // the refunded total already caps the card part. Dropping guests from a
    // group (docs/WALLET-PLAN.md, open question 0) would make it matter.
    name: "equivalent: take back what her wallet paid as well as her card",
    expect: "tests/cancel-credit.test.ts",
    equivalent: true,
    apply: () =>
      mutate(
        WALLET,
        "  const cardPart = credits.reduce((sum, c) => sum + Math.min(c.deltaHalalas, c.cardHalalas), 0);",
        "  const cardPart = credits.reduce((sum, c) => sum + c.deltaHalalas, 0);",
      ),
  },
  {
    name: "reversal: forget what earlier reports already took back",
    expect: "tests/cancel-credit.test.ts",
    apply: () =>
      mutate(
        WALLET,
        "  const due = Math.min(refundedSoFarHalalas, cardPart) - taken;",
        "  const due = Math.min(refundedSoFarHalalas, cardPart);",
      ),
  },

  // ---- the owner settles a wallet case -------------------------------------
  {
    name: "decisions: correct a balance without saying why",
    expect: "tests/wallet-decisions.test.ts",
    apply: () =>
      mutate(
        DECIDE,
        '  if (checkNote(adminStrings.en.validation, "Reason", note, { max: ADJUST_REASON_MAX })) return { ok: false, error: "note" };',
        "",
      ),
  },
  {
    name: "decisions: settle a case that is already settled",
    expect: "tests/wallet-decisions.test.ts",
    apply: () =>
      mutate(
        DECIDE,
        "      .where(and(eq(walletDecisions.id, id), isNull(walletDecisions.resolvedAt)))",
        "      .where(eq(walletDecisions.id, id))",
      ),
  },
  {
    name: "decisions: let the admin correct a wallet too",
    expect: "tests/wallet-decisions.test.ts",
    apply: () => mutate(RBAC, '    "payments.view",\n  ],\n  receptionist: [', '    "payments.view",\n    "wallet.decide",\n  ],\n  receptionist: ['),
  },

  // ---- an undelivered chair purchase becomes credit -------------------------
  {
    name: "chair credit: mark it owed and never put it in her wallet",
    expect: "tests/payment-hardening.test.ts",
    apply: () => mutate(PURCHASE, "      return row ? creditChair(tx, row.id, intent.bookingId, amountHalalas) : false;", "      return false;"),
  },

  // ---- points follow the email -----------------------------------------------
  {
    name: "points: leave what she earned signed out off her account",
    expect: "tests/loyalty-email.test.ts",
    apply: () =>
      mutate(
        LOYALTY,
        "       where g.id = ${customerId}\n          or (g.email_verified_at is null and lower(g.email) = (",
        "       where g.id = ${customerId}\n          and (g.email_verified_at is null and lower(g.email) = (",
      ),
  },
  {
    // Equivalent while customers_guest_email_unique holds: one guest record per
    // email, so a guest record's email matches only itself.
    name: "equivalent: let a guest record count another guest's points by email",
    expect: "tests/loyalty-email.test.ts",
    equivalent: true,
    apply: () =>
      mutate(
        LOYALTY,
        "                 where a.id = ${customerId} and a.email_verified_at is not null))",
        "                 where a.id = ${customerId}))",
      ),
  },

  // ---- each discount named for what it was -----------------------------------
  {
    name: "discounts: count points spent as a group discount again",
    expect: "tests/invoice-email.test.ts",
    apply: () =>
      mutate(
        MONEY,
        "  return { group: b.discountHalalas - promo - points - wallet, promo, points, wallet };",
        "  return { group: b.discountHalalas - promo - wallet, promo, points: 0, wallet };",
      ),
  },

  // ---- the salon never cancels (SALON_CAN_CANCEL) ---------------------------
  {
    name: "salon cancel: let the desk cancel again",
    expect: "tests/salon-never-cancels.test.ts",
    apply: () =>
      mutate(
        STATUS,
        '  if (status === "cancelled" && !SALON_CAN_CANCEL) return { ok: false, error: "salon-cannot-cancel" };\n',
        "",
      ),
  },
  {
    name: "subtle: refuse only entering cancelled, so a re-save rewrites her reason",
    expect: "tests/salon-never-cancels.test.ts",
    apply: () =>
      mutate(
        STATUS,
        '  if (status === "cancelled" && !SALON_CAN_CANCEL)',
        '  if (entering("cancelled") && !SALON_CAN_CANCEL)',
      ),
  },
  {
    name: "salon cancel: offer the cancel button in the drawer",
    expect: "tests/salon-never-cancels.test.ts",
    apply: () =>
      mutate(
        RBAC,
        '(SALON_CAN_CANCEL ? all : all.filter((s) => s !== "cancelled"))',
        "all",
      ),
  },

  // ---- the wallet on her account screen --------------------------------------

  // ---- credit and gift cards at the booking checkout ------------------------
  {
    name: "wallet: let credit leave a card charge under 1 SAR",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(MONEY, "  return left === 0 || left >= HALALAS_PER_SAR;", "  return true;"),
  },
  {
    name: "wallet: let her spend more credit than she has",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(MONEY, "  if (halalas > availableHalalas || halalas > billHalalas) return false;", "  if (halalas > billHalalas) return false;"),
  },
  {
    name: "wallet: charge what the balance allows, not what the screen showed",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(ENGINE, "        if (!walletSpendOk(walletSpent, billTotal, spendable)) throw new BookingAbort(\"wallet-changed\", undefined, spendable);\n", ""),
  },
  {
    name: "wallet: let a guest spend the wallet of an email she only typed",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(ENGINE, "        const spendable = input.customerId ? available : Math.min(brought, available);", "        const spendable = available;"),
  },
  {
    name: "gift card: let any email use a card locked to its recipient",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(WALLET, "  if (lock && lock !== owner) return invalid;\n", ""),
  },
  {
    name: "wallet: keep the credit a lapsed hold spent",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(ENGINE, "  await releaseBookingSpends(tx, [...swept].map((r) => r.id));", ""),
  },
  {
    name: "subtle: let a guest spend a card an account holds",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(WALLET, "    if (account) return { ok: false, error: \"gift-card-claimed\" } as const;\n", ""),
  },
  {
    name: "subtle: forget a card's released spend when working out what is left",
    expect: "tests/wallet-checkout.test.ts",
    apply: () => mutate(WALLET, "inArray(walletTxns.reason, [\"spend\", \"release\"])));\n    const left", "eq(walletTxns.reason, \"spend\")));\n    const left"),
  },

  // ---- credit on a purchase -------------------------------------------------
  {
    name: "purchase: charge what the balance allows, not what the screen showed",
    expect: "tests/wallet-purchase.test.ts",
    apply: () => mutate(PURCHASE, "      if (!walletSpendOk(walletHalalas, input.amountHalalas, available)) throw new WalletChanged(available);\n", ""),
  },
  {
    name: "purchase: keep the credit of a declined checkout",
    expect: "tests/wallet-purchase.test.ts",
    apply: () => mutate(PURCHASE, "    await releasePaymentSpends(tx, failed.map((r) => r.id));\n", ""),
  },
  {
    name: "purchase: keep the credit of a purchase never delivered",
    expect: "tests/wallet-purchase.test.ts",
    apply: () => mutate(PURCHASE, "    await releasePaymentSpends(tx, rows.map((r) => r.id));\n", ""),
  },
  {
    name: "purchase: deliver a revived payment whose credit was spent elsewhere",
    expect: "tests/wallet-purchase.test.ts",
    apply: () => mutate(PURCHASE, "  if (!(await reSpendReleased(row.id))) {", "  if (false) {"),
  },
  {
    name: "purchase: issue a gift card for only what the card paid",
    expect: "tests/wallet-purchase.test.ts",
    apply: () => mutate(PURCHASE, "      amountHalalas: intent.amountSar * 100,", "      amountHalalas,"),
  },
  {
    name: "purchase: send a purchase credit covers to StreamPay",
    expect: "tests/wallet-purchase.test.ts",
    apply: () => mutate(PURCHASE, "  if (cardHalalas === 0) {", "  if (false) {"),
  },

  // ---- gift cards and the wallet --------------------------------------------
  {
    name: "gift card: sell it tax-free",
    expect: "tests/gift-card-wallet.test.ts",
    apply: () => mutate(PAYLINES, "  priceHalalas: amountSar * 100,\n  qty: 1,\n});", "  priceHalalas: amountSar * 100,\n  qty: 1,\n  vatExempt: true,\n});"),
  },
  {
    name: "gift card: put the recipient in debt for the buyer's chargeback",
    expect: "tests/gift-card-wallet.test.ts",
    apply: () => mutate(WALLET, "    const take = own ? due : Math.min(due, (await walletBalance(c.ownerEmail, tx)).available);", "    const take = due;"),
  },
  {
    name: "subtle: record the salon's loss again on a repeated refund total",
    expect: "tests/gift-card-wallet.test.ts",
    apply: () => mutate(WALLET, "    const due = Math.min(refundedSoFarHalalas, c.halalas) - taken - lost;", "    const due = Math.min(refundedSoFarHalalas, c.halalas) - taken;"),
  },
  {
    name: "gift card: let the owner move a card already in a wallet",
    expect: "tests/gift-card-wallet.test.ts",
    apply: () => mutate(GIFTADMIN, "    .where(and(eq(giftCards.id, id), eq(giftCards.status, \"active\")))", "    .where(eq(giftCards.id, id))"),
  },
  {
    name: "gift card: sell one with no recipient email",
    expect: "tests/gift-card-wallet.test.ts",
    apply: () => mutate(GIFTROUTE, "  recipientEmail: emailField,", "  recipientEmail: emailField.optional().or(z.literal(\"\")),"),
  },
  {
    name: "no email: refuse the cancel instead of sending the money to the owner",
    expect: "tests/cancel-credit.test.ts",
    apply: () => mutate(WALLET, "    if (!b.customerEmail) {", "    if (!b.customerEmail && false) {"),
  },

  // ---- a coupon name StreamPay already has -----------------------------------
  {
    name: "coupon: fail the checkout when StreamPay already has that name",
    expect: "tests/payment-hardening.test.ts",
    apply: () => mutate(SPAY, "    if (!there) throw err;", "    throw err;"),
  },
  {
    name: "subtle: use the coupon found by name without mending it",
    expect: "tests/payment-hardening.test.ts",
    apply: () =>
      mutate(SPAY, "    if (there.is_active === false || !couponMatches(there, d)) await repairCoupon(there.id, name, d);", "    if (false) await repairCoupon(there.id, name, d);"),
  },

  // ---- a gift card amount taken off sale ------------------------------------
  {
    name: "gift card amount: leave its StreamPay product live when it is deleted",
    expect: "tests/gift-card-wallet.test.ts",
    apply: () => mutate(GIFTADMIN, "  if (gone) await retireProduct(giftCardLine(halalasToSar(gone.amount)).key);", ""),
  },
  {
    name: "gift card amount: archive it anyway when it is offered again within the hour",
    expect: "tests/gift-card-wallet.test.ts",
    apply: () => mutate(GIFTADMIN, "  await syncProductQuietly(giftCardLine(amountSar).key, { ...giftCardLine(amountSar), active: true });", ""),
  },
];

const touched = [
  CONFIRM, CANCEL, ENGINE, ROUTE, PACKS, CLIENT, REORDER, HISTORY, REWARDS, LINES, TREAT,
  DBERR, CATALOG, PROMO, STAFFCODE, WALLET, STATUS, DECIDE, RBAC, PURCHASE, LOYALTY, MONEY,
  PAYLINES, GIFTADMIN, GIFTROUTE, SPAY,
];
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
