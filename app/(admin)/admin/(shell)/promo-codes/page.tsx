// Occasion discount codes (brief §2.10) — National Day, Eid, and whatever the
// salon runs next. The customer side is the field on /booking/payment; this is
// where the codes come from.

import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { halalasToSar } from "@/lib/money";
import PromoCodesView from "./PromoCodesView";

export const dynamic = "force-dynamic";

export default async function PromoCodesPage() {
  await requirePage("marketing.manage");

  const rows = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
  const now = new Date();

  return (
    <PromoCodesView
      rows={rows.map((r) => ({
        id: r.id,
        code: r.code,
        type: r.type,
        // Percent stays a percentage; a fixed amount is stored in halalas and
        // edited in riyals, like every other amount on this admin.
        value: r.type === "percent" ? r.value : halalasToSar(r.value),
        minTotalSar: halalasToSar(r.minTotalHalalas),
        startsAt: r.startsAt?.toISOString() ?? null,
        endsAt: r.endsAt?.toISOString() ?? null,
        maxUses: r.maxUses,
        uses: r.uses,
        // A code past its end is off, whatever the flag says: checkout already
        // refuses it (lib/promo.ts), and the edit drawer won't save it as on.
        active: r.active && !(r.endsAt && r.endsAt <= now),
      }))}
    />
  );
}
