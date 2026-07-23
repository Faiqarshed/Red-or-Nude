"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { diffOf, recordAudit } from "@/lib/audit";

export type Result = { ok: true } | { ok: false; error: string };

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().max(120).nullable(),
  email: z.string().email().nullable().or(z.literal("")),
  notes: z.string().max(2000).nullable(),
  blocked: z.boolean(),
});

export async function updateCustomer(input: z.input<typeof updateSchema>): Promise<Result> {
  const actor = await requireCan("customers.manage");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;

  const [before] = await db.select().from(customers).where(eq(customers.id, d.id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };

  const values = {
    name: d.name || null,
    email: d.email || null,
    notes: d.notes || null,
    blocked: d.blocked,
    updatedAt: new Date(),
  };

  await db.update(customers).set(values).where(eq(customers.id, d.id));

  // Blocking someone is a decision worth being able to trace back to a person.
  await recordAudit(actor, {
    action: "update",
    entity: "customers",
    entityId: d.id,
    diff: diffOf(before as unknown as Record<string, unknown>, values),
  });

  revalidatePath("/admin/customers");
  return { ok: true };
}
