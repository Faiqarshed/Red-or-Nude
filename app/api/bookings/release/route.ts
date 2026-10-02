// Let go of an unpaid hold — the customer went back from checkout to change it.
// See releaseWebHold in lib/bookings.ts for who may, and what comes back.

import { NextResponse } from "next/server";
import { z } from "zod";
import { heldState, releaseWebHold } from "@/lib/bookings";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

const body = z.object({
  code: z.string().trim().min(1).max(20),
  email: z.string().trim().min(1).max(200),
});

export async function POST(request: Request) {
  if (throttled(`booking-release:${clientIp(request)}`, { max: 20 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // The same answer whether the code is wrong, the email is, or it was already
  // gone: which of those it was is not the caller's to learn.
  const { code, email } = parsed.data;
  if (await releaseWebHold(code, email)) return NextResponse.json({ released: true });
  // Kept: say why, so the checkout can show what she already has.
  return NextResponse.json({ released: false, kept: await heldState(code, email) });
}
