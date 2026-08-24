ALTER TABLE "stations" ADD COLUMN "qr_token" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "stations" ADD CONSTRAINT "stations_qr_token_unique" UNIQUE("qr_token");