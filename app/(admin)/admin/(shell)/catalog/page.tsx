import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, removalTypes, services } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { halalasToSar } from "@/lib/money";
import { mediaUrl } from "@/lib/storage";
import CatalogView, { type CatalogRow } from "./CatalogView";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  await requirePage("catalog.manage");

  const [serviceRows, addonRows, removalRows] = await Promise.all([
    db.select().from(services).orderBy(asc(services.sort)),
    db.select().from(addons).orderBy(asc(addons.sort)),
    db.select().from(removalTypes).orderBy(asc(removalTypes.sort)),
  ]);

  return (
    <CatalogView
      services={serviceRows.map(
        (r): CatalogRow => ({
          id: r.id,
          name: r.name,
          description: r.description,
          priceSar: halalasToSar(r.priceHalalas),
          durationMin: r.durationMin,
          image: r.image,
          imageUrl: mediaUrl(r.image),
          active: r.active,
          sort: r.sort,
        }),
      )}
      addons={addonRows.map(
        (r): CatalogRow => ({
          id: r.id,
          name: r.name,
          priceSar: halalasToSar(r.priceHalalas),
          durationMin: r.durationMin,
          image: r.image,
          imageUrl: mediaUrl(r.image),
          isSeasonal: r.isSeasonal,
          active: r.active,
          sort: r.sort,
        }),
      )}
      removals={removalRows.map(
        (r): CatalogRow => ({
          id: r.id,
          name: r.name,
          priceSar: halalasToSar(r.priceHalalas),
          durationMin: r.durationMin,
          active: r.active,
          sort: r.sort,
        }),
      )}
    />
  );
}
