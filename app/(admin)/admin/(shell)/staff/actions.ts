"use server";

import { revalidatePath } from "next/cache";
import { hash } from "bcryptjs";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { staff } from "@/lib/db/schema";
import { requireCan, type SessionStaff } from "@/lib/auth/guard";
import { recordAudit } from "@/lib/audit";
import type { StaffRole } from "@/lib/db/schema";
import { issueMonthlyCode } from "@/lib/staff-codes";

export type Result = { ok: true } | { ok: false; error: string };

// Higher number = more authority. Used to stop anyone granting or editing a role
// above their own — without this, an admin could simply make themselves CEO.
const RANK: Record<StaffRole, number> = {
  technician: 1,
  receptionist: 2,
  admin: 3,
  ceo: 4,
};

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(20).optional(),
  role: z.enum(["ceo", "admin", "receptionist", "technician"]),
  branchId: z.string().uuid().nullable().optional(),
  password: z.string().min(8).max(200).optional().or(z.literal("")),
  active: z.boolean(),
});

export type StaffInput = z.input<typeof saveSchema>;

/** Guards shared by every write here. */
async function assertMayEdit(
  actor: SessionStaff,
  targetRole: StaffRole,
  existingRole?: StaffRole,
): Promise<string | null> {
  if (RANK[targetRole] > RANK[actor.role]) return "cannot-escalate";
  // Editing someone senior to you is the same escalation by another route.
  if (existingRole && RANK[existingRole] > RANK[actor.role]) return "cannot-escalate";
  return null;
}

/** True when deactivating/removing this account would leave no active CEO. */
async function wouldOrphanCeos(targetId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staff)
    .where(and(eq(staff.role, "ceo"), eq(staff.active, true), ne(staff.id, targetId)));
  return (row?.n ?? 0) === 0;
}

export async function saveStaff(input: StaffInput): Promise<Result> {
  const actor = await requireCan("staff.manage");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const d = parsed.data;

  const existing = d.id
    ? (await db.select().from(staff).where(eq(staff.id, d.id)).limit(1))[0]
    : undefined;
  if (d.id && !existing) return { ok: false, error: "not-found" };

  const denied = await assertMayEdit(actor, d.role, existing?.role);
  if (denied) return { ok: false, error: denied };

  // A new account with no password could never sign in.
  if (!d.id && !d.password) return { ok: false, error: "password-required" };

  if (existing?.role === "ceo" && (!d.active || d.role !== "ceo")) {
    if (await wouldOrphanCeos(existing.id)) return { ok: false, error: "last-ceo" };
  }

  const values: Record<string, unknown> = {
    name: d.name,
    email: d.email.toLowerCase(),
    phone: d.phone || null,
    role: d.role,
    branchId: d.branchId ?? null,
    active: d.active,
    updatedAt: new Date(),
  };
  if (d.password) values.passwordHash = await hash(d.password, 10);

  try {
    if (d.id) {
      await db.update(staff).set(values).where(eq(staff.id, d.id));
      await recordAudit(actor, {
        action: "update",
        entity: "staff",
        entityId: d.id,
        // Never log the password or its hash.
        diff: {
          role: { from: existing?.role ?? null, to: d.role },
          active: { from: existing?.active ?? null, to: d.active },
        },
      });
    } else {
      const [row] = await db.insert(staff).values(values as never).returning({ id: staff.id });
      await recordAudit(actor, {
        action: "create",
        entity: "staff",
        entityId: row.id,
        diff: { role: { from: null, to: d.role } },
      });

      // Their code for the month they were hired in (brief §3.3). Every
      // following month comes from the cron, and issueMonthlyCode is idempotent
      // inside a window, so the two never collide. Deliberately not allowed to
      // fail the hire: a missing discount code is a nuisance, an account that
      // didn't save is a problem.
      try {
        await issueMonthlyCode(row.id);
      } catch (codeErr) {
        console.error("[staff] could not issue monthly code", codeErr);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("staff_email_unique")) return { ok: false, error: "email-taken" };
    console.error("[staff] save failed", err);
    return { ok: false, error: "failed" };
  }

  revalidatePath("/admin/staff");
  return { ok: true };
}

export async function setStaffActive(id: string, active: boolean): Promise<Result> {
  const actor = await requireCan("staff.manage");

  const [target] = await db.select().from(staff).where(eq(staff.id, id)).limit(1);
  if (!target) return { ok: false, error: "not-found" };

  const denied = await assertMayEdit(actor, target.role, target.role);
  if (denied) return { ok: false, error: denied };

  // Locking yourself out of the panel you administer.
  if (!active && id === actor.id) return { ok: false, error: "self" };
  if (!active && target.role === "ceo" && (await wouldOrphanCeos(id))) {
    return { ok: false, error: "last-ceo" };
  }

  await db.update(staff).set({ active, updatedAt: new Date() }).where(eq(staff.id, id));
  await recordAudit(actor, {
    action: "update",
    entity: "staff",
    entityId: id,
    diff: { active: { from: !active, to: active } },
  });

  revalidatePath("/admin/staff");
  return { ok: true };
}

export async function deleteStaff(id: string): Promise<Result> {
  const actor = await requireCan("staff.manage");

  const [target] = await db.select().from(staff).where(eq(staff.id, id)).limit(1);
  if (!target) return { ok: false, error: "not-found" };

  const denied = await assertMayEdit(actor, target.role, target.role);
  if (denied) return { ok: false, error: denied };
  if (id === actor.id) return { ok: false, error: "self" };
  if (target.role === "ceo" && (await wouldOrphanCeos(id))) {
    return { ok: false, error: "last-ceo" };
  }

  await db.delete(staff).where(eq(staff.id, id));
  await recordAudit(actor, { action: "delete", entity: "staff", entityId: id });

  revalidatePath("/admin/staff");
  return { ok: true };
}
