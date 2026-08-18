// Booking-flow client state.
//
// The catalogue and calendar that used to live here as literals are gone: the
// catalogue comes from the database via lib/catalog.ts, and bookable times come
// from the availability engine (lib/availability.ts) rather than a fixed
// June-2026 grid. What remains is the selection carried between the booking page
// and /booking/payment.
//
// It holds a `members` array rather than one flat service, so booking for one
// guest and booking for two are the same shape — the payment page renders
// however many it finds and posts them all to one API.

import type { Content } from "./dictionary";

type DateStrings = Content["date"];

/** One guest's choices. A solo booking is simply a members array of length 1. */
export type MemberSelection = {
  // Ids — what the API needs.
  serviceId: string | null;
  addonIds: string[];
  removalTypeId: string | null;
  designId: string | null;

  // Display labels, captured in the language the customer booked in.
  service: string | null;
  addons: string[];
  removal: string | null;
  design: string | null;

  /** SAR, before any group discount — shown as this guest's own line. */
  price: number;
};

export type BookingSelection = {
  branchId: string | null;
  startsAt: string | null; // ISO UTC — shared by every member
  members: MemberSelection[];

  branch: string | null;
  dateLabel: string | null;
  timeLabel: string | null;

  /** SAR before the group discount. */
  grossTotal: number;
  /**
   * SAR actually charged. Display only — the server recomputes every price from
   * the catalogue and never trusts this.
   */
  total: number;
  /**
   * The booking this one refills, if any. Also display-only in the sense that
   * matters: the server re-checks the window and re-prices from the catalogue.
   */
  refillOf?: string | null;
};

export const emptySelection: BookingSelection = {
  branchId: null,
  startsAt: null,
  members: [],
  branch: null,
  dateLabel: null,
  timeLabel: null,
  grossTotal: 0,
  total: 0,
  refillOf: null,
};

const KEY = "ron-booking";

export function saveBooking(sel: BookingSelection) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(KEY, JSON.stringify(sel));
}

export function loadBooking(): BookingSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BookingSelection;
    // A selection saved by an older build has no members array; treat it as
    // nothing selected rather than crashing the payment page.
    return Array.isArray(parsed?.members) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearBooking() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(KEY);
}

// ---- display helpers --------------------------------------------------------

/**
 * Gregorian month + year in the active language. `ar-SA` defaults to the Islamic
 * calendar, so the calendar and numbering system are pinned explicitly.
 */
export function monthLabel(year: number, month0: number, lang: "ar" | "en"): string {
  const locale = lang === "ar" ? "ar-u-nu-latn-ca-gregory" : "en-GB";
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month0, 1)),
  );
}

export function formatDateLabel(dateStr: string, lang: "ar" | "en"): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const locale = lang === "ar" ? "ar-u-nu-latn-ca-gregory" : "en-GB";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Weekday name for a date, using the Saturday-first arrays in the dictionary. */
export function weekdayLabel(dateStr: string, d: DateStrings): string {
  const [y, m, day] = dateStr.split("-").map(Number);
  const jsDow = new Date(Date.UTC(y, m - 1, day)).getUTCDay(); // 0 = Sun
  return d.weekdaysFull[(jsDow + 1) % 7];
}

/** "14:30" → "2:30 مساءً" / "2:30 PM". */
export function formatTime(slot: string, d: DateStrings): string {
  const [hStr, m] = slot.split(":");
  const h = Number(hStr);
  const period = h >= 12 ? d.pm : d.am;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${period}`;
}
