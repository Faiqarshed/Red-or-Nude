// A purchase's success, carried from its payment page back to the page it began
// on (/booking, /gift-card, /memberships), which shows the success popup over
// itself. A popup over a spent checkout read as a form she still had to fill.
//
// One read and gone: taken by the page it was meant for, and never shown twice.
// Same tab and, with returnOrigin (lib/site.ts), the same address, so the
// per-tab store is enough.

const KEY = "ron-paid";

export type PaidKind = "booking" | "gift_card" | "pack";

/**
 * Leave for `path` with `data` waiting there. A full load, not router.push: the
 * page reads fresh from the server (the slot now taken, the credits now hers),
 * and `replace` keeps Back off a checkout already paid.
 */
export function showPaidOn(path: string, kind: PaidKind, data: unknown): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ kind, data }));
  } catch {
    // Private mode or full storage: she still lands there, without the popup.
    // The email carries the same details.
  }
  window.location.replace(path);
}

/** What `showPaidOn` left for this page, once. Null when nothing was left for it. */
export function takePaid<T>(kind: PaidKind): T | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { kind?: string; data?: T } | null;
    if (saved?.kind !== kind) return null;
    sessionStorage.removeItem(KEY);
    return saved.data ?? null;
  } catch {
    return null;
  }
}
