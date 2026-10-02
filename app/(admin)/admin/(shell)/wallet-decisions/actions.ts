"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, TransactionRollbackError } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { walletDecisions } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { adminStrings } from "@/lib/admin/strings";
import { ADJUST_MAX, ADJUST_REASON_MAX, checkEmail, checkNote } from "@/lib/admin/validate";
import { correctWallet } from "@/lib/wallet";
import { sendCorrectionEmail } from "@/lib/wallet-email";

export type Result = { ok: true } | { ok: false; error: string };

const input = z.object({
  id: z.string().uuid(),
  note: z.string(),
  correction: z
    .object({
      ownerEmail: z.string().trim().toLowerCase(),
      halalas: z.number().int(),
    })
    .optional(),
});

/**
 * Settle one case on "Needs your decision" (docs/WALLET-PLAN.md): with a
 * correction to a wallet, or without one. A reason either way. The case is
 * closed and the correction written in one transaction, guarded on the case
 * still being open, so a double submit writes one correction.
 */
export async function decideWallet(raw: z.input<typeof input>): Promise<Result> {
  const actor = await requireCan("wallet.decide");

  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { id, correction } = parsed.data;
  const note = parsed.data.note.trim();
  if (checkNote(adminStrings.en.validation, "Reason", note, { max: ADJUST_REASON_MAX })) return { ok: false, error: "note" };
  if (correction) {
    if (correction.halalas === 0 || Math.abs(correction.halalas) > ADJUST_MAX * 100) return { ok: false, error: "amount" };
    if (checkEmail(adminStrings.en.validation, "Email", correction.ownerEmail)) return { ok: false, error: "email" };
  }

  const outcome = await db.transaction(async (tx) => {
    const [closed] = await tx
      .update(walletDecisions)
      .set({ resolvedAt: new Date(), resolvedBy: actor.id, resolutionNote: note })
      .where(and(eq(walletDecisions.id, id), isNull(walletDecisions.resolvedAt)))
      .returning({ id: walletDecisions.id });
    if (!closed) return "already-decided" as const;
    if (correction && !(await correctWallet(tx, { ...correction, note, actorId: actor.id }))) {
      tx.rollback();
    }
    return "ok" as const;
  }).catch((err) => {
    // tx.rollback() above: no customer has that email, so nothing was closed.
    if (err instanceof TransactionRollbackError) return "no-wallet" as const;
    throw err;
  });
  if (outcome !== "ok") return { ok: false, error: outcome };

  await recordAudit(actor, {
    action: correction ? "correct" : "resolve",
    entity: "wallet_decisions",
    entityId: id,
    diff: {
      resolutionNote: { from: null, to: note },
      ...(correction
        ? { correction: { from: null, to: { ownerEmail: correction.ownerEmail, halalas: correction.halalas } } }
        : {}),
    },
  });
  if (correction) await sendCorrectionEmail(correction.ownerEmail, correction.halalas, note);

  revalidatePath("/admin/wallet-decisions");
  return { ok: true };
}
