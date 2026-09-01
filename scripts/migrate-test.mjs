// Migrate the local test database, never DATABASE_URL.
//
// drizzle-kit reads DATABASE_URL, so this sets it from TEST_DATABASE_URL and
// shells out. Same gate as scripts/_test-db.ts, which cannot be reused here
// because drizzle-kit runs in its own process.
import { spawnSync } from "node:child_process";
import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(url) || !url.endsWith("_test")) {
  console.error("TEST_DATABASE_URL must be a local database whose name ends in _test");
  process.exit(1);
}

const r = spawnSync("npx", ["drizzle-kit", "migrate"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(r.status ?? 1);
