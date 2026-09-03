import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: at("./") },
      // The check:* scripts pass --conditions=react-server, which is how they
      // get the empty build of `server-only` instead of the one whose whole
      // body is a throw. That condition is not usable here: it also makes a
      // bare `react` resolve to react.shared-subset, and on 18.3.1 that file
      // throws "not yet supported outside of experimental channels" the moment
      // any admin action's import graph reaches React. Next ships a patched
      // React for RSC; vitest has no such pipeline.
      //
      // So: stub the one package the condition was for, and let everything else
      // resolve normally.
      { find: /^server-only$/, replacement: at("./tests/stubs/server-only.ts") },
      // next-auth reaches for `next/server`, and next declares no exports map
      // for it — so Node's ESM resolver looks for an extensionless file and
      // gives up. Point at the real one.
      { find: /^next\/server$/, replacement: at("./node_modules/next/server.js") },
    ],
  },
  test: {
    // Runs before any test module is imported, so DATABASE_URL points at the
    // throwaway database before lib/db is ever touched. See tests/setup.ts.
    setupFiles: ["./tests/setup.ts"],
    // One local Postgres shared by every file. Fixtures are scoped to rows they
    // created, but sequential files keep failure output readable and stop a
    // rollback in one file racing a read in another.
    // ponytail: sequential, switch to per-file schemas if the suite gets slow.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // next-auth is a node_modules package, so it would be externalised and let
    // Node resolve `next/server` on its own — which fails, and which the alias
    // above cannot reach. Inlining puts its imports back under Vite.
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
  },
});
