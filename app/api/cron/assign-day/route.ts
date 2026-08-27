// The day's technician assignments, made before the salon opens (brief §3.1).
//
// Schedule this for early morning in vercel.json:
//   { "crons": [{ "path": "/api/cron/assign-day", "schedule": "0 4 * * *" }] }
// 04:00 UTC is 07:00 in Riyadh, comfortably before the first appointment.
//
// Safe to run more than once, and safe to run late: assignDay only fills rows
// where technician_id is null, so a retry, a double fire, or a mid-morning run
// assigns nothing twice and overwrites nobody's decision.
//
// To turn the whole thing off, drop the entry from vercel.json — the salon goes
// back to assigning one customer at a time at check-in, which is what it did
// before this job existed.

import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches } from "@/lib/db/schema";
import { assignDay } from "@/lib/assign";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // A cron endpoint is a public URL. Without this, anyone could reshuffle the
  // salon's floor from the outside.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.active, true)))
    .orderBy(asc(branches.sort));

  let assigned = 0;
  let unassigned = 0;

  // Branch by branch rather than all at once: technicians belong to one branch,
  // so there is nothing to balance across them, and one branch's empty floor
  // must not stall another's.
  for (const branch of rows) {
    const result = await assignDay(branch.id);
    assigned += result.assigned;
    unassigned += result.unassigned;
  }

  return NextResponse.json({ ok: true, branches: rows.length, assigned, unassigned });
}
