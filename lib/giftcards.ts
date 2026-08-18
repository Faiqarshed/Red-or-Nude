// Gift card issuance and the balance ledger.
//
// The balance column is a cached running total; every change must also write a
// gift_card_txns row inside the same transaction. That way a balance can always
// be re-derived from the ledger, and a drift is a detectable bug rather than
// silently wrong money.

import "server-only";
import { randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { giftCards, giftCardTxns } from "@/lib/db/schema";

// No I/O/0/1 — codes get typed off a printed card and read over the phone.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makeGiftCardCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (i < 3) out += "-";
  }
  return out; // XXXX-XXXX-XXXX-XXXX
}

export type IssueGiftCardInput = {
  amountHalalas: number;
  designId?: string | null;
  buyerName?: string | null;
  buyerEmail?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  message?: string | null;
  /** Months until expiry; null keeps the card open-ended. */
  expiresInMonths?: number | null;
  actorId?: string | null;
};

export type IssueResult =
  | { ok: true; id: string; code: string }
  | { ok: false; error: "invalid-amount" | "failed" };

export async function issueGiftCard(input: IssueGiftCardInput): Promise<IssueResult> {
  if (!Number.isInteger(input.amountHalalas) || input.amountHalalas <= 0) {
    return { ok: false, error: "invalid-amount" };
  }

  let expiresAt: Date | null = null;
  if (input.expiresInMonths) {
    expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + input.expiresInMonths);
  }

  // Codes are random; a collision is vanishingly unlikely but retried anyway
  // rather than surfacing a unique-constraint error to a paying customer.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeGiftCardCode();
    try {
      const row = await db.transaction(async (tx) => {
        const [card] = await tx
          .insert(giftCards)
          .values({
            code,
            designId: input.designId ?? null,
            initialHalalas: input.amountHalalas,
            balanceHalalas: input.amountHalalas,
            buyerName: input.buyerName ?? null,
            buyerEmail: input.buyerEmail ?? null,
            recipientName: input.recipientName ?? null,
            recipientEmail: input.recipientEmail ?? null,
            recipientPhone: input.recipientPhone ?? null,
            message: input.message ?? null,
            expiresAt,
          })
          .returning({ id: giftCards.id, code: giftCards.code });

        // The opening balance is a ledger entry like any other.
        await tx.insert(giftCardTxns).values({
          giftCardId: card.id,
          deltaHalalas: input.amountHalalas,
          reason: "issued",
          actorId: input.actorId ?? null,
        });

        return card;
      });

      return { ok: true, id: row.id, code: row.code };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("gift_cards_code_unique")) continue;
      console.error("[giftcards] issue failed", err);
      return { ok: false, error: "failed" };
    }
  }

  return { ok: false, error: "failed" };
}

export type AdjustResult =
  | { ok: true; balanceHalalas: number }
  | { ok: false; error: "not-found" | "insufficient" | "failed" };

/**
 * Move a card's balance and record why. Negative deltas are redemptions.
 * Refuses to go below zero — a card must never fund more than it holds.
 */
export async function adjustGiftCardBalance(
  giftCardId: string,
  deltaHalalas: number,
  reason: string,
  actorId?: string | null,
  bookingId?: string | null,
): Promise<AdjustResult> {
  if (!Number.isInteger(deltaHalalas) || deltaHalalas === 0) {
    return { ok: false, error: "failed" };
  }

  try {
    return await db.transaction(async (tx) => {
      // Locked for the transaction so two concurrent redemptions can't both
      // read the same balance and overdraw the card.
      const [card] = await tx
        .select()
        .from(giftCards)
        .where(eq(giftCards.id, giftCardId))
        .for("update")
        .limit(1);

      if (!card) return { ok: false as const, error: "not-found" as const };

      const next = card.balanceHalalas + deltaHalalas;
      if (next < 0) return { ok: false as const, error: "insufficient" as const };

      await tx
        .update(giftCards)
        .set({
          balanceHalalas: next,
          status: next === 0 ? "redeemed" : card.status === "redeemed" ? "active" : card.status,
          updatedAt: new Date(),
        })
        .where(eq(giftCards.id, giftCardId));

      await tx.insert(giftCardTxns).values({
        giftCardId,
        bookingId: bookingId ?? null,
        deltaHalalas,
        reason,
        actorId: actorId ?? null,
      });

      return { ok: true as const, balanceHalalas: next };
    });
  } catch (err) {
    console.error("[giftcards] adjust failed", err);
    return { ok: false, error: "failed" };
  }
}

/** Ledger total — used to prove the cached balance hasn't drifted. */
export async function ledgerBalance(giftCardId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${giftCardTxns.deltaHalalas}), 0)::int` })
    .from(giftCardTxns)
    .where(eq(giftCardTxns.giftCardId, giftCardId));
  return row?.total ?? 0;
}
