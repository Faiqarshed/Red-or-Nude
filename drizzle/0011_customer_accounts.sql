-- Customer accounts and the loyalty wallet (brief §2.8).
--
-- Written by hand rather than generated: drizzle-kit sees the otps change as a
-- DROP plus a CREATE unless told interactively that it is a rename, and a drop
-- would throw away every sign-in code in flight. A RENAME keeps them.
-- The matching snapshot in meta/ was generated from the schema, so the next
-- `db:generate` still diffs against reality.

-- 1. Widen the OTP key from a booking id to a free-text subject, so account
--    sign-in reuses the same hashed / single-use / 5-attempt rules instead of a
--    second copy of security-critical code. See lib/otp.ts.
ALTER TABLE "booking_otps" RENAME TO "otps";--> statement-breakpoint
ALTER TABLE "otps" ADD COLUMN "subject" text;--> statement-breakpoint
UPDATE "otps" SET "subject" = 'booking:' || "booking_id";--> statement-breakpoint
ALTER TABLE "otps" ALTER COLUMN "subject" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "booking_otps_booking_idx";--> statement-breakpoint
-- Drops the foreign key with it. Its cascade-on-delete is not missed: bookings
-- are cancelled, never deleted, and a code dies ten minutes after it is issued.
ALTER TABLE "otps" DROP COLUMN "booking_id";--> statement-breakpoint
CREATE INDEX "otps_subject_idx" ON "otps" ("subject","created_at");--> statement-breakpoint

-- 2. An account is a customer row with a verified address. No accounts table.
ALTER TABLE "customers" ADD COLUMN "birthday" date;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
-- Partial, and that is load-bearing. Checkout upserts on phone and writes
-- whatever email was typed, so the same address legitimately lands on two rows
-- when someone books from two numbers; a blanket unique index would turn that
-- into a failed booking. Only verified addresses — real accounts — must be
-- unique, which is all sign-in needs to resolve exactly one row.
CREATE UNIQUE INDEX "customers_account_email_unique"
  ON "customers" (lower("email")) WHERE "email_verified_at" IS NOT NULL;--> statement-breakpoint

-- 3. The wallet: a ledger with no running-balance column, so the balance cannot
--    drift from its own history. See lib/loyalty.ts for why that also means
--    points return on their own when a booking dies.
CREATE TABLE IF NOT EXISTS "loyalty_txns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"booking_id" uuid,
	"delta_points" integer NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "loyalty_txns" ADD CONSTRAINT "loyalty_txns_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_txns" ADD CONSTRAINT "loyalty_txns_booking_id_bookings_id_fk"
  FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_txns_customer_idx" ON "loyalty_txns" ("customer_id","created_at");
