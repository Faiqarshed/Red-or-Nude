-- Trimmed by hand: drizzle-kit also re-emitted 0024's treat_booking_id and
-- 0025's active-name indexes, because those were hand-written and never made it
-- into the snapshot. They already exist; the snapshot beside this file now
-- carries them, so the next generate starts clean.
CREATE TABLE "streampay_ids" (
	"key" text PRIMARY KEY NOT NULL,
	"streampay_id" text NOT NULL,
	"price_id" text,
	"signature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "promo_discount_halalas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "points_discount_halalas" integer DEFAULT 0 NOT NULL;
