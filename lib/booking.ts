// Shared booking-flow data + state. The selection made on /booking is persisted
// to sessionStorage so /booking/payment (and its success modal) can render the
// real choices instead of static placeholders.

import type { Content } from "./dictionary";

export type Service = { name: string; price: number; img: string };
export type Addon = { name: string; price: number; img: string; seasonal?: boolean };
export type Design = { name: string; img: string };

type DateStrings = Content["date"];

export const SERVICE_DESC =
  "SHAPING | BUFFING | CUTICLE CARE | SMOOTH GEL POLISH FINISH";

export const services: Service[] = [
  { name: "Acrylic", price: 280, img: "/service-nails.webp" },
  { name: "Classic Manicure", price: 90, img: "/service-nails.webp" },
  { name: "BIAB", price: 220, img: "/service-nails.webp" },
  { name: "Gel Polish", price: 150, img: "/service-nails.webp" },
];

// The "Seasonal Catalogue" addon opens the seasonal-designs pop-up (Figma 439:11053).
export const addons: Addon[] = [
  { name: "Seasonal Catalogue", price: 50, img: "/addon-catalogue.webp", seasonal: true },
  { name: "Chrome", price: 50, img: "/addon-chrome.webp" },
  { name: "Cat eye", price: 50, img: "/addon-art.webp" },
  { name: "French Tip", price: 50, img: "/addon-art.webp" },
  { name: "Nail Art", price: 50, img: "/addon-catalogue.webp" },
];

// Removal price (types + names live in the dictionary, keyed by id).
export const REMOVAL_PRICE = 20;

// Seasonal-designs grid (Figma 439:11053 "التصاميم الموسمية"). Reuses the
// on-brand art thumbnails already in /public.
const designImgs = [
  "/addon-art.webp",
  "/addon-catalogue.webp",
  "/addon-chrome.webp",
  "/service-1.webp",
  "/service-2.webp",
  "/service-3.webp",
];
export const designs: Design[] = Array.from({ length: 12 }, (_, i) => ({
  name: `Art ${i + 1}`,
  img: designImgs[i % designImgs.length],
}));

// ---- Calendar (fixed June 2026, matching the Figma date picker) -------------
// Month/weekday labels come from the dictionary (`content[lang].date`), so the
// formatters below take that object and render in the active language.
export const CAL_YEAR = 2026;
export const CAL_MONTH = 5; // June (0-indexed)

// Column index (0 = Sat) for a given day-of-month in the fixed month.
function colIndex(day: number): number {
  const jsDow = new Date(CAL_YEAR, CAL_MONTH, day).getDay(); // 0 = Sun … 6 = Sat
  return (jsDow + 1) % 7; // shift so Saturday = 0
}
export const CAL_LEAD_BLANKS = colIndex(1); // empty cells before the 1st
export const CAL_DAYS_IN_MONTH = new Date(CAL_YEAR, CAL_MONTH + 1, 0).getDate();
// Earliest bookable day (days before this render faded, matching the design).
export const CAL_FIRST_BOOKABLE = 4;

export function weekdayFull(day: number, d: DateStrings): string {
  return d.weekdaysFull[colIndex(day)];
}
export function formatDate(day: number, d: DateStrings): string {
  return `${day} ${d.month} ${CAL_YEAR}`;
}
export function formatDateFull(day: number, d: DateStrings): string {
  const sep = d.month === "June" ? ", " : "، ";
  return `${weekdayFull(day, d)}${sep}${day} ${d.month} ${CAL_YEAR}`;
}

// Time slots 10:00 → 17:30 every 30 min (Figma grid).
export const TIME_SLOTS: string[] = Array.from({ length: 16 }, (_, i) => {
  const mins = 10 * 60 + i * 30;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
});

export function formatTime(slot: string, d: DateStrings): string {
  const [hStr, m] = slot.split(":");
  const h = Number(hStr);
  const period = h >= 12 ? d.pm : d.am;
  const h12 = h > 12 ? h - 12 : h;
  return `${h12}:${m} ${period}`;
}

// ---- Persisted selection ----------------------------------------------------
export type BookingSelection = {
  service: string | null;
  addons: string[];
  removal: string | null;
  design: string | null;
  day: number | null;
  time: string | null;
  total: number;
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
