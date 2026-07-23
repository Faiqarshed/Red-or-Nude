import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { halalasToSar } from "@/lib/money";
import CustomersView, { type CustomerRow } from "./CustomersView";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  await requirePage("customers.manage");

  const q = (searchParams.q ?? "").trim();
  const filter = q
    ? or(ilike(customers.name, `%${q}%`), ilike(customers.phone, `%${q}%`))
    : undefined;

  // Aggregates come from the bookings table rather than being denormalised onto
  // the customer — one fewer thing that can silently go stale.
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
      notes: customers.notes,
      blocked: customers.blocked,
      createdAt: customers.createdAt,
      bookingsCount: sql<number>`count(${bookings.id})::int`,
      // Only completed appointments count as money actually taken.
      lifetimeHalalas: sql<number>`coalesce(sum(${bookings.totalHalalas}) filter (where ${bookings.status} = 'completed'), 0)::int`,
      noShows: sql<number>`count(*) filter (where ${bookings.status} = 'no_show')::int`,
      lastVisit: sql<string | null>`max(${bookings.startsAt}) filter (where ${bookings.status} = 'completed')`,
    })
    .from(customers)
    .leftJoin(bookings, eq(bookings.customerId, customers.id))
    .where(filter)
    .groupBy(customers.id)
    .orderBy(desc(customers.createdAt))
    .limit(200);

  const ids = rows.map((r) => r.id);
  const history = ids.length
    ? await db
        .select({
          id: bookings.id,
          customerId: bookings.customerId,
          code: bookings.code,
          startsAt: bookings.startsAt,
          status: bookings.status,
          serviceName: bookings.serviceName,
          totalHalalas: bookings.totalHalalas,
        })
        .from(bookings)
        .orderBy(desc(bookings.startsAt))
        .limit(500)
    : [];

  return (
    <CustomersView
      query={q}
      customers={rows.map(
        (r): CustomerRow => ({
          id: r.id,
          name: r.name,
          phone: r.phone,
          email: r.email,
          notes: r.notes,
          blocked: r.blocked,
          bookingsCount: r.bookingsCount,
          lifetimeSar: halalasToSar(r.lifetimeHalalas),
          noShows: r.noShows,
          lastVisit: r.lastVisit ? new Date(r.lastVisit).toISOString() : null,
          history: history
            .filter((h) => h.customerId === r.id)
            .map((h) => ({
              id: h.id,
              code: h.code,
              startsAt: h.startsAt.toISOString(),
              status: h.status,
              serviceName: h.serviceName,
              totalSar: halalasToSar(h.totalHalalas),
            })),
        }),
      )}
    />
  );
}
