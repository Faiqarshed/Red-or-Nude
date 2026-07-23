// Public booking creation. This is what replaces sessionStorage as the place a
// customer's appointment actually lives.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createBooking } from "@/lib/bookings";

export const dynamic = "force-dynamic";

const body = z.object({
  branchId: z.string().uuid(),
  serviceId: z.string().uuid(),
  addonIds: z.array(z.string().uuid()).max(20).default([]),
  removalTypeId: z.string().uuid().nullable().optional(),
  designId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime(),
  customer: z.object({
    name: z.string().trim().max(120).optional(),
    // Saudi mobile numbers, with or without country code.
    phone: z.string().trim().regex(/^(\+?966|0)?5\d{8}$/, "invalid-phone"),
    email: z.string().email().optional().or(z.literal("")),
    lang: z.enum(["ar", "en"]).optional(),
  }),
  notes: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }

  const result = await createBooking({ ...parsed.data, source: "web" });

  if (!result.ok) {
    // 409 for a lost race: the UI should refresh the slots and let the customer
    // pick again, rather than showing a generic failure.
    const status = result.error === "slot-taken" ? 409 : result.error === "blocked" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json(
    { id: result.id, code: result.code, totalHalalas: result.totalHalalas },
    { status: 201 },
  );
}
