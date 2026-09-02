import "server-only";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches, type Localized } from "@/lib/db/schema";

export type BranchOption = { id: string; name: Localized };

/**
 * The branch picker's options, cached in the process for a minute.
 *
 * Two salons, and the list changes when the company opens a third — which is to
 * say almost never. It was read twice on every admin page render, once by the
 * shell layout for the top bar and once by whichever screen wanted to know what
 * to filter by: 241 calls in a short session on Neon's insights, each 0ms of
 * work and a full round trip to Frankfurt.
 *
 * ponytail: same plain map as lib/settings.ts, and for the same reason — a
 * next/cache import would take the check scripts down with it. Per-instance,
 * lost on cold start. Nothing in the app writes `branches`, so the only
 * staleness is a hand-added branch taking up to a minute to appear.
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
