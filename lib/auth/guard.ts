// Server-side access checks. Every Server Action and admin page calls one of
// these — middleware only proves *someone* is signed in, not that they may act.

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "./index";
import { can, type Capability } from "./rbac";
import { db } from "@/lib/db";
import { staff, type StaffRole } from "@/lib/db/schema";

export type SessionStaff = {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  branchId: string | null;
};

/**
 * Local dev only (`next dev`; never true for `next start`/deployed builds):
 * stand in for a real session so the login screen isn't required. Picks the
 * seeded CEO account (falling back to any active staff row) so capability
 * checks still exercise real RBAC instead of an all-access shortcut.
 */
async function devFallbackStaff(): Promise<SessionStaff | null> {
  if (process.env.NODE_ENV === "production") return null;

  const [owner] = await db.select().from(staff).where(eq(staff.role, "ceo")).limit(1);
  const [row] = owner
    ? [owner]
    : await db.select().from(staff).where(eq(staff.active, true)).limit(1);
  if (!row) return null;

  return { id: row.id, name: row.name, email: row.email, role: row.role, branchId: row.branchId };
}

/**
 * Who is signed in on the staff side, read from the row and not from the token.
 *
 * The session is a 12-hour JWT carrying `role` and `branchId`, stamped at
 * sign-in. Trusting that stamp meant a member kept whatever authority they had
 * when they logged in for the rest of the shift: demote someone, move them to
 * another branch or switch them off entirely and nothing happened until the
 * token lapsed. The panel can refuse to deactivate the last CEO and still hand
 * a deactivated technician twelve more hours of the floor.
 *
 * So the token now proves only *who*, and the row decides *what* — which is
 * exactly how currentCustomer() has always treated `customers.blocked`, and for
 * the same reason. The read costs nothing new: every caller loads staff data
 * anyway, and the alternative is a revocation that doesn't revoke.
 */
export async function currentStaff(): Promise<SessionStaff | null> {
  const session = await auth();
  const user = (session?.user as SessionStaff | undefined) ?? null;
  if (!user?.id) return devFallbackStaff();

  const [row] = await db.select().from(staff).where(eq(staff.id, user.id)).limit(1);
  // Deleted, or switched off since they signed in. Either way the next request
  // is signed out rather than carrying yesterday's authority.
  if (!row || !row.active) return null;

  return { id: row.id, name: row.name, email: row.email, role: row.role, branchId: row.branchId };
}

/** For pages: bounce to login when signed out. */
export async function requireStaff(): Promise<SessionStaff> {
  const user = await currentStaff();
  if (!user) redirect("/admin/login");
  return user;
}

/** For pages: bounce when the role lacks the capability. */
export async function requirePage(cap: Capability): Promise<SessionStaff> {
  const user = await requireStaff();
  if (!can(user.role, cap)) redirect("/admin?denied=" + encodeURIComponent(cap));
  return user;
}

export class ForbiddenError extends Error {
  constructor(cap: Capability) {
    super(`Forbidden: missing capability "${cap}"`);
    this.name = "ForbiddenError";
  }
}

/** For Server Actions: throw rather than redirect, so the caller can report it. */
export async function requireCan(cap: Capability): Promise<SessionStaff> {
  const user = await currentStaff();
  if (!user) throw new ForbiddenError(cap);
  if (!can(user.role, cap)) throw new ForbiddenError(cap);
  return user;
}
