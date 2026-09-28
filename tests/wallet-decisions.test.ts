// The owner's "Needs your decision" page (docs/WALLET-PLAN.md, step 8).
//
// Only the owner corrects a balance, always with a reason, and every
// correction is audited (CLAUDE.md). A correction settles the case it came
// from, once: a double submit must not write two.

import "./as-staff";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, customers, walletDecisions, walletTxns } from "@/lib/db/schema";
import { can } from "@/lib/auth/rbac";
import { walletBalance } from "@/lib/wallet";
import { fixtures, reset } from "./helpers";

const { decideWallet } = await import("@/app/(admin)/admin/(shell)/wallet-decisions/actions");

const EMAIL = "sara@test.local";
let decisionId: string;

beforeEach(async () => {
  const f = await fixtures();
  await db.delete(walletDecisions);
  await reset(f.branchA, f.branchB);
  const [c] = await db.insert(customers).values({ phone: "0500000093", email: EMAIL }).returning();
  // She owed 40 SAR after a chargeback on credit she had spent.
  await db.insert(walletTxns).values({ customerId: c.id, ownerEmail: EMAIL, deltaHalalas: -4_000, reason: "correction", note: "setup" });
  const [d] = await db
    .insert(walletDecisions)
    .values({ kind: "negative-balance", customerId: c.id, amountHalalas: 4_000, detail: { ownerEmail: EMAIL } })
    .returning();
  decisionId = d.id;
});

const corrections = () => db.select().from(walletTxns).where(and(eq(walletTxns.reason, "correction"), like(walletTxns.note, "Waived%")));
const decision = async () => (await db.select().from(walletDecisions).where(eq(walletDecisions.id, decisionId)))[0];

describe("the owner settles a case", () => {
  it("corrects her balance with a reason, audited, and closes the case", async () => {
    expect(
      await decideWallet({ id: decisionId, note: "Waived: salon error", correction: { ownerEmail: EMAIL, halalas: 4_000 } }),
    ).toEqual({ ok: true });

    const [row] = await corrections();
    expect(row).toMatchObject({ deltaHalalas: 4_000, ownerEmail: EMAIL, note: "Waived: salon error" });
    expect(await walletBalance(EMAIL)).toEqual({ total: 0, available: 0 });
    expect((await decision()).resolvedAt).not.toBeNull();
    expect((await decision()).resolutionNote).toBe("Waived: salon error");
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, decisionId));
    expect(audit).toHaveLength(1);
  });

  it("refuses a correction without a reason", async () => {
    expect(await decideWallet({ id: decisionId, note: " ", correction: { ownerEmail: EMAIL, halalas: 4_000 } })).toEqual({
      ok: false,
      error: "note",
    });
    expect(await corrections()).toHaveLength(0);
    expect((await decision()).resolvedAt).toBeNull();
  });

  it("writes one correction on a double submit", async () => {
    const both = await Promise.all([
      decideWallet({ id: decisionId, note: "Waived: salon error", correction: { ownerEmail: EMAIL, halalas: 4_000 } }),
      decideWallet({ id: decisionId, note: "Waived: salon error", correction: { ownerEmail: EMAIL, halalas: 4_000 } }),
    ]);

    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, error: "already-decided" });
    expect(await corrections()).toHaveLength(1);
  });

  it("closes a case without a correction, but only with a reason", async () => {
    expect(await decideWallet({ id: decisionId, note: "" })).toEqual({ ok: false, error: "note" });
    expect(await decideWallet({ id: decisionId, note: "Waived: she will pay at the desk" })).toEqual({ ok: true });
    expect(await corrections()).toHaveLength(0);
    expect((await decision()).resolvedAt).not.toBeNull();
  });

  it("refuses a correction to an email that has no wallet", async () => {
    expect(
      await decideWallet({ id: decisionId, note: "Waived: typo", correction: { ownerEmail: "nobody@test.local", halalas: 100 } }),
    ).toEqual({ ok: false, error: "no-wallet" });
    expect((await decision()).resolvedAt).toBeNull();
  });

  it("refuses a correction of nothing", async () => {
    expect(
      await decideWallet({ id: decisionId, note: "Waived: salon error", correction: { ownerEmail: EMAIL, halalas: 0 } }),
    ).toEqual({ ok: false, error: "amount" });
  });
});

describe("who may", () => {
  it("is the owner alone", () => {
    expect(can("ceo", "wallet.decide")).toBe(true);
    for (const role of ["admin", "receptionist", "technician"] as const) {
      expect(can(role, "wallet.decide")).toBe(false);
    }
  });
});
