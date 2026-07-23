import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import AuditView from "./AuditView";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await requirePage("audit.view");

  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(100);

  return (
    <AuditView
      rows={rows.map((r) => ({
        id: r.id,
        actorName: r.actorName,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        diff: r.diff,
        createdAt: r.createdAt.toISOString(),
      }))}
    />
  );
}
