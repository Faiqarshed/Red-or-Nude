// Sidebar structure. `cap` gates visibility; `soon` marks modules that land in a
// later phase (docs/ADMIN-PANEL.md §8) — they render disabled rather than being
// hidden, so staff can see what's coming instead of wondering what's missing.

import type { Capability } from "@/lib/auth/rbac";
import type { AdminStrings } from "@/lib/admin/strings";

export type NavItem = {
  key: keyof AdminStrings["nav"];
  href: string;
  icon: string; // lucide icon name, resolved in Sidebar
  /** Omitted where every signed-in role may reach the page — see /admin. */
  cap?: Capability;
  soon?: boolean;
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
      { key: "designs", href: "/admin/designs", icon: "Palette", cap: "designs.manage", soon: true },
      { key: "giftCards", href: "/admin/gift-cards", icon: "Gift", cap: "giftcards.issue" },
    ],
  },
  {
    key: "people",
    items: [
      { key: "customers", href: "/admin/customers", icon: "Users", cap: "customers.manage" },
      { key: "staff", href: "/admin/staff", icon: "IdCard", cap: "staff.manage" },
      { key: "performance", href: "/admin/performance", icon: "Timer", cap: "staff.performance" },
      // Ratings are read by whoever reads bookings — front desk included, and
      // technicians deliberately not.
      { key: "reviews", href: "/admin/reviews", icon: "Star", cap: "bookings.view" },
    ],
  },
  {
    key: "site",
    items: [
      { key: "branches", href: "/admin/branches", icon: "MapPin", cap: "branches.manage", soon: true },
      { key: "content", href: "/admin/content", icon: "FileText", cap: "content.manage", soon: true },
      // The first piece of Marketing to actually land; the rest of that module
      // (offers, carousel scheduling) is still the `soon` item below.
      { key: "promoCodes", href: "/admin/promo-codes", icon: "Ticket", cap: "marketing.manage" },
      { key: "marketing", href: "/admin/marketing", icon: "Megaphone", cap: "marketing.manage", soon: true },
    ],
  },
  {
    key: "system",
    items: [
      { key: "settings", href: "/admin/settings", icon: "Settings", cap: "settings.manage", soon: true },
      { key: "auditLog", href: "/admin/audit", icon: "ScrollText", cap: "audit.view" },
    ],
  },
];
