-- Two treats at checkout instead of one: a hot coffee and an iced one, each
-- with its own picture.
--
-- No schema change. Migration 0016 seeded a single "Coffee & a cookie" upsell;
-- the salon wants the customer to choose hot or cold, and to swap the sweet
-- thing that comes with it every month. Both of those are ordinary catalogue
-- edits in Admin → Catalog → Upsells — the checkout already renders every
-- active `at_checkout` row as its own card, so a second row is a second card
-- with no code behind it. This migration only makes sure the pair exists on
-- databases that are already live, the way 0016 did for the first one.
--
-- The existing row is renamed rather than replaced, so its id survives and
-- every booking already linked to it keeps its link. Nothing is lost by the
-- rename either way: `booking_addons` snapshots the name and the price at the
-- time of sale, so an old ticket still reads as what was actually bought.
--
-- `image` is left null on both. Pictures are uploaded through the media picker
-- and cannot be seeded from here — see docs/SCOPE-ENHANCEMENT.md for the
-- four-click version of this the salon does themselves each month.
--
-- duration_min stays 0 on both: these are picked after the chair has been
-- quoted, so a duration would move ends_at under a booking already being held.

-- The hot one: whichever single upsell 0016 left behind, renamed. Guarded so a
-- database where somebody has already made the pair by hand is left alone.
UPDATE "addons"
SET "name" = '{"ar":"قهوة ساخنة مع تحلية","en":"Hot coffee & a treat"}'::jsonb
WHERE "id" = (
  SELECT "id" FROM "addons" WHERE "at_checkout" = true ORDER BY "sort", "id" LIMIT 1
)
AND (SELECT count(*) FROM "addons" WHERE "at_checkout" = true) = 1;
--> statement-breakpoint

-- The cold one. Same price and the next sort position, so it sits beside its
-- sibling rather than at the end of a list it is not part of.
INSERT INTO "addons" ("name", "price_halalas", "duration_min", "at_checkout", "sort")
SELECT
  '{"ar":"قهوة باردة مع تحلية","en":"Iced coffee & a treat"}'::jsonb,
  COALESCE((SELECT "price_halalas" FROM "addons" WHERE "at_checkout" = true ORDER BY "sort", "id" LIMIT 1), 1000),
  0,
  true,
  COALESCE((SELECT max("sort") FROM "addons" WHERE "at_checkout" = true), 100) + 1
WHERE (SELECT count(*) FROM "addons" WHERE "at_checkout" = true) = 1;
