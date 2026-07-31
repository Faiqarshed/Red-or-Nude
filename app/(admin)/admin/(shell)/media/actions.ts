"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { media } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import { getStorage, mediaKey, mediaUrl } from "@/lib/storage";
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, type MediaItem } from "@/lib/media";
import { sanitizeSvg } from "@/lib/media-sanitize";

export async function listMedia(): Promise<MediaItem[]> {
  await requireCan("media.manage");
  const rows = await db.select().from(media).orderBy(desc(media.createdAt)).limit(200);
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    url: mediaUrl(r.path),
    alt: r.alt,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type UploadResponse = { ok: true; item: MediaItem } | { ok: false; error: string };

export async function uploadMedia(formData: FormData): Promise<UploadResponse> {
  const actor = await requireCan("media.manage");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "no-file" };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "too-large" };
  if (!ALLOWED_TYPES.includes(file.type)) return { ok: false, error: "bad-type" };

  // Dimensions are measured in the browser before upload — reading them here
  // would mean pulling in an image library for no real gain.
  const dims = z
    .object({ width: z.coerce.number().int().positive(), height: z.coerce.number().int().positive() })
    .safeParse({ width: formData.get("width"), height: formData.get("height") });

  const key = mediaKey(file.name, randomUUID().slice(0, 8));
  let buffer = Buffer.from(await file.arrayBuffer());
  if (file.type === "image/svg+xml") {
    buffer = Buffer.from(sanitizeSvg(buffer.toString("utf-8")), "utf-8");
  }

  let stored;
  try {
    stored = await getStorage().upload(key, buffer, file.type);
  } catch (err) {
    console.error("[media] upload failed", err);
    return { ok: false, error: "storage" };
  }

  const [row] = await db
    .insert(media)
    .values({
      path: stored.path,
      bytes: stored.bytes,
      width: dims.success ? dims.data.width : null,
      height: dims.success ? dims.data.height : null,
      uploadedBy: actor.id,
    })
    .returning();

  await recordAudit(actor, { action: "create", entity: "media", entityId: row.id });
  revalidatePath("/admin/media");

  return {
    ok: true,
    item: {
      id: row.id,
      path: row.path,
      url: mediaUrl(row.path),
      alt: row.alt,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

export async function updateMediaAlt(id: string, alt: { ar: string; en: string }): Promise<void> {
  const actor = await requireCan("media.manage");
  const parsed = z.object({ ar: z.string().max(200), en: z.string().max(200) }).parse(alt);

  await db.update(media).set({ alt: parsed }).where(eq(media.id, id));
  await recordAudit(actor, { action: "update", entity: "media", entityId: id });
  revalidatePath("/admin/media");
}

export async function deleteMedia(id: string): Promise<{ ok: boolean; error?: string }> {
  const actor = await requireCan("media.manage");

  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) return { ok: false, error: "not-found" };

  // Legacy assets committed under /public are tracked in the library but are not
  // ours to delete from disk — drop the record only.
  if (!row.path.startsWith("/")) {
    try {
      await getStorage().remove(row.path);
    } catch (err) {
      console.error("[media] storage delete failed, removing record anyway", err);
    }
  }

  await db.delete(media).where(eq(media.id, id));
  await recordAudit(actor, { action: "delete", entity: "media", entityId: id });
  revalidatePath("/admin/media");
  return { ok: true };
}
