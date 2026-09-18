import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// The test harness. `npm test` runs it; `npm run test:mutations` checks that the
// suite actually fails when a fix it claims to cover is reverted.
//
// Still no CI: nothing runs on push, so these are only as good as the habit of
// running them. See docs/ for the per-feature manual guides that stand in for a
// browser layer.
export default defineConfig({
  resolve: {
    alias: {
      // The app's own alias, from tsconfig paths.
      "@": root,
      // See tests/empty.ts.
      "server-only": path.join(root, "tests/empty.ts"),
    },
    conditions: ["react-server", "node", "import", "default"],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Every suite here talks to one Postgres database and builds its fixtures by
    // emptying tables. Two files at once would delete each other's rows, so the
    // run is serial: one worker, one file at a time, no concurrency in a file.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ["verbose"],
  },
});
