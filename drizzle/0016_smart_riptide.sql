ALTER TABLE "addons" ADD COLUMN "at_checkout" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The upsell itself. Seeded here rather than in lib/db/seed.ts because that
-- skips the catalogue once branches exist, and this row is wanted on databases
-- that are already live. duration_min stays 0 — see the schema comment.
-- Guarded: a database that already has a checkout add-on keeps the one it has
-- rather than gaining a duplicate.
INSERT INTO "addons" ("name", "price_halalas", "duration_min", "at_checkout", "sort")
SELECT '{"ar":"قهوة وكوكيز","en":"Coffee & a cookie"}'::jsonb, 1000, 0, true, 100
WHERE NOT EXISTS (SELECT 1 FROM "addons" WHERE "at_checkout" = true);
