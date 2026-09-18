-- Staff discount codes stop being first names (client review, Sep 2026).
--
-- "SARA" is a guess away for anyone who knows who works here, and it is a 90%
-- code. Every staff-owned row gets the same shape lib/staff-codes.ts now
-- issues: STF and eight upper-case hex characters. Hex has no O or I to misread
-- against 0 and 1 when she reads it out at the desk.
--
-- Renaming is safe. Bookings point at a code by `promo_code_id`, not by its
-- text, so every booking that used one still points at the same row, and the
-- monthly renewal finds her row by `staff_id`. Campaign codes (no staff_id) are
-- untouched.
--
-- md5 of random() and the row's own id, so two rows cannot draw the same value
-- from one random() call; a real collision is four billion to one and would
-- fail this migration loudly on `promo_codes_code_unique` rather than merge
-- two people's codes.
UPDATE "promo_codes"
SET "code" = 'STF' || upper(substr(md5(random()::text || "id"::text), 1, 8)),
    "updated_at" = now()
WHERE "staff_id" IS NOT NULL;
