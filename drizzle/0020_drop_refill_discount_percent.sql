-- The refill is a flat price now, not a percentage off the service (8 Sep scope
-- note; docs/SCOPE-ENHANCEMENT.md §2). `refill_price_halalas` replaced the key
-- rather than joining it, so there is exactly one way to price a refill — but a
-- database seeded before the rename still carries the old row, and a settings
-- row nothing reads is a number the next person will try to change.
delete from settings where key = 'refill_discount_percent';
