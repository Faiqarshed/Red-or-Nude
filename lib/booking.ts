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
import type { bookingStatus } from "@/lib/db/schema";
import type { Localized } from "@/lib/localized";

type DateStrings = Content["date"];

/** An hour another guest of the same party has already taken at one branch. */
export type PartyHold = { startsAt: string; durationMin: number };

/** What subtractPartyHolds needs of a slot. /api/availability returns all four. */
export type HoldableSlot = {
  startsAt: string;
  available: boolean;
  blockedBy: "closed" | "past" | "full" | "too-soon" | null;
  /** Chairs free for the whole duration. What the holds are subtracted from. */
  freeCount: number;
};

/**
 * Strike out the hours this guest's own friends have already filled.
 *
 * A group is one bill but not one row: each guest picks her own branch and her
 * own hour, and **none of it is written down until somebody pays**. So the
 * server answering one guest's availability question cannot see the other three
 * standing next to her. It says the branch's last chair is free — truthfully —
 * and says the same to all four. They each pick it, and createBookings then
 * refuses the whole party at the moment of payment, which is the worst possible
 * place to find out.
 *
 * The screen is the only place that knows the party exists, so the screen is
 * where the subtraction has to happen.
 *
 * Only *overlapping* holds count against her. A friend booked at 11:00 is not
 * competing for a 14:00 chair, and the freedom to spread a party across the day
 * is the whole point of the group page — a blunter rule that counted every
 * friend on the day would hide hours that are genuinely bookable.
 *
 * Marked `full` rather than filtered out: a struck-through hour tells her it is
 * taken, and a missing one just looks like the salon closes early.
 */
export function subtractPartyHolds<T extends HoldableSlot>(
  slots: T[],
  durationMin: number,
  partyHolds: PartyHold[],
): T[] {
  if (partyHolds.length === 0) return slots;
  return slots.map((s) => {
    if (!s.available) return s;
    const start = Date.parse(s.startsAt);
    const end = start + durationMin * 60_000;
    const taken = partyHolds.filter((h) => {
      const from = Date.parse(h.startsAt);
      return start < from + h.durationMin * 60_000 && from < end;
    }).length;
    return taken > 0 && s.freeCount - taken < 1
      ? { ...s, available: false, blockedBy: "full" as const }
      : s;
  });
}

/** One guest's choices. A solo booking is simply a members array of length 1. */
export type MemberSelection = {
  // Ids — what the API needs.
  /** Typed on the group screen for guest 2; null for the guest who is paying. */
  guestName: string | null;
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

  /**
   * Where and when this guest sits, when it is not where and when the party
   * does. Null means "the party's", which is every solo booking and every group
   * that chose one branch and one slot together.
   */
  branchId?: string | null;
  startsAt?: string | null;
  /**
   * The pack purchase paying for this guest's service line, if she chose to
   * spend one. Display-only in the sense that matters: the server re-reads her
   * ledger and decides for itself whether a credit exists.
   */
  customerPackId?: string | null;
  /**
   * What that credit took off, and which membership it came from.
   *
   * `price` above already has it deducted, which is what the server is asked to
   * charge — but a number that arrives pre-reduced cannot be shown as a
   * reduction. Without these the checkout lists a service and a total of zero
   * with nothing joining them, and the customer is left to guess that the
   * membership she bought is what happened. Every other thing that lowers a
   * bill — the group discount, a promo code, a loyalty rung — gets its own
   * line; this is how the credit gets one too.
   *
   * Display only. The server re-reads her ledger and prices it again.
   */
  creditSar?: number | null;
  packName?: string | null;
  /** Her own labels, captured in the language she booked in. */
  branch?: string | null;
  dateLabel?: string | null;
  timeLabel?: string | null;
};

export type BookingSelection = {
  /** The party's branch and start. A member may hold her own of either. */
  branchId: string | null;
  startsAt: string | null; // ISO UTC
  members: MemberSelection[];

  branch: string | null;
  dateLabel: string | null;
  timeLabel: string | null;

  /**
   * The upsells offered on the payment page — the coffee and cookie. What is on
   * offer, not what was taken: the payment page is a client component with no
   * server shell, so the catalogue reaches it through here rather than through a
   * new API route. Absent on the station-QR and gift-card flows, which simply
   * never offer it.
   *
   * The name stays bilingual, unlike the display labels above: this one is
   * rendered on the payment page, where the customer can still toggle language.
   */
  checkoutAddons?: { id: string; name: Localized; price: number; img: string | null }[];

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
  /**
   * The chair this booking must land on, when it came from a station QR
   * (brief §2.7). Carried through checkout unchanged; the API resolves the
   * token and re-checks the chair is still free under a lock.
   */
  stationToken?: string | null;
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
  stationToken: null,
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

// ---- booking history --------------------------------------------------------

/**
 * A booking as the customer is allowed to see it.
 *
 * Lives here rather than beside the query that builds it (lib/bookings.ts, which
 * is server-only) because both sides of the boundary need the shape: the API
 * route and the account page produce it, BookingCard renders it. Same reason
 * lib/localized.ts exists.
 *
 * What is absent is the point of it. No name, no phone, no email, no station,
 * no notes — a reference proves someone booked, not who they are, and this type
 * is where that promise is kept. Adding a field here widens what a leaked
 * reference is worth; do it deliberately or not at all.
 */
export type BookingSummary = {
  code: string;
  /**
   * How many people booked together on this appointment. 1 for everyone else.
   *
   * A count rather than the other guest's details: quoting one reference now
   * returns the whole party, and the screen has to explain why two cards
   * appeared — but the second guest's name is hers, not the reference holder's
   * to be handed.
   */
  groupSize: number;
  /**
   * Which party this belongs to, so a screen can put the members of one group
   * booking side by side. Null for a solo booking.
   *
   * An opaque id, not a credential — nothing accepts it — and it adds no one to
   * the list: the members already come back together, on the same reference or
   * the same account. It only says which of them belong to each other.
   */
  groupId: string | null;
  startsAt: string;
  status: (typeof bookingStatus.enumValues)[number];
  ticketNo: string | null;
  serviceName: Localized | null;
  totalSar: number;
  isRefill: boolean;
  /** Whether a refill is on offer. The details are behind an emailed code. */
  hasRefill: boolean;
  /**
   * Whether the 3-hour window is still open (brief §2.6). Decided by the server
   * from lib/cancellation.ts, never re-derived here — a button that offers what
   * the API refuses is worse than no button.
   */
  canCancel: boolean;
  /** ISO UTC deadline, shown so a closed window explains itself. */
  cancelBy: string;
  /** What the reschedule picker needs, and nothing more. */
  branchId: string;
  durationMin: number;

  // Catalogue detail for the booking's own screen. Safe to add here: these come
  // from the services and branches tables, which the public site already shows
  // to everyone. The line this type must not cross is *customer* data — no
  // name, phone, email, station or notes. See lib/bookings.ts.
  /** Live catalogue image for the service, or null if it has none. */
  serviceImage: string | null;
  /** Add-ons attached to this booking, with names and catalogue images. */
  addons: { name: Localized | null; image: string | null }[];
  /** Which salon, by name rather than by id. */
  branchName: Localized | null;
  /** Assigned technician's display name, or null when not yet assigned. */
  technicianName: string | null;
};
