// Drizzle client.
//
// Initialised lazily: `next build` loads every route module, so throwing on a
// missing DATABASE_URL at import time would break builds on machines that have
// no database configured. The error surfaces on first query instead.
//
// The connection is cached on globalThis in every environment. Dev needs it so
// hot-reload doesn't open a pool per module reload; production used to go
// without, which was an oversight rather than a decision.
//
// `db` below is a Proxy that calls getDb() on *every* property access, so with a
// dev-only cache each `db.select(...)` in production allocated a fresh
// postgres() client — several per query, once drizzle reads back through the
// same proxy.
//
// Measured honestly: this is not where the page time was going. postgres() is
// lazy, so the discarded clients never opened a socket, and `next start` against
// this database served the same page in 0.36s either way. What the cache buys is
// one pool with a bounded connection count instead of unbounded object churn
// under load — worth having, but it is not a latency fix. The latency is the
// distance between the function region and this database; see docs/DEPLOYMENT.md.

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

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and point it at your Postgres instance.",
    );
  }

  // Transaction poolers hand a different backend to each statement, so named
  // prepared statements can't be relied on. Each provider advertises itself
  // differently: Supabase by port 6543, Neon by a `-pooler` hostname.
  const pooled =
    url.includes("pgbouncer") || url.includes(":6543") || url.includes("-pooler.");

  const client =
    globalForDb.__ronSql ?? postgres(url, { max: 10, prepare: !pooled });

  const instance = drizzle(client, { schema });

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

/** The handle passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { schema };
