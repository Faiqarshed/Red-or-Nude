// The page the recipient opens from WhatsApp.
//
// The code is the address: sixteen characters from a 32-character alphabet, so
// it is not something anyone stumbles onto, and it is what the recipient needs
// to spend the card anyway. No lookup form, no login — they tapped a link from
// someone they know.

import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { giftCardDesigns, giftCards } from "@/lib/db/schema";
import { mediaUrl } from "@/lib/storage";
import { halalasToSar } from "@/lib/money";
import GiftCardReveal from "./GiftCardReveal";

export const dynamic = "force-dynamic";

export default async function GiftCardPage({ params }: { params: { code: string } }) {
  const code = decodeURIComponent(params.code).trim().toUpperCase();

  const [card] = await db
    .select({
      code: giftCards.code,
      initialHalalas: giftCards.initialHalalas,
      balanceHalalas: giftCards.balanceHalalas,
      status: giftCards.status,
      expiresAt: giftCards.expiresAt,
      buyerName: giftCards.buyerName,
      recipientName: giftCards.recipientName,
      message: giftCards.message,
      designName: giftCardDesigns.name,
      designImage: giftCardDesigns.image,
    })
    .from(giftCards)
    .leftJoin(giftCardDesigns, eq(giftCardDesigns.id, giftCards.designId))
    .where(eq(giftCards.code, code))
    .limit(1);

  // A cancelled card is not shown at all — as far as the recipient is
  // concerned it was never issued.
  if (!card || card.status === "cancelled") notFound();

  return (
    <GiftCardReveal
      card={{
        code: card.code,
        amountSar: halalasToSar(card.initialHalalas),
        balanceSar: halalasToSar(card.balanceHalalas),
        expiresAt: card.expiresAt ? card.expiresAt.toISOString() : null,
        senderName: card.buyerName,
        recipientName: card.recipientName,
        message: card.message,
        designName: card.designName,
        designImg: mediaUrl(card.designImage),
      }}
    />
  );
}
