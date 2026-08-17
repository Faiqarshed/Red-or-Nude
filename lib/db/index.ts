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

  if (process.env.NODE_ENV !== "production") {
    globalForDb.__ronSql = client;
    globalForDb.__ronDb = instance;
  }

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
