// Run a db command against the REMOTE (Supabase) database instead of the local
// one.
//
//   node scripts/remote.mjs drizzle-kit migrate
//   node scripts/remote.mjs tsx lib/db/seed.ts
//
// Plain `npm run db:migrate` uses DATABASE_URL from .env.local, which points at
// localhost — easy to run by accident thinking it hit production. This wrapper
// swaps in SUPABASE_MIGRATE_URL and prints the target host first, so there is
// never a doubt about which database is being changed.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [, , command, ...args] = process.argv;
if (!command) {
  console.error("usage: node scripts/remote.mjs <command> [args...]");
  process.exit(1);
}

let env;
try {
  env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
} catch {
  console.error("Could not read .env.local");
  process.exit(1);
}

const url = env.SUPABASE_MIGRATE_URL;
if (!url) {
  console.error(
    "SUPABASE_MIGRATE_URL is not set in .env.local.\n" +
      "It should be the Supabase SESSION pooler (port 5432), e.g.\n" +
      "  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres",
  );
  process.exit(1);
}

// Show the destination without ever printing credentials.
const host = url.slice(url.lastIndexOf("@") + 1);
if (host.startsWith("db.")) {
  console.error(
    `Refusing to run: ${host} is the DIRECT connection, which is IPv6-only.\n` +
      "Use the session pooler host (…pooler.supabase.com:5432) instead.",
  );
  process.exit(1);
}
console.log(`→ target: ${host}\n`);

spawn("npx", [command, ...args], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
}).on("exit", (code) => process.exit(code ?? 0));
