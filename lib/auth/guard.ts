// Server-side access checks. Every Server Action and admin page calls one of
// these — middleware only proves *someone* is signed in, not that they may act.

import { redirect } from "next/navigation";
import { auth } from "./index";
import { can, type Capability } from "./rbac";
import type { StaffRole } from "@/lib/db/schema";

export type SessionStaff = {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  branchId: string | null;
};

export async function currentStaff(): Promise<SessionStaff | null> {
  const session = await auth();
  return (session?.user as SessionStaff | undefined) ?? null;
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
