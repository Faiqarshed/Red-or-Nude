import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches, staff } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import StaffView from "./StaffView";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const user = await requirePage("staff.manage");

  const [staffRows, branchRows] = await Promise.all([
    db.select().from(staff).orderBy(asc(staff.name)),
    db.select().from(branches).orderBy(asc(branches.sort)),
  ]);

  return (
    <StaffView
      currentUserId={user.id}
      currentRole={user.role}
      branches={branchRows.map((b) => ({ id: b.id, name: b.name }))}
      staff={staffRows.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        phone: s.phone,
        role: s.role,
        branchId: s.branchId,
        active: s.active,
        lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
        // The hash never leaves the server.
        hasPassword: s.passwordHash !== null,
      }))}
    />
  );
}
