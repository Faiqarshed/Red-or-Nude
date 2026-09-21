import { NextResponse } from "next/server";

/** A cron endpoint is a public URL: a 401 unless the caller holds CRON_SECRET, else null. */
export function cronDenied(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
