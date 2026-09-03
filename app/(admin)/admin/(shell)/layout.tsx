// Shell layout: everything under /admin except the login page.
// requireStaff() is the real gate — middleware only redirects anonymous hits.

import { listBranches } from "@/lib/admin/branch-scope";
import { requireStaff } from "@/lib/auth/guard";
import Shell from "@/components/admin/Shell";
import { signOutAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const user = await requireStaff();

  const branchOptions = await listBranches();

  return (
    <Shell user={user} branches={branchOptions} signOutAction={signOutAction}>
      {children}
    </Shell>
  );
}
