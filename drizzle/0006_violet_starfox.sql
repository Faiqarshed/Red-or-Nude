ALTER TABLE "bookings" ADD COLUMN "no_show_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "no_show_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "no_show_note" text;--> statement-breakpoint
CREATE INDEX "bookings_unresolved_no_show_idx" ON "bookings" USING btree ("branch_id","no_show_at") WHERE "bookings"."no_show_resolved_at" is null;