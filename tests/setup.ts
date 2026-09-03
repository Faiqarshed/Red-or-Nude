// The same gate every script under scripts/ goes through, wired into vitest so
// no test file has to remember it.
//
// scripts/_test-db.ts refuses to start unless TEST_DATABASE_URL is set, is on
// this machine, and names a database ending in _test — then rewrites
// DATABASE_URL to it. Read the comment at the top of that file for why: a check
// script pointed at the real database deleted eighty bookings on 2026-09-01.
//
// This is a setupFile rather than a globalSetup on purpose. globalSetup runs in
// the main process and its env changes do not reliably reach the workers;
// setupFiles run inside each worker before any test module is imported, which
// is the only ordering that guarantees lib/db sees the right URL.
import "../scripts/_test-db";
