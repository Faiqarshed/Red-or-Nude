import { desc, eq, inArray } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import {
  addons,
  auditLog,
  bookings,
  branches,
  closures,
  customers,
  giftCardDesigns,
  giftCardValues,
  giftCards,
  media,
  packs,
  promoCodes,
  removalTypes,
  services,
  staff,
  staffTimeOff,
  stations,
  type Localized,
} from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { AUDIT_LABEL_KEY } from "@/lib/audit";
import { adminStrings } from "@/lib/admin/strings";
import { halalasToSar } from "@/lib/money";
import { closureDays, dayRange } from "@/lib/time";
import AuditView, { type AuditName } from "./AuditView";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AuditPage() {
  await requirePage("audit.view");

  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(100);

  // What each row is about, by name. A name recorded with the entry wins: it is
  // what the item was called at the time, and the only name a deleted item
  // still has. Otherwise the live row is looked up, one query per kind.
  const idsOf = (entity: string) => [
    ...new Set(rows.filter((r) => r.entity === entity && r.entityId && UUID.test(r.entityId)).map((r) => r.entityId!)),
  ];
  type Named = { id: string; name: AuditName | null };
  const live = new Map<string, AuditName>();
  const load = async (entity: string, query: (ids: string[]) => Promise<Named[]>) => {
    const ids = idsOf(entity);
    if (!ids.length) return;
    for (const r of await query(ids)) if (r.name) live.set(`${entity}:${r.id}`, r.name);
  };

  // Branch hours are keyed "branchId:weekday", not by a row id.
  const hourKeys = rows.filter((r) => r.entity === "branch_hours" && r.entityId?.includes(":"));
  const branchIds = [...new Set(hourKeys.map((r) => r.entityId!.split(":")[0]).filter((id) => UUID.test(id)))];

  // Staff referenced inside the changes themselves: who was assigned, who went home.
  const peopleIds = new Set<string>();
  for (const r of rows) {
    for (const key of ["technicianId", "staffId"]) {
      const c = r.diff?.[key];
      for (const v of [c?.from, c?.to]) if (typeof v === "string" && UUID.test(v)) peopleIds.add(v);
    }
  }

  // Most kinds are named by one column of their own row.
  const loadColumn = (entity: string, table: PgTable, id: AnyPgColumn, name: AnyPgColumn) =>
    load(entity, (ids) => db.select({ id, name }).from(table).where(inArray(id, ids)) as unknown as Promise<Named[]>);

  const [branchRows, peopleRows] = await Promise.all([
    branchIds.length
      ? db.select({ id: branches.id, name: branches.name }).from(branches).where(inArray(branches.id, branchIds))
      : Promise.resolve([] as { id: string; name: Localized }[]),
    peopleIds.size
      ? db.select({ id: staff.id, name: staff.name }).from(staff).where(inArray(staff.id, [...peopleIds]))
      : Promise.resolve([] as { id: string; name: string }[]),
    loadColumn("services", services, services.id, services.name),
    loadColumn("addons", addons, addons.id, addons.name),
    loadColumn("removal_types", removalTypes, removalTypes.id, removalTypes.name),
    loadColumn("packs", packs, packs.id, packs.name),
    loadColumn("gift_card_designs", giftCardDesigns, giftCardDesigns.id, giftCardDesigns.name),
    loadColumn("staff", staff, staff.id, staff.name),
    loadColumn("stations", stations, stations.id, stations.label),
    loadColumn("bookings", bookings, bookings.id, bookings.code),
    loadColumn("gift_cards", giftCards, giftCards.id, giftCards.code),
    loadColumn("promo_codes", promoCodes, promoCodes.id, promoCodes.code),
    loadColumn("media", media, media.id, media.path),
    load("customers", async (ids) =>
      (await db.select({ id: customers.id, name: customers.name, phone: customers.phone }).from(customers).where(inArray(customers.id, ids))).map(
        (c) => ({ id: c.id, name: c.name || c.phone }),
      ),
    ),
    load("gift_card_values", async (ids) =>
      (await db.select({ id: giftCardValues.id, amount: giftCardValues.amountHalalas }).from(giftCardValues).where(inArray(giftCardValues.id, ids))).map(
        (v) => ({ id: v.id, name: `${halalasToSar(v.amount).toLocaleString("en-US")} SAR` }),
      ),
    ),
    load("closures", async (ids) =>
      (await db.select().from(closures).where(inArray(closures.id, ids))).map((c) => {
        const d = closureDays(c.startsAt, c.endsAt);
        return { id: c.id, name: dayRange(d.from, d.to) };
      }),
    ),
    load("staff_time_off", async (ids) =>
      (
        await db
          .select({ id: staffTimeOff.id, who: staff.name, from: staffTimeOff.startsOn, to: staffTimeOff.endsOn })
          .from(staffTimeOff)
          .innerJoin(staff, eq(staff.id, staffTimeOff.staffId))
          .where(inArray(staffTimeOff.id, ids))
      ).map((o) => ({ id: o.id, name: `${o.who} · ${dayRange(o.from, o.to)}` })),
    ),
  ]);

  const branchName = new Map(branchRows.map((b) => [b.id, b.name]));
  const nameOf = (r: (typeof rows)[number]): AuditName | null => {
    const recorded = r.diff?.[AUDIT_LABEL_KEY]?.to as AuditName | undefined;
    if (recorded) return recorded;
    if (r.entity === "branch_hours" && r.entityId?.includes(":")) {
      const [branchId, weekday] = r.entityId.split(":");
      const b = branchName.get(branchId);
      const w = Number(weekday);
      return {
        ar: [b?.ar, adminStrings.ar.availability.weekdays[w]].filter(Boolean).join(" · "),
        en: [b?.en, adminStrings.en.availability.weekdays[w]].filter(Boolean).join(" · "),
      };
    }
    return r.entityId ? (live.get(`${r.entity}:${r.entityId}`) ?? null) : null;
  };

  return (
    <AuditView
      people={Object.fromEntries(peopleRows.map((p) => [p.id, p.name]))}
      rows={rows.map((r) => {
        const { [AUDIT_LABEL_KEY]: _label, ...diff } = r.diff ?? {};
        return {
          id: r.id,
          actorName: r.actorName,
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
          name: nameOf(r),
          diff,
          createdAt: r.createdAt.toISOString(),
        };
      })}
    />
  );
}
