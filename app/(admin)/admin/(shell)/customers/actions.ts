"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { requireCan } from "@/lib/auth/guard";
import { diffOf, recordAudit } from "@/lib/audit";
import { adminStrings } from "@/lib/admin/strings";
import { checkCustomer, hasErrors } from "@/lib/admin/validate";
import { toStoredPhone } from "@/lib/phone";

export type Result = { ok: true } | { ok: false; error: string };

const updateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim(),
  phone: z.string().trim(),
  email: z.string().trim(),
  notes: z.string().trim(),
  blocked: z.boolean(),
});

export async function updateCustomer(input: z.input<typeof updateSchema>): Promise<Result> {
  const actor = await requireCan("customers.manage");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;
  // The same checks the drawer ran.
  if (hasErrors(checkCustomer(adminStrings.en, d))) return { ok: false, error: "invalid" };

  const [before] = await db.select().from(customers).where(eq(customers.id, d.id)).limit(1);
  if (!before) return { ok: false, error: "not-found" };

  // 05XXXXXXXX: the one shape checkout matches a returning customer on.
  const phone = toStoredPhone(d.phone);

  // A verified email is her sign-in, and "verified" means she proved she reads
  // that inbox. An address typed here proves nothing, so a change drops the
  // flag: she is signed out and confirms the new one by code next time. Case
  // alone isn't a change: addresses aren't case sensitive.
  const email = d.email || null;
  const emailChanged = (email ?? "").toLowerCase() !== (before.email ?? "").toLowerCase();

  const values = {
    name: d.name || null,
    phone,
    email,
    notes: d.notes || null,
    blocked: d.blocked,
    ...(emailChanged && before.emailVerifiedAt ? { emailVerifiedAt: null } : {}),
    updatedAt: new Date(),
  };

  try {
    await db.update(customers).set(values).where(eq(customers.id, d.id));
  } catch (err) {
    // A number that belongs to someone else: customers_phone_unique refuses it,
    // race or no race. Drizzle wraps the driver's error in `cause`. Anything
    // else is a real failure and stays one.
    const pg = ((err as { cause?: unknown }).cause ?? err) as { constraint_name?: string };
    if (pg.constraint_name === "customers_phone_unique") return { ok: false, error: "phone-taken" };
    throw err;
  }

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
