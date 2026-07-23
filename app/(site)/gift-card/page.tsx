// Server component: gift values and card designs come from the database, so the
// admin controls what customers can buy.

import { getPublicGiftOptions } from "@/lib/catalog";
import GiftCardView from "./GiftCardView";

// Cached; the gift-card admin actions call revalidatePath("/gift-card").
export const revalidate = 3600;

export default async function GiftCardPage() {
  const options = await getPublicGiftOptions();
  return <GiftCardView options={options} />;
}
