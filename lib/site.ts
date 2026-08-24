/**
 * The site's canonical public origin.
 *
 * Needed wherever a URL has to survive leaving the request that produced it —
 * an image in an email inbox, a QR sticker printed once and left on a table for
 * months. Neither can be resolved relatively, and neither should inherit
 * whichever host the admin happened to be browsing when it was generated.
 *
 * Falls back to AUTH_URL and then localhost: a wrong-looking link in a dev
 * inbox is a better failure than a crash in the payment path.
 */
export function siteOrigin(): string {
  const raw =
    process.env.SITE_URL?.trim() || process.env.AUTH_URL?.trim() || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}
