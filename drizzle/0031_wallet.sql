CREATE TYPE "public"."wallet_reason" AS ENUM('cancel-customer', 'cancel-salon', 'gift-card', 'chair-credit', 'spend', 'release', 'reversal', 'correction');--> statement-breakpoint
CREATE TABLE "wallet_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"customer_id" uuid,
	"booking_id" uuid,
	"payment_id" uuid,
	"amount_halalas" integer NOT NULL,
	"detail" jsonb,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_txns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"owner_email" text NOT NULL,
	"delta_halalas" integer NOT NULL,
	"reason" "wallet_reason" NOT NULL,
	"booking_id" uuid,
	"payment_id" uuid,
	"gift_card_id" uuid,
	"reverses_id" uuid,
	"note" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_txns_delta_nonzero" CHECK ("wallet_txns"."delta_halalas" <> 0),
	CONSTRAINT "wallet_txns_owner_email_lower" CHECK ("wallet_txns"."owner_email" = lower("wallet_txns"."owner_email")),
	CONSTRAINT "wallet_txns_note_required" CHECK ("wallet_txns"."reason" not in ('correction', 'cancel-salon') or coalesce(trim("wallet_txns"."note"), '') <> '')
);
--> statement-breakpoint
DROP INDEX "customers_guest_phone_unique";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "customer_email" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "wallet_discount_halalas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_decisions" ADD CONSTRAINT "wallet_decisions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_decisions" ADD CONSTRAINT "wallet_decisions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_decisions" ADD CONSTRAINT "wallet_decisions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_decisions" ADD CONSTRAINT "wallet_decisions_resolved_by_staff_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_reverses_id_wallet_txns_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."wallet_txns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_txns" ADD CONSTRAINT "wallet_txns_actor_id_staff_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_txns_owner_idx" ON "wallet_txns" USING btree ("customer_id","owner_email");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_txns_cancel_unique" ON "wallet_txns" USING btree ("booking_id") WHERE "wallet_txns"."reason" in ('cancel-customer', 'cancel-salon');--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_txns_spend_booking_unique" ON "wallet_txns" USING btree ("booking_id") WHERE "wallet_txns"."reason" = 'spend' and "wallet_txns"."reverses_id" is null and "wallet_txns"."booking_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_txns_spend_payment_unique" ON "wallet_txns" USING btree ("payment_id") WHERE "wallet_txns"."reason" = 'spend' and "wallet_txns"."reverses_id" is null and "wallet_txns"."payment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_txns_reverses_unique" ON "wallet_txns" USING btree ("reverses_id") WHERE "wallet_txns"."reason" in ('release', 'spend');--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_txns_gift_card_unique" ON "wallet_txns" USING btree ("gift_card_id") WHERE "wallet_txns"."reason" = 'gift-card';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_txns_chair_unique" ON "wallet_txns" USING btree ("payment_id") WHERE "wallet_txns"."reason" = 'chair-credit';--> statement-breakpoint
-- A guest is her email now (docs/WALLET-PLAN.md, gap 3). Guest rows that already
-- share an address are folded into the newest of them first, the way
-- createAccount folds them (lib/account/create.ts): bookings, points and
-- memberships move, a block carries over, notes are kept together. An empty
-- address is no address. No wallet rows exist yet, so no money moves.
UPDATE "customers" SET "email" = NULL
 WHERE "email_verified_at" IS NULL AND trim("email") = '';--> statement-breakpoint
CREATE TEMP TABLE "guest_merge" AS
SELECT c."id" AS "from_id", k."id" AS "to_id"
  FROM "customers" c
  JOIN LATERAL (
    SELECT k."id" FROM "customers" k
     WHERE k."email_verified_at" IS NULL AND lower(k."email") = lower(c."email")
     ORDER BY k."updated_at" DESC, k."id" DESC
     LIMIT 1
  ) k ON true
 WHERE c."email_verified_at" IS NULL AND c."email" IS NOT NULL AND c."id" <> k."id";--> statement-breakpoint
UPDATE "bookings" b SET "customer_id" = m."to_id" FROM "guest_merge" m WHERE b."customer_id" = m."from_id";--> statement-breakpoint
UPDATE "loyalty_txns" t SET "customer_id" = m."to_id" FROM "guest_merge" m WHERE t."customer_id" = m."from_id";--> statement-breakpoint
UPDATE "customer_packs" p SET "customer_id" = m."to_id" FROM "guest_merge" m WHERE p."customer_id" = m."from_id";--> statement-breakpoint
UPDATE "customers" k SET
  "blocked" = k."blocked" OR agg."blocked",
  "notes" = NULLIF(concat_ws(E'\n\n', NULLIF(trim(k."notes"), ''), agg."notes"), '')
  FROM (
    SELECT m."to_id", bool_or(c."blocked") AS "blocked",
           string_agg(NULLIF(trim(c."notes"), ''), E'\n\n') AS "notes"
      FROM "guest_merge" m JOIN "customers" c ON c."id" = m."from_id"
     GROUP BY m."to_id"
  ) agg
 WHERE k."id" = agg."to_id";--> statement-breakpoint
DELETE FROM "customers" c USING "guest_merge" m WHERE c."id" = m."from_id";--> statement-breakpoint
DROP TABLE "guest_merge";--> statement-breakpoint
CREATE UNIQUE INDEX "customers_guest_email_unique" ON "customers" USING btree (lower("email")) WHERE "customers"."email_verified_at" is null and "customers"."email" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_guest_phone_unique" ON "customers" USING btree ("phone") WHERE "customers"."email_verified_at" is null and "customers"."email" is null;