// Which branch a page is showing, and whether the reader may change it.
//
// Every branch-scoped screen was already doing half of this with
// `scopedBranchId(role, user.branchId)`: a receptionist or an admin is pinned to
// their own branch, the CEO gets null and sees all of them merged. What was
// missing is the other half — the CEO could see everything at once and nothing
// in particular, so "how did Olaya do on Tuesday" had no answer on most screens.
//
// One function so the rule lives once. It returns the branch to filter by (null
// still meaning every branch) and the options to offer. Options come back empty
// for anyone pinned, which is what keeps a picker that could not change anything
// off their screen — the same honesty rule /admin/bookings already applied.

import "server-only";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches, type Localized } from "@/lib/db/schema";
import { scopedBranchId } from "@/lib/auth/rbac";
import type { StaffRole } from "@/lib/db/schema";

export type BranchOption = { id: string; name: Localized };

/**
 * The branch picker's options, cached in the process for a minute.
 *
 * Read twice on every admin page render — once by the shell layout for the top
 * bar, once below — for a list that changes when the company opens a third
 * salon. See docs/PERFORMANCE.md.
 *
 * ponytail: per-instance, lost on cold start, and nothing writes `branches`.
 */
const TTL_MS = 60_000;
let cache: { rows: BranchOption[]; at: number } | null = null;

export async function listBranches(): Promise<BranchOption[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .orderBy(asc(branches.sort));
  cache = { rows, at: Date.now() };
  return rows;
}

export type BranchScope = {
  /** Null means every branch — the CEO's default, and what the queries expect. */
  branchId: string | null;
  /** Empty for anyone pinned to one branch. */
  options: BranchOption[];
};

export async function branchScope(
  user: { role: StaffRole; branchId: string | null },
  requested?: string,
): Promise<BranchScope> {
  const pinned = scopedBranchId(user.role, user.branchId);
  if (pinned) return { branchId: pinned, options: [] };

  const rows = await listBranches();

  // An id that is not a branch is treated as "all", not as an error: a stale
  // link after a branch is removed should show the whole salon rather than an
  // empty screen the reader cannot explain.
  const branchId = requested && rows.some((b) => b.id === requested) ? requested : null;

  return { branchId, options: rows };
}
