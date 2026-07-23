import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { giftCardDesigns, giftCardTxns, giftCardValues, giftCards } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { can } from "@/lib/auth/rbac";
import { halalasToSar } from "@/lib/money";
import { mediaUrl } from "@/lib/storage";
import GiftCardsView from "./GiftCardsView";

export const dynamic = "force-dynamic";

export default async function GiftCardsPage() {
  const user = await requirePage("giftcards.issue");

  const [cardRows, valueRows, designRows, txnRows] = await Promise.all([
    db.select().from(giftCards).orderBy(desc(giftCards.createdAt)).limit(200),
    db.select().from(giftCardValues).orderBy(asc(giftCardValues.sort)),
    db.select().from(giftCardDesigns).orderBy(asc(giftCardDesigns.sort)),
    db.select().from(giftCardTxns).orderBy(desc(giftCardTxns.createdAt)).limit(500),
  ]);

  return (
    <GiftCardsView
      canAdjust={can(user.role, "giftcards.adjust")}
      cards={cardRows.map((c) => ({
        id: c.id,
        code: c.code,
        initialSar: halalasToSar(c.initialHalalas),
        balanceSar: halalasToSar(c.balanceHalalas),
        status: c.status,
        buyerName: c.buyerName,
        recipientName: c.recipientName,
        recipientEmail: c.recipientEmail,
        message: c.message,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        txns: txnRows
          .filter((t) => t.giftCardId === c.id)
          .map((t) => ({
            id: t.id,
            deltaSar: halalasToSar(t.deltaHalalas),
            reason: t.reason,
            createdAt: t.createdAt.toISOString(),
          })),
      }))}
      values={valueRows.map((v) => ({ id: v.id, amountSar: halalasToSar(v.amountHalalas) }))}
      designs={designRows.map((d) => ({
        id: d.id,
        name: d.name,
        image: d.image,
        imageUrl: mediaUrl(d.image),
        active: d.active,
      }))}
    />
  );
}
