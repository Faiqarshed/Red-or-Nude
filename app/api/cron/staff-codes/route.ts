// Monthly renewal of the per-staff discount codes (brief §3.3).
//
// Schedule this for the 1st of the month in vercel.json:
//   { "crons": [{ "path": "/api/cron/staff-codes", "schedule": "0 1 1 * *" }] }
//
// Safe to run more than once: issueMonthlyCode skips anyone who already has a
// code inside the window, so a retried or double-fired cron issues nothing
// twice. It is also safe to run late — the code is dated to the month it is
// issued in, not to the moment the job ran.

import { NextResponse } from "next/server";
import { issueMonthlyCodesForEveryone } from "@/lib/staff-codes";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // A cron endpoint is a public URL. Without this, anyone could mint the
  // salon's 90%-off codes on demand.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await issueMonthlyCodesForEveryone();
  return NextResponse.json({ ok: true, ...result });
}
