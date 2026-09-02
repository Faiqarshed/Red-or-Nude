import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
    // Same as the `--conditions=react-server` the check:* scripts pass. Without
    // it `server-only` resolves to the variant that throws on import, and every
    // module under lib/account, lib/payments and app/api dies before its first
    // assertion.
    conditions: ["react-server"],
  },
  test: {
    // Runs before any test module is imported, so DATABASE_URL points at the
    // throwaway database before lib/db is ever touched. See tests/setup.ts.
    setupFiles: ["./tests/setup.ts"],
    // One local Postgres shared by every file. Fixtures are branch-scoped so
    // they don't collide, but sequential files keep the failure output readable
    // and stop a rollback in one file racing a read in another.
    // ponytail: sequential, switch to per-file schemas if the suite gets slow.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
