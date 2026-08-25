// Role-based access control — the matrix in docs/ADMIN-PANEL.md §7.
//
// The sidebar hides what a role can't reach, but that's cosmetic. The check that
// matters is the one in the Server Action / route handler: see requireCan() in
// lib/auth/guard.ts. Never rely on a hidden nav item as an access control.

import type { StaffRole } from "@/lib/db/schema";

export type Capability =
  | "dashboard.view"
  | "dashboard.revenue"
  | "bookings.view"
  | "bookings.manage"
  | "bookings.checkin" // the front desk: ticket lookup, check in, close the ticket
  | "bookings.reschedule" // moving an appointment — deliberately NOT admin, see below
  | "bookings.own" // technicians: their own bookings, status changes only
  | "availability.manage"
  | "catalog.manage"
  | "designs.manage"
  | "media.manage"
  | "customers.manage"
  | "giftcards.issue"
  | "giftcards.adjust"
  | "staff.manage"
  | "staff.performance" // per-technician timings behind brief §3.2
  | "branches.manage"
  | "content.manage"
  | "marketing.manage"
  | "payments.view"
  | "payments.refund"
  | "settings.manage"
  | "audit.view";

const MATRIX: Record<StaffRole, Capability[]> = {
  ceo: [
    "dashboard.view",
    "dashboard.revenue",
    "bookings.view",
    "bookings.manage",
    "bookings.checkin",
    "bookings.reschedule",
    "bookings.own",
    "availability.manage",
    "catalog.manage",
    "designs.manage",
    "media.manage",
    "customers.manage",
    "giftcards.issue",
    "giftcards.adjust",
    "staff.manage",
    "staff.performance",
    "branches.manage",
    "content.manage",
    "marketing.manage",
    "payments.view",
    "payments.refund",
    "settings.manage",
    "audit.view",
  ],
  admin: [
    // Revenue is branch-scoped for admins — the figure is filtered by branchId
    // in the query, not by withholding the capability.
    "dashboard.view",
    "dashboard.revenue",
    "bookings.view",
    "bookings.manage",
    "bookings.checkin",
    "bookings.own",
    "availability.manage",
    // Brief §3.3: "manage the services listed on the booking site (add, edit,
    // remove, per branch)". This is the one thing admin gained over the manager
    // role it replaced.
    "catalog.manage",
    "designs.manage",
    "media.manage",
    "customers.manage",
    "giftcards.issue",
    "giftcards.adjust",
    "staff.manage",
    "staff.performance",
    "branches.manage",
    "content.manage",
    "marketing.manage",
    "payments.view",
    // Deliberately absent: "bookings.reschedule". Brief §3.3 — "Admin cannot
    // change a booking's timing." It is its own capability precisely because
    // admin needs the rest of bookings.manage.
  ],
  receptionist: [
    // No dashboard.view: /admin renders them the front desk instead, which
    // carries its own counters. The capability means "the revenue dashboard",
    // and the front desk is not that.
    "bookings.view",
    "bookings.manage",
    "bookings.checkin",
    // The desk is who actually moves an appointment when a customer rings up.
    // The brief only forbids this to admin.
    "bookings.reschedule",
    "bookings.own",
    "customers.manage",
    "giftcards.issue",
  ],
  technician: ["bookings.own"],
};

export function can(role: StaffRole | undefined | null, cap: Capability): boolean {
  if (!role) return false;
  return MATRIX[role]?.includes(cap) ?? false;
}

export function canAny(role: StaffRole | undefined | null, caps: Capability[]): boolean {
  return caps.some((c) => can(role, c));
}

/** The CEO sees every branch; everyone else is pinned to the one they belong to. */
export function scopedBranchId(
  role: StaffRole | undefined | null,
  branchId: string | null | undefined,
): string | null {
  if (role === "ceo") return null; // null = no filter
  return branchId ?? null;
}

export const ROLE_LABELS: Record<StaffRole, { ar: string; en: string }> = {
  ceo: { ar: "الرئيس التنفيذي", en: "CEO" },
  admin: { ar: "مدير", en: "Admin" },
  receptionist: { ar: "موظف استقبال", en: "Receptionist" },
  technician: { ar: "فنية", en: "Technician" },
};
