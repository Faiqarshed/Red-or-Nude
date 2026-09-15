// Audit trail. Prices and bookings are money — every mutation writes a row.
//
// Usage inside a Server Action, after the write succeeds:
//   await recordAudit(actor, { action: "update", entity: "services",
//                              entityId: id, diff: diffOf(before, after) })

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

export type AuditDiff = Record<string, { from: unknown; to: unknown }>;

/**
 * Where an entry's `label` is kept inside `diff`. The log reads it as the item's
 * name and never lists it as a change. It lives in `diff` rather than its own
 * column so recording it needed no migration.
 */
export const AUDIT_LABEL_KEY = "__label";

export type AuditEntry = {
  action: string; // create | update | delete | refund | cancel | …
  entity: string; // table name
  entityId?: string | null;
  diff?: AuditDiff;
  /**
   * What the item was called when this happened: "5", "Chrome", "RON-4F2K".
   * Worth passing on every delete: afterwards the row is gone and the log has
   * nothing else to say which one it was.
   */
  label?: string | { ar: string; en: string } | null;
};

/**
 * Who did it. A `SessionStaff` in almost every case — but not all: a customer
 * cancelling their own booking (brief §2.6) is a real, auditable mutation with
 * no staff member behind it, and `audit_log.actor_id` was already nullable for
 * exactly that shape. Narrower than SessionStaff on purpose, so callers can pass
 * one without inventing an email and a role for someone who has neither.
 */
export type AuditActor = { id: string | null; name: string };

export async function recordAudit(actor: AuditActor, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorId: actor.id,
      actorName: actor.name,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      diff:
        entry.label != null
          ? { ...entry.diff, [AUDIT_LABEL_KEY]: { from: null, to: entry.label } }
          : (entry.diff ?? null),
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
