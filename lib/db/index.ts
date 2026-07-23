// Drizzle client.
//
// Initialised lazily: `next build` loads every route module, so throwing on a
// missing DATABASE_URL at import time would break builds on machines that have
// no database configured. The error surfaces on first query instead.
//
// The connection is cached on globalThis so Next's dev hot-reload doesn't open a
// new pool on every module reload.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __ronSql?: ReturnType<typeof postgres>;
  __ronDb?: Db;
};

function getDb(): Db {
  if (globalForDb.__ronDb) return globalForDb.__ronDb;

  // POSTGRES_URL is what the Vercel↔Supabase integration injects; accept it so a
  // deployment that relies on the integration doesn't fail with an empty
  // DATABASE_URL. Explicit DATABASE_URL always wins.
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "No database URL. Set DATABASE_URL to the Supabase transaction pooler " +
        "(port 6543). Locally: copy .env.example to .env.local. On Vercel: " +
        "Settings → Environment Variables, then redeploy — env changes only " +
        "apply to new deployments.",
    );
  }

  // Supabase's transaction pooler (port 6543 / pgbouncer) can't use prepared
  // statements.
  const pooled = url.includes("pgbouncer") || url.includes(":6543");

  const client =
    globalForDb.__ronSql ??
    postgres(url, {
      // One connection per serverless instance. The pooler is already doing the
      // pooling; opening ten sockets per lambda just races other instances to
      // Supabase's client limit. A long-lived server can afford more.
      max: pooled ? 1 : 10,
      prepare: !pooled,
      idle_timeout: 20,
      connect_timeout: 10,
    });

  const instance = drizzle(client, { schema });

  // Cache in every environment, production included. This used to be gated on
  // NODE_ENV !== "production", which meant the `db` Proxy below built a brand
  // new pool on every property access in production — two per sign-in, never
  // reused, never closed, until Supabase refused further connections. It
  // survived local testing because the failure only appears under sustained
  // traffic, not a handful of requests.
  globalForDb.__ronSql = client;
  globalForDb.__ronDb = instance;

  return instance;
}

/** Proxy so `db.select(...)` resolves the connection on first use, not on import. */
export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export { schema };
