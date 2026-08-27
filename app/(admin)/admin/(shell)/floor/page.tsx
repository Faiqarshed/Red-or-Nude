import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { loadFloor } from "./data";
import FloorView from "./FloorView";

export const dynamic = "force-dynamic";

export default async function FloorPage() {
  // The floor, not the staff records — so this is the desk's capability, the
  // same one that lets her check somebody in. See ./actions.ts.
  const user = await requirePage("bookings.checkin");

  // Same fallback the dashboard uses: an account with no branch pinned still
  // gets a usable screen rather than an empty one.
  const branchId =
    user.branchId ??
    (await db.select({ id: branches.id }).from(branches).orderBy(asc(branches.sort)).limit(1))[0]
      ?.id;

  if (!branchId) return <FloorView data={{ technicians: [], rows: [] }} />;

  return <FloorView data={await loadFloor(branchId)} />;
}
