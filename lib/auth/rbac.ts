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
  | "bookings.own" // technicians: their own bookings, status changes only
  | "availability.manage"
  | "catalog.manage"
  | "designs.manage"
  | "media.manage"
  | "customers.manage"
  | "giftcards.issue"
  | "giftcards.adjust"
  | "staff.manage"
  | "branches.manage"
  | "content.manage"
  | "marketing.manage"
  | "payments.view"
  | "payments.refund"
  | "settings.manage"
  | "audit.view";

const MATRIX: Record<StaffRole, Capability[]> = {
  owner: [
    "dashboard.view",
    "dashboard.revenue",
    "bookings.view",
    "bookings.manage",
    "bookings.own",
    "availability.manage",
    "catalog.manage",
    "designs.manage",
    "media.manage",
    "customers.manage",
    "giftcards.issue",
    "giftcards.adjust",
    "staff.manage",
    "branches.manage",
    "content.manage",
    "marketing.manage",
    "payments.view",
    "payments.refund",
    "settings.manage",
    "audit.view",
  ],
  manager: [
    // Revenue is branch-scoped for managers — the figure is filtered by
    // branchId in the query, not by withholding the capability.
    "dashboard.view",
    "dashboard.revenue",
    "bookings.view",
    "bookings.manage",
    "bookings.own",
    "availability.manage",
    "designs.manage",
    "media.manage",
    "customers.manage",
    "giftcards.issue",
    "giftcards.adjust",
    "staff.manage",
    "branches.manage",
    "content.manage",
    "marketing.manage",
    "payments.view",
  ],
  receptionist: [
    "dashboard.view",
    "bookings.view",
    "bookings.manage",
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

/** Owners see every branch; everyone else is pinned to the one they belong to. */
export function scopedBranchId(
  role: StaffRole | undefined | null,
  branchId: string | null | undefined,
): string | null {
  if (role === "owner") return null; // null = no filter
  return branchId ?? null;
}

export const ROLE_LABELS: Record<StaffRole, { ar: string; en: string }> = {
  owner: { ar: "المالك", en: "Owner" },
  manager: { ar: "مدير", en: "Manager" },
  receptionist: { ar: "موظف استقبال", en: "Receptionist" },
  technician: { ar: "فنية", en: "Technician" },
};
