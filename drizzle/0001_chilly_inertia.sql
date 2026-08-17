CREATE TABLE "ticket_counters" (
	"branch_id" uuid NOT NULL,
	"day" date NOT NULL,
	"next" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ticket_counters_branch_id_day_pk" PRIMARY KEY("branch_id","day")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "ticket_no" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_group_idx" ON "bookings" USING btree ("group_id");