// Sidebar structure. `cap` gates visibility. Only sections that exist are
// listed: the "Soon" placeholders for designs, branches, content, marketing
// and settings were taken out at the salon's request.

import type { Capability } from "@/lib/auth/rbac";
import type { AdminStrings } from "@/lib/admin/strings";

export type NavItem = {
  key: keyof AdminStrings["nav"];
  href: string;
  icon: string; // lucide icon name, resolved in Sidebar
  /** Omitted where every signed-in role may reach the page — see /admin. */
  cap?: Capability;
};

export type NavGroup = {
  key: keyof AdminStrings["groups"];
  items: NavItem[];
};

export const NAV: NavGroup[] = [
  {
    key: "operations",
    items: [
      // No capability: /admin is where every role lands, and it renders each of
      // them a different screen. Gating the link would leave a technician with
      // an empty sidebar pointing at nothing.
      { key: "dashboard", href: "/admin", icon: "LayoutDashboard" },
      { key: "bookings", href: "/admin/bookings", icon: "CalendarDays", cap: "bookings.view" },
      // Its own section rather than a banner on Bookings. It is a backlog, not
      // a property of the day being viewed — an unresolved flag from Friday has
      // to still be there on Monday, and eighteen of them pushed the whole
      // bookings screen off the bottom of the page.
      { key: "noShows", href: "/admin/no-shows", icon: "UserX", cap: "bookings.manage" },
      // The desk, and the floor behind it. Both on bookings.checkin rather than
      // a receptionist-only gate: an admin covering a lunch break or the CEO
      // chasing a stuck ticket has the capability and needs somewhere to use it.
      // The receptionist still lands on the desk at /admin regardless.
      { key: "frontDesk", href: "/admin/front-desk", icon: "Ticket", cap: "bookings.checkin" },
      { key: "floor", href: "/admin/floor", icon: "UserCog", cap: "bookings.checkin" },
      { key: "availability", href: "/admin/availability", icon: "Clock", cap: "availability.manage" },
    ],
  },
  {
    key: "catalogue",
    items: [
      { key: "catalog", href: "/admin/catalog", icon: "Sparkles", cap: "catalog.manage" },
      { key: "media", href: "/admin/media", icon: "Images", cap: "media.manage" },
      { key: "packs", href: "/admin/memberships", icon: "Package", cap: "catalog.manage" },
      { key: "giftCards", href: "/admin/gift-cards", icon: "Gift", cap: "giftcards.issue" },
    ],
  },
  {
    key: "people",
    items: [
      { key: "customers", href: "/admin/customers", icon: "Users", cap: "customers.manage" },
      { key: "staff", href: "/admin/staff", icon: "IdCard", cap: "staff.manage" },
      // A day at a time, for any day. Performance below is the same people over
      // a period — two questions, and the same capability answers both.
      { key: "technicians", href: "/admin/technicians", icon: "UsersRound", cap: "staff.performance" },
      { key: "performance", href: "/admin/performance", icon: "Timer", cap: "staff.performance" },
      // Ratings are read by whoever reads bookings — front desk included, and
      // technicians deliberately not.
      { key: "reviews", href: "/admin/reviews", icon: "Star", cap: "bookings.view" },
    ],
  },
  {
    key: "site",
    items: [
      { key: "promoCodes", href: "/admin/promo-codes", icon: "Ticket", cap: "marketing.manage" },
    ],
  },
  {
    key: "system",
    items: [
      { key: "auditLog", href: "/admin/audit", icon: "ScrollText", cap: "audit.view" },
    ],
  },
  {
    key: "perks",
    items: [
      // It used to be a banner above each home screen; she looks it up once a
      // month, so it lives here. Only the roles that hold a code see it.
      { key: "myCode", href: "/admin/my-code", icon: "Ticket", cap: "staff.discount" },
    ],
  },
];
