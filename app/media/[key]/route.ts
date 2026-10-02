// Serves uploaded media from Azure Blob Storage under the site's own domain.
//
// The storage accounts are private, so a browser can't load a blob directly;
// the app reads it with its managed identity and streams it back. Keys are
// written once and never reused (mediaKey adds a random token), so responses
// can be cached for a year.
//
// Only the Azure driver serves through here. The local dev driver hands out
// /uploads/ URLs, so this route 404s for it.

import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

// The shape mediaKey produces: "name-token.ext", lowercase, no slashes.
const KEY = /^[a-z0-9][a-z0-9-]*\.[a-z0-9]+$/;

export async function GET(_req: Request, { params }: { params: { key: string } }) {
  const storage = getStorage();
  if (!storage.read || !KEY.test(params.key)) {
    return new NextResponse(null, { status: 404 });
  }

  let file;
  try {
    file = await storage.read(params.key);
  } catch (err) {
    console.error("[media] read failed", params.key, err);
    return new NextResponse(null, { status: 502 });
  }
  if (!file) return new NextResponse(null, { status: 404 });

  const headers = new Headers({
    "Content-Type": file.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    // SVG uploads are sanitised, but they now share the site's origin, so stop
    // anything in one from running if it's opened on its own.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  if (file.bytes !== undefined) headers.set("Content-Length", String(file.bytes));

  return new NextResponse(file.body, { headers });
}
