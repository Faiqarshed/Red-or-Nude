// "Needs your decision": the wallet's cases for the owner (docs/WALLET-PLAN.md).
//
// Cases the wallet cannot settle by itself: a balance below zero after a
// payment behind spent credit went back to her card, or money on a cancelled
// booking with no customer to credit. Written to wallet_decisions from the
// moment the wallet can raise one; this is where the owner settles them, with
// a correction or without, and a reason either way.
//
// The owner's alone (`wallet.decide`): no staff action writes to a wallet.

import { asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, walletDecisions } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import WalletDecisionsView from "./WalletDecisionsView";

export const dynamic = "force-dynamic";

/** Enough for a queue the owner works through; there is no paging yet. */
const LIMIT = 100;

export default async function WalletDecisionsPage({ searchParams }: { searchParams: { tab?: string } }) {
  await requirePage("wallet.decide");
  const tab = searchParams.tab === "resolved" ? "resolved" : "open";

  const rows = await db
    .select({
      id: walletDecisions.id,
      kind: walletDecisions.kind,
      amountHalalas: walletDecisions.amountHalalas,
      createdAt: walletDecisions.createdAt,
      resolvedAt: walletDecisions.resolvedAt,
      resolutionNote: walletDecisions.resolutionNote,
      bookingCode: bookings.code,
      customerName: customers.name,
      // The wallet the case is about: the one named on it, else the booking's.
      ownerEmail: sql<string | null>`coalesce(${walletDecisions.detail} ->> 'ownerEmail', ${bookings.customerEmail}, ${customers.email})`,
    })
    .from(walletDecisions)
    .leftJoin(customers, eq(customers.id, walletDecisions.customerId))
    .leftJoin(bookings, eq(bookings.id, walletDecisions.bookingId))
    .where(tab === "resolved" ? isNotNull(walletDecisions.resolvedAt) : isNull(walletDecisions.resolvedAt))
    // Open: oldest first, the one waiting longest. Settled: newest first.
    .orderBy(tab === "resolved" ? desc(walletDecisions.resolvedAt) : asc(walletDecisions.createdAt))
    .limit(LIMIT);

  return (
    <WalletDecisionsView
      tab={tab}
      rows={rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      }))}
    />
  );
}
