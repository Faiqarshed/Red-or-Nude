// Media storage behind a driver interface.
//
// Uploaded media lives in Azure Blob Storage, and only there: on Azure (any
// production build) AZURE_STORAGE_ACCOUNT must be set, or every storage call
// fails loudly rather than quietly writing somewhere that won't last. Nothing
// above this module knows how a file is stored.
//
// The local driver is for a developer's machine only (no NODE_ENV=production):
// it writes into /public/uploads, which a deploy replaces.

import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export type UploadResult = { path: string; url: string; bytes: number };

export type StoredFile = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  bytes: number | undefined;
};

export interface StorageDriver {
  readonly name: "azure" | "local";
  upload(key: string, body: Buffer, contentType: string): Promise<UploadResult>;
  remove(key: string): Promise<void>;
  publicUrl(key: string): string;
  /** Only drivers whose files are served through /media/<key> implement this. */
  read?(key: string): Promise<StoredFile | null>;
}

// ---------------------------------------------------------------- azure ----
//
// The storage accounts are private (no public blob access, no shared keys), so
// the app signs in with its managed identity and serves files itself under
// /media/<key> (app/media/[key]/route.ts). That keeps images on the site's own
// domain, too: the *.blob.core.windows.net hostname never reaches a browser.

type ContainerClient = import("@azure/storage-blob").ContainerClient;

const globalForAzure = globalThis as unknown as { __ronBlob?: Promise<ContainerClient> };

function azureDriver(account: string, container: string): StorageDriver {
  // Imported lazily so the local driver doesn't pay for the SDK. One client per
  // process: DefaultAzureCredential caches its token, and building it is slow.
  const client = () =>
    (globalForAzure.__ronBlob ??= Promise.all([
      import("@azure/storage-blob"),
      import("@azure/identity"),
    ]).then(([{ BlobServiceClient }, { DefaultAzureCredential }]) =>
      new BlobServiceClient(
        `https://${account}.blob.core.windows.net`,
        new DefaultAzureCredential(),
      ).getContainerClient(container),
    ));

  return {
    name: "azure",
    async upload(key, body, contentType) {
      const blob = (await client()).getBlockBlobClient(key);
      await blob.uploadData(body, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return { path: key, url: this.publicUrl(key), bytes: body.byteLength };
    },
    async remove(key) {
      await (await client()).getBlockBlobClient(key).deleteIfExists();
    },
    publicUrl(key) {
      return `/media/${key}`;
    },
    async read(key) {
      try {
        const res = await (await client()).getBlockBlobClient(key).download();
        if (!res.readableStreamBody) return null;
        return {
          body: Readable.toWeb(res.readableStreamBody as Readable) as ReadableStream<Uint8Array>,
          contentType: res.contentType ?? "application/octet-stream",
          bytes: res.contentLength,
        };
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) return null;
        throw err;
      }
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

/**
 * Fails closed in production, like the payment driver: a deploy that forgot
 * AZURE_STORAGE_ACCOUNT would otherwise save uploads to a disk the next deploy
 * wipes.
 */
export function getStorage(): StorageDriver {
  const account = process.env.AZURE_STORAGE_ACCOUNT?.trim();
  if (account) return azureDriver(account, process.env.AZURE_STORAGE_CONTAINER?.trim() || "media");
  if (process.env.NODE_ENV === "production") {
    throw new Error("[storage] AZURE_STORAGE_ACCOUNT must be set: uploaded media is stored in Azure only");
  }
  return localDriver;
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
