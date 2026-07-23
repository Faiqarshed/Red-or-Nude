import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { media } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { getStorage, mediaUrl } from "@/lib/storage";
import MediaView from "./MediaView";

export const dynamic = "force-dynamic";

export default async function MediaPage() {
  await requirePage("media.manage");

  const rows = await db.select().from(media).orderBy(desc(media.createdAt)).limit(200);

  return (
    <MediaView
      driver={getStorage().name}
      items={rows.map((r) => ({
        id: r.id,
        path: r.path,
        url: mediaUrl(r.path),
        alt: r.alt,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        createdAt: r.createdAt.toISOString(),
      }))}
    />
  );
}
