// Sidebar structure. `cap` gates visibility; `soon` marks modules that land in a
// later phase (docs/ADMIN-PANEL.md §8) — they render disabled rather than being
// hidden, so staff can see what's coming instead of wondering what's missing.

import type { Capability } from "@/lib/auth/rbac";
import type { AdminStrings } from "@/lib/admin/strings";

export type NavItem = {
  key: keyof AdminStrings["nav"];
  href: string;
  icon: string; // lucide icon name, resolved in Sidebar
  cap: Capability;
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
      { key: "dashboard", href: "/admin", icon: "LayoutDashboard", cap: "dashboard.view" },
      { key: "bookings", href: "/admin/bookings", icon: "CalendarDays", cap: "bookings.view" },
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
