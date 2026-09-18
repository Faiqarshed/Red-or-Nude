import { asc, desc, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches, promoCodes, staff, staffTimeOff } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import StaffView, { type StaffRowDiscount } from "./StaffView";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const user = await requirePage("staff.manage");

  const [staffRows, branchRows, timeOffRows, codeRows] = await Promise.all([
    db.select().from(staff).orderBy(asc(staff.name)),
    db.select().from(branches).orderBy(asc(branches.sort)),
    // The whole table: a salon's leave list is a handful of rows, and grouping
    // it here saves the drawer a round trip every time it opens.
    db.select().from(staffTimeOff).orderBy(asc(staffTimeOff.startsOn)),
    // Each member's own discount code (brief §3.3). It lives in `promo_codes`
    // like every other code — what makes it hers is `staff_id` — but it is not
    // a campaign, so it belongs on her row here rather than on the marketing
    // screen, which now lists only the codes with no owner.
    db
      .select()
      .from(promoCodes)
      .where(isNotNull(promoCodes.staffId))
      .orderBy(desc(promoCodes.createdAt)),
  ]);

  // Newest first above, so the first one seen per person is the current one.
  // Older rows exist from before codes were renewed in place.
  const now = new Date();
  const codeFor = new Map<string, StaffRowDiscount>();
  for (const row of codeRows) {
    if (!row.staffId || codeFor.has(row.staffId)) continue;
    codeFor.set(row.staffId, {
      id: row.id,
      code: row.code,
      percent: row.value,
      // Both ways a code stops working, as one flag: the switch, and a month
      // that has ended. The row still shows either way — greyed, not gone.
      active: row.active && !(row.endsAt && row.endsAt <= now),
      // `max_uses` is 1, so any use at all is this month spent.
      used: row.uses > 0,
    });
  }

  const timeOff = new Map<string, { id: string; startsOn: string; endsOn: string }[]>();
  for (const row of timeOffRows) {
    timeOff.set(row.staffId, [
      ...(timeOff.get(row.staffId) ?? []),
      { id: row.id, startsOn: row.startsOn, endsOn: row.endsOn },
    ]);
  }

  return (
    <StaffView
      currentUserId={user.id}
      currentRole={user.role}
      branches={branchRows.map((b) => ({ id: b.id, name: b.name }))}
      staff={staffRows.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        phone: s.phone,
        role: s.role,
        branchId: s.branchId,
        active: s.active,
        lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
        // The hash never leaves the server.
        hasPassword: s.passwordHash !== null,
        timeOff: timeOff.get(s.id) ?? [],
        discount: codeFor.get(s.id) ?? null,
      }))}
    />
  );
}
