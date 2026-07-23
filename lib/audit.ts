// Audit trail. Prices and bookings are money — every mutation writes a row.
//
// Usage inside a Server Action, after the write succeeds:
//   await recordAudit(actor, { action: "update", entity: "services",
//                              entityId: id, diff: diffOf(before, after) })

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import type { SessionStaff } from "@/lib/auth/guard";

export type AuditDiff = Record<string, { from: unknown; to: unknown }>;

export type AuditEntry = {
  action: string; // create | update | delete | refund | cancel | …
  entity: string; // table name
  entityId?: string | null;
  diff?: AuditDiff;
};

export async function recordAudit(actor: SessionStaff, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorId: actor.id,
      actorName: actor.name,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      diff: entry.diff ?? null,
    });
  } catch (err) {
    // A failed audit write must never roll back the business change the user
    // just made — but it must be loud in the logs.
    console.error("[audit] failed to record", entry, err);
  }
}

/** Shallow field-level diff, skipping unchanged keys and noisy timestamps. */
export function diffOf<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: Partial<T>,
  skip: string[] = ["updatedAt", "createdAt"],
): AuditDiff {
  const diff: AuditDiff = {};
  for (const [key, next] of Object.entries(after)) {
    if (skip.includes(key)) continue;
    const prev = before?.[key];
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    diff[key] = { from: prev ?? null, to: next ?? null };
  }
  return diff;
}
