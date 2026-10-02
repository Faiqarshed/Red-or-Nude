// Monthly renewal of the per-staff discount codes (brief §3.3).
//
// Scheduled in vercel.json for 21:00 UTC every day, which is midnight in
// Riyadh. Daily rather than "on the 1st" because a cron can't say "the last day
// of the month" and the Hobby plan fires somewhere inside the hour anyway: on
// every other night this finds every code already current and does nothing.
//
// Safe to run more than once: issueMonthlyCode leaves a code whose window is
// already this month alone, so a missed night is caught by the next one.

import { NextResponse } from "next/server";
import { issueMonthlyCodesForEveryone } from "@/lib/staff-codes";
import { cronDenied } from "@/lib/cron";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // A cron endpoint is a public URL. Without this, anyone could mint the
  // salon's 90%-off codes on demand.
  const denied = cronDenied(request);
  if (denied) return denied;

  const result = await issueMonthlyCodesForEveryone();
  return NextResponse.json({ ok: true, ...result });
}
