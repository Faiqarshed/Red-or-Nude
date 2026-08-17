// Deployment health check: is the app wired to its database and storage?
//
// Deliberately reports presence and reachability only — never a connection
// string, key, or hostname. On a fresh deploy this is the fastest way to tell a
// missing env var from an unreachable database, without reading server logs.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    // Injected by the Vercel↔Supabase integration; accepted as a fallback.
    POSTGRES_URL: Boolean(process.env.POSTGRES_URL),
    AUTH_SECRET: Boolean(process.env.AUTH_SECRET),
    AUTH_URL: Boolean(process.env.AUTH_URL),
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };

  // Which pooler port the app is using, if any. Port 6543 (transaction mode) is
  // the correct one for serverless; the direct db.<ref>.supabase.co host is
  // IPv6-only and unreachable from most hosting providers.
  let dbHostShape: string | null = null;
  try {
    const url = new URL(process.env.DATABASE_URL || process.env.POSTGRES_URL || "");
    dbHostShape = url.hostname.includes("pooler")
      ? `pooler:${url.port || "5432"}`
      : url.hostname.startsWith("db.")
        ? "direct (IPv6-only — wrong for serverless)"
        : "other";
  } catch {
    dbHostShape = null;
  }

  let database: { ok: boolean; error?: string; staffCount?: number } = { ok: false };
  try {
    const [row] = await db.execute<{ n: number }>(
      sql`select (select count(*)::int from staff) as n`,
    );
    database = { ok: true, staffCount: Number(row?.n ?? 0) };
  } catch (err) {
    // Error name/code only — enough to identify the failure mode, nothing that
    // discloses credentials or infrastructure detail.
    const e = err as { name?: string; code?: string; message?: string };
    database = {
      ok: false,
      error: e.code ?? e.name ?? (e.message ? e.message.slice(0, 80) : "unknown"),
    };
  }

  const healthy = database.ok && (env.DATABASE_URL || env.POSTGRES_URL) && env.AUTH_SECRET;

  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", env, dbHostShape, database },
    { status: healthy ? 200 : 503 },
  );
}
