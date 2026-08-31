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
  | "bookings.reschedule" // moving an appointment — its own capability, see below
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
    // Brief §3.3 says "Admin cannot change a booking's timing", and this was
    // deliberately absent for that reason. The salon overrode it on 2026-08-28:
    // an admin covering the desk had no way to move an appointment a customer
    // was on the phone about. Granted knowingly, not leaked — if you are
    // reconciling against the brief, this is the line that departs from it.
    "bookings.reschedule",
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

/**
 * Must this role belong to exactly one branch?
 *
 * A receptionist works one front desk and a technician stands at one chair, so
 * "all branches" means nothing for either. It is not cosmetic: scopedBranchId()
 * below reads a null branch as "no filter", so an unpinned receptionist would
 * quietly see every branch's customers and bookings.
 *
 * The CEO spans branches by definition, and an admin may be regional.
 *
 * One definition, used by the staff form to grey the option out and by
 * saveStaff to refuse it — a rule enforced in only one of those two places is a
 * rule with a hole in it.
 */
export function mustHaveBranch(role: StaffRole): boolean {
  return role === "receptionist" || role === "technician";
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
