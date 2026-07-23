// Shell layout: everything under /admin except the login page.
// requireStaff() is the real gate — middleware only redirects anonymous hits.

import { db } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { asc } from "drizzle-orm";
import { requireStaff } from "@/lib/auth/guard";
import Shell from "@/components/admin/Shell";
import { signOutAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const user = await requireStaff();

  const branchOptions = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .orderBy(asc(branches.sort));

  return (
    <Shell user={user} branches={branchOptions} signOutAction={signOutAction}>
      {children}
    </Shell>
  );
}
