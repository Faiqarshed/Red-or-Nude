// Migrate the local test database, never DATABASE_URL.
//
// drizzle-kit reads DATABASE_URL, so this sets it from TEST_DATABASE_URL and
// shells out. Same gate as scripts/_test-db.ts, which cannot be reused here
// because drizzle-kit runs in its own process.
import { spawnSync } from "node:child_process";
import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.TEST_DATABASE_URL;

/**
 * The same two questions scripts/_test-db.ts asks, asked the same way.
 *
 * This used to be one regular expression, and it was weaker than the gate it
 * was mirroring: `[^/]*(localhost|127\.0\.0\.1)` matches the substring
 * anywhere in the authority, so `notlocalhost.evil.example.com` passed — and
 * what runs behind this gate is `drizzle-kit migrate`, against whatever it was
 * handed. Parse the URL and compare the hostname exactly, as the other gate
 * does. Two gates guarding the same database must not disagree about what
 * counts as this machine.
 */
function refuse(why) {
  console.error(`Refusing to migrate: ${why}`);
  console.error("TEST_DATABASE_URL must be a local database whose name ends in _test");
  process.exit(1);
}

if (!url) refuse("TEST_DATABASE_URL is not set");

let parsed;
try {
  parsed = new URL(url);
} catch {
  refuse("TEST_DATABASE_URL is not a valid connection string");
}

if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
  refuse(`${parsed.protocol} is not a Postgres connection string`);
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
  refuse(`${parsed.hostname} is not this machine`);
}
if (!parsed.pathname.replace(/^\//, "").endsWith("_test")) {
  refuse(`database "${parsed.pathname.replace(/^\//, "")}" is not named *_test`);
}

const r = spawnSync("npx", ["drizzle-kit", "migrate"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(r.status ?? 1);
