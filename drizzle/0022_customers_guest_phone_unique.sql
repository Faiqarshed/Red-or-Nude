-- A phone is a contact detail, not proof of identity: nobody verifies they own
-- one. Unique only across guest rows, so checkout still recognises a returning
-- guest, while an account (email_verified_at set) is never matched on a number.
-- See the note on the index in lib/db/schema.ts.
ALTER TABLE "customers" DROP CONSTRAINT "customers_phone_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "customers_guest_phone_unique" ON "customers" USING btree ("phone") WHERE "customers"."email_verified_at" is null;
