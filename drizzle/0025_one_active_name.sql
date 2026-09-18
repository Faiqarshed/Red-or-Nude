-- One active thing per name (client review, Sep 2026).
--
-- "Two services with the same name can not be active at the same time." Two
-- live rows reading "Gel Manicure" are indistinguishable everywhere the
-- customer meets them — the booking grid, the walk-in drawer, the ticket — and
-- the receptionist picking the wrong one puts the wrong price and the wrong
-- duration on a real appointment.
--
-- An index rather than a check in the action, for the usual reason: two
-- browser tabs both reading "no, that name is free" and both saving is exactly
-- the race a check-then-write cannot see. The action still catches the
-- violation and names it, so the screen says which rule was broken.
--
-- Partial on `active`, because retiring a service is how the salon renames a
-- thing: the old row stays, switched off, keeping its booking history, and the
-- new one takes the name. Only live rows compete.
--
-- Both languages, separately. A pair that differs in Arabic and matches in
-- English is still one name on an English ticket.
--
-- `addons` is not split by `at_checkout` here: two live treats both called
-- "Iced coffee & a treat" are the same problem as two live add-ons.
CREATE UNIQUE INDEX "services_active_name_en_unique"
  ON "services" (lower(btrim("name" ->> 'en'))) WHERE "active";
--> statement-breakpoint
CREATE UNIQUE INDEX "services_active_name_ar_unique"
  ON "services" (lower(btrim("name" ->> 'ar'))) WHERE "active";
--> statement-breakpoint
CREATE UNIQUE INDEX "addons_active_name_en_unique"
  ON "addons" (lower(btrim("name" ->> 'en'))) WHERE "active";
--> statement-breakpoint
CREATE UNIQUE INDEX "addons_active_name_ar_unique"
  ON "addons" (lower(btrim("name" ->> 'ar'))) WHERE "active";
--> statement-breakpoint
CREATE UNIQUE INDEX "removal_types_active_name_en_unique"
  ON "removal_types" (lower(btrim("name" ->> 'en'))) WHERE "active";
--> statement-breakpoint
CREATE UNIQUE INDEX "removal_types_active_name_ar_unique"
  ON "removal_types" (lower(btrim("name" ->> 'ar'))) WHERE "active";
