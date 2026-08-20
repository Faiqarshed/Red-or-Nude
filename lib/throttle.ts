// Per-IP rate limiting for the public, unauthenticated endpoints.
//
// Lifted out of app/api/my-bookings/route.ts, which had the only copy, once
// cancel and reschedule needed the same guard. A booking reference is five
// characters of a 32-character alphabet — a large space, but not one an
// unthrottled endpoint couldn't be walked, and the prize is now someone's
// appointment rather than only a read of it.
//
// ponytail: an in-memory map, so it counts per serverless instance rather than
// globally, and it resets on cold start. Enough to stop a script; move it to
// the database or a shared counter if the logs ever show a real attempt.

const HITS = new Map<string, number[]>();

export type ThrottleOptions = {
  windowMs?: number;
  max?: number;
};

/**
 * Records a hit and reports whether the caller has now exceeded its budget.
 *
 * `key` should carry the endpoint as well as the IP, so a customer being
 * throttled on cancellation doesn't lose their ability to look a booking up.
 */
export function throttled(key: string, { windowMs = 60_000, max = 10 }: ThrottleOptions = {}): boolean {
  const now = Date.now();
  const recent = (HITS.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  HITS.set(key, recent);

  // Stop the map growing without bound on a busy instance.
  if (HITS.size > 5_000) HITS.clear();

  return recent.length > max;
}

/** The caller's address, or `"unknown"` when the host doesn't forward one. */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
