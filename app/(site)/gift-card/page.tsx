// Server component: gift values and card designs come from the database, so the
// admin controls what customers can buy.

import { getPublicGiftOptions } from "@/lib/catalog";
import GiftCardView from "./GiftCardView";

export const dynamic = "force-dynamic";

export default async function GiftCardPage() {
  const options = await getPublicGiftOptions();
  return <GiftCardView options={options} />;
}
