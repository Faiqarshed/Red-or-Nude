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
  // Setting a booking to any status by hand — cancelled, no-show, completed
  // out of order. Split out of bookings.manage, which everyone at the desk
  // holds: check-in and closing a ticket are the desk's own moves and stay
  // on bookings.checkin, while overwriting the record is not something a
  // busy counter should be able to do by mis-clicking.
  | "bookings.status"
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
    "bookings.status",
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
    // No bookings.reschedule and no bookings.status. Brief §3.3 says "Admin
    // cannot change a booking's timing"; it was granted anyway on 2026-08-28
    // so an admin covering the desk could move an appointment a customer was
    // ringing about, and taken back on 2026-09-01 at the salon's request.
    // check-roles.ts asserts it, and was failing for the whole period the
    // override was in place.
    //
    // An admin covering the desk is now covered by the desk's own login, not
    // by widening this one — the receptionist keeps bookings.reschedule.
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
    // The desk is who actually moves an appointment when a customer rings up,
    // and the brief only ever forbade this to admin. Briefly taken away on
    // 2026-09-01 alongside admin's and given straight back: the alternative at
    // the counter is cancel-and-rebook, which loses the ticket number.
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
