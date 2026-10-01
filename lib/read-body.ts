import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * A route's JSON body, checked against its schema, or the 400 to send back:
 * `invalid-json` when it does not parse, `invalid` with the fields that failed
 * when it does not fit.
 */
export async function readBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: NextResponse }> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { ok: false, res: NextResponse.json({ error: "invalid-json" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join("."));
    return { ok: false, res: NextResponse.json({ error: "invalid", issues }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}
