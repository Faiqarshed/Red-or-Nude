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
 * seeded owner account (falling back to any active staff row) so capability
 * checks still exercise real RBAC instead of an all-access shortcut.
 */
async function devFallbackStaff(): Promise<SessionStaff | null> {
  if (process.env.NODE_ENV === "production") return null;

  const [owner] = await db.select().from(staff).where(eq(staff.role, "owner")).limit(1);
  const [row] = owner
    ? [owner]
    : await db.select().from(staff).where(eq(staff.active, true)).limit(1);
  if (!row) return null;

  return { id: row.id, name: row.name, email: row.email, role: row.role, branchId: row.branchId };
}

export async function currentStaff(): Promise<SessionStaff | null> {
  const session = await auth();
  const user = (session?.user as SessionStaff | undefined) ?? null;
  return user ?? devFallbackStaff();
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
