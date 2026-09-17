CREATE TABLE "customer_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"pack_id" uuid,
	"name" jsonb NOT NULL,
	"price_halalas" integer NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_services" (
	"pack_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pack_services_pack_id_service_id_pk" PRIMARY KEY("pack_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "pack_txns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_pack_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"booking_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"price_halalas" integer NOT NULL,
	"valid_days" integer DEFAULT 90 NOT NULL,
	"image" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_packs" ADD CONSTRAINT "customer_packs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packs" ADD CONSTRAINT "customer_packs_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_services" ADD CONSTRAINT "pack_services_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_services" ADD CONSTRAINT "pack_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_txns" ADD CONSTRAINT "pack_txns_customer_pack_id_customer_packs_id_fk" FOREIGN KEY ("customer_pack_id") REFERENCES "public"."customer_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_txns" ADD CONSTRAINT "pack_txns_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_txns" ADD CONSTRAINT "pack_txns_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_packs_customer_idx" ON "customer_packs" USING btree ("customer_id","expires_at");--> statement-breakpoint
CREATE INDEX "pack_txns_pack_idx" ON "pack_txns" USING btree ("customer_pack_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_txns_booking_unique" ON "pack_txns" USING btree ("booking_id","service_id") WHERE "pack_txns"."booking_id" is not null and "pack_txns"."delta" < 0;