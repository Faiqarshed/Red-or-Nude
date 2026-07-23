// Booking-flow client state.
//
// The catalogue and calendar that used to live here as literals are gone: the
// catalogue comes from the database via lib/catalog.ts, and bookable times come
// from the availability engine (lib/availability.ts) rather than a fixed
// June-2026 grid. What remains is the selection carried between /booking and
// /booking/payment, which now holds real row ids so the payment step can create
// an actual booking.

import type { Content } from "./dictionary";

type DateStrings = Content["date"];

export type BookingSelection = {
  // Ids — what the API needs.
  branchId: string | null;
  serviceId: string | null;
  addonIds: string[];
  removalTypeId: string | null;
  designId: string | null;
  startsAt: string | null; // ISO UTC

  // Display labels — what the summary and success screens show, captured in the
  // language the customer booked in.
  service: string | null;
  addons: string[];
  removal: string | null;
  design: string | null;
  branch: string | null;
  dateLabel: string | null;
  timeLabel: string | null;

  total: number;
};

export const emptySelection: BookingSelection = {
  branchId: null,
  serviceId: null,
  addonIds: [],
  removalTypeId: null,
  designId: null,
  startsAt: null,
  service: null,
  addons: [],
  removal: null,
  design: null,
  branch: null,
  dateLabel: null,
  timeLabel: null,
  total: 0,
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
    return raw ? (JSON.parse(raw) as BookingSelection) : null;
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
