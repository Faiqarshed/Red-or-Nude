ALTER TABLE "bookings" ADD COLUMN "refill_of_booking_id" uuid;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD COLUMN "recipient_phone" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "refill_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_refill_of_booking_id_bookings_id_fk" FOREIGN KEY ("refill_of_booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_refill_of_unique" ON "bookings" USING btree ("refill_of_booking_id") WHERE "bookings"."status" not in ('cancelled', 'no_show');