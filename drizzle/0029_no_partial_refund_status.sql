-- No partial refunds: a refund is always the whole bill (lib/payments/refund.ts),
-- so a payment is never `partially_refunded`. The value goes from the type.
--
-- Postgres cannot drop an enum value, so the type is made again without it. A
-- row still holding the value (none should) fails the cast and stops the
-- migration, rather than being guessed at. payments_booking_live_unique names
-- the status in its WHERE, so it is dropped and made again around the change.
DROP INDEX "payments_booking_live_unique";--> statement-breakpoint
ALTER TYPE "public"."payment_status" RENAME TO "payment_status_old";--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'refunded');--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DATA TYPE "public"."payment_status" USING "status"::text::"public"."payment_status";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."payment_status_old";--> statement-breakpoint
CREATE UNIQUE INDEX "payments_booking_live_unique" ON "payments" USING btree ("booking_id") WHERE "payments"."booking_id" is not null and "payments"."status" in ('pending', 'paid');
