// Media storage behind a driver interface.
//
// Supabase Storage is the target (docs/ADMIN-PANEL.md §2), but the panel has to
// be buildable and demoable before that project exists — so the driver is picked
// from the environment: Supabase when its keys are present, local disk
// otherwise. Nothing above this module knows which one is running.
//
// The local driver writes into /public/uploads and does NOT work on serverless
// hosting (the filesystem is ephemeral). It is a development convenience only;
// set the Supabase env vars before deploying.

import { promises as fs } from "node:fs";
import path from "node:path";

export type UploadResult = { path: string; url: string; bytes: number };

export interface StorageDriver {
  readonly name: "supabase" | "local";
  upload(key: string, body: Buffer, contentType: string): Promise<UploadResult>;
  remove(key: string): Promise<void>;
  publicUrl(key: string): string;
}

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "media";

// ------------------------------------------------------------- supabase ----

function supabaseDriver(url: string, serviceKey: string): StorageDriver {
  // Imported lazily so the local path doesn't pay for the SDK.
  const client = () =>
    import("@supabase/supabase-js").then(({ createClient }) =>
      createClient(url, serviceKey, { auth: { persistSession: false } }),
    );

  return {
    name: "supabase",
    async upload(key, body, contentType) {
      const supabase = await client();
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(key, body, { contentType, upsert: true });
      if (error) throw new Error(`Supabase upload failed: ${error.message}`);
      return { path: key, url: this.publicUrl(key), bytes: body.byteLength };
    },
    async remove(key) {
      const supabase = await client();
      const { error } = await supabase.storage.from(BUCKET).remove([key]);
      if (error) throw new Error(`Supabase delete failed: ${error.message}`);
    },
    publicUrl(key) {
      return `${url.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${key}`;
    },
  };
}

// ---------------------------------------------------------------- local ----

const LOCAL_DIR = path.join(process.cwd(), "public", "uploads");

const localDriver: StorageDriver = {
  name: "local",
  async upload(key, body) {
    const dest = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, body);
    return { path: key, url: `/uploads/${key}`, bytes: body.byteLength };
  },
  async remove(key) {
    await fs.rm(path.join(LOCAL_DIR, key), { force: true });
  },
  publicUrl(key) {
    return `/uploads/${key}`;
  },
};

// --------------------------------------------------------------- picker ----

export function getStorage(): StorageDriver {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? supabaseDriver(url, key) : localDriver;
}

/**
 * Resolve a stored path to something an <img> can load.
 *
 * Legacy values are pass-through: the seeded catalogue points at files committed
 * under /public ("/service-nails.webp"), and those keep working untouched
 * alongside newly uploaded media.
 */
export function mediaUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith("http://") || stored.startsWith("https://")) return stored;
  if (stored.startsWith("/")) return stored;
  return getStorage().publicUrl(stored);
}

/** Filesystem-safe, collision-resistant key. Randomness comes from the caller. */
export function mediaKey(originalName: string, token: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
  const base = path
    .basename(originalName, path.extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "file";
  return `${base}-${token}${ext}`;
}
