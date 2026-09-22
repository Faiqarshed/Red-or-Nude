/**
 * Push the whole catalogue to StreamPay once.
 *
 *   npm run streampay:sync
 *
 * Every active service, add-on, removal, treat and pack becomes (or is brought
 * up to date as) a StreamPay product, recorded in `streampay_ids`. After this,
 * admin saves keep them in step; checkout also creates anything still missing,
 * so running this is a head start rather than a requirement.
 *
 * **Writes to DATABASE_URL and to the StreamPay account in .env.local** — test
 * keys make sandbox products, live keys make live ones. Safe to re-run: an item
 * whose name and price have not changed is skipped without an API call.
 */

import { config } from "dotenv";

config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, giftCardValues, packs, removalTypes, services } from "@/lib/db/schema";
import { syncProduct } from "@/lib/payments/streampay";
import { giftCardLine, productName } from "@/lib/payments/lines";

async function main() {
  const rows = [
    ...(await db.select().from(services).where(eq(services.active, true))).map((r) => ({ key: `product:service:${r.id}`, ...r })),
    ...(await db.select().from(addons).where(eq(addons.active, true))).map((r) => ({ key: `product:addon:${r.id}`, ...r })),
    ...(await db.select().from(removalTypes).where(eq(removalTypes.active, true))).map((r) => ({ key: `product:removal:${r.id}`, ...r })),
    ...(await db.select().from(packs).where(eq(packs.active, true))).map((r) => ({ key: `product:pack:${r.id}`, ...r })),
  ];

  let failed = 0;
  for (const r of rows) {
    // Products must cost at least 1 SAR; a free item never reaches a payment link.
    if (r.priceHalalas < 100) {
      console.log(`  skip  ${r.key}  (${r.priceHalalas} halalas)`);
      continue;
    }
    try {
      const id = await syncProduct(r.key, { name: productName(r.name), priceHalalas: r.priceHalalas });
      console.log(`  ok    ${r.key} → ${id}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${r.key}`, err instanceof Error ? err.message : err);
    }
  }

  // The preset gift card amounts; a custom amount gets its product at checkout.
  const values = await db.select().from(giftCardValues).where(eq(giftCardValues.active, true));
  for (const v of values) await syncProduct(giftCardLine(v.amountHalalas / 100).key, giftCardLine(v.amountHalalas / 100));
  console.log(`\n${rows.length - failed} of ${rows.length} synced, plus ${values.length} gift card amounts.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
