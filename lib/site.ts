import { headers } from "next/headers";

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

/**
 * Where a payment sends the customer back to: the address she paid from.
 *
 * Her selection and her hold are kept in the browser, per address, so coming
 * back on another one (paid on localhost, returned to the ngrok SITE_URL) shows
 * a checkout that has forgotten them. Outside production only: there SITE_URL
 * is the one address, and a request's Host is not trusted to name a redirect.
 * Called inside a request; anywhere else (a test, a job) it is siteOrigin().
 */
export function returnOrigin(): string {
  if (process.env.NODE_ENV === "production") return siteOrigin();
  try {
    const h = headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return siteOrigin();
    const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  } catch {
    return siteOrigin();
  }
}
