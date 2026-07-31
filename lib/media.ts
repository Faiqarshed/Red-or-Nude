// Upload constraints and the media row shape.
//
// These live here rather than beside the actions because a "use server" module
// may only export async functions — anything else is replaced by a server
// reference at build time, so an exported array arrives in the client as
// something with no .join().

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// SVG is allowed for crisp vector exports (e.g. straight from Figma) but is
// sanitized server-side before storage — see lib/media-sanitize.ts — since it
// can otherwise carry script and uploads are served from the same origin as
// the admin.
export const ALLOWED_TYPES = [
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/avif",
  "image/svg+xml",
];

export type MediaItem = {
  id: string;
  path: string;
  url: string | null;
  alt: { ar: string; en: string } | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  createdAt: string;
};
