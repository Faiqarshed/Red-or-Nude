import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { packServices, packs, services } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { halalasToSar } from "@/lib/money";
import { mediaUrl } from "@/lib/storage";
import PacksView, { type PackRow } from "./PacksView";

export const dynamic = "force-dynamic";

export default async function PacksPage() {
  await requirePage("catalog.manage");

  const [packRows, lineRows, serviceRows] = await Promise.all([
    db.select().from(packs).orderBy(asc(packs.sort)),
    db.select().from(packServices),
    // Every service, active or not: a pack already holding a retired one must
    // still show what is in it rather than silently dropping the line.
    db.select().from(services).orderBy(asc(services.sort)),
  ]);

  return (
    <PacksView
      packs={packRows.map(
        (p): PackRow => ({
          id: p.id,
          name: p.name,
          description: p.description,
          priceSar: halalasToSar(p.priceHalalas),
          validDays: p.validDays,
          image: p.image,
          imageUrl: mediaUrl(p.image),
          active: p.active,
          sort: p.sort,
          lines: lineRows
            .filter((l) => l.packId === p.id)
            .map((l) => ({ serviceId: l.serviceId, quantity: l.quantity })),
        }),
      )}
      services={serviceRows.map((s) => ({
        id: s.id,
        name: s.name,
        priceSar: halalasToSar(s.priceHalalas),
        active: s.active,
      }))}
    />
  );
}
