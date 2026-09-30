CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_id" uuid,
	"provider_ref" text,
	"kind" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE INDEX "payment_events_ref_idx" ON "payment_events" USING btree ("provider_ref","at");--> statement-breakpoint
-- Every insert and change on `payments`, logged by the database itself, so no
-- code path can skip it (lib/db/schema.ts, paymentEvents). An insert records the
-- row; a change records each column that changed, from and to, and within `raw`
-- each key added or changed. A re-check stamp (`checkedAt`) alone is not a
-- change: the settle job writes one every run while a checkout waits.
CREATE FUNCTION "log_payment_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changes jsonb;
  raw_changes jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "payment_events" ("payment_id", "provider_ref", "kind", "detail")
    VALUES (NEW.id, NEW.provider_ref, 'created', to_jsonb(NEW) - 'created_at' - 'updated_at');
    RETURN NEW;
  END IF;

  SELECT jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
    INTO changes
    FROM jsonb_each(to_jsonb(NEW) - 'updated_at' - 'raw') n
    JOIN jsonb_each(to_jsonb(OLD) - 'updated_at' - 'raw') o USING (key)
   WHERE n.value IS DISTINCT FROM o.value;

  SELECT jsonb_object_agg(n.key, n.value)
    INTO raw_changes
    FROM jsonb_each(coalesce(NEW.raw, '{}'::jsonb)) n
   WHERE n.key <> 'checkedAt'
     AND (coalesce(OLD.raw, '{}'::jsonb) -> n.key) IS DISTINCT FROM n.value;

  IF raw_changes IS NOT NULL THEN
    changes := coalesce(changes, '{}'::jsonb) || jsonb_build_object('raw', raw_changes);
  END IF;
  IF changes IS NOT NULL THEN
    INSERT INTO "payment_events" ("payment_id", "provider_ref", "kind", "detail")
    VALUES (NEW.id, NEW.provider_ref, CASE WHEN changes ? 'status' THEN 'status' ELSE 'changed' END, changes);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "payments_log" AFTER INSERT OR UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "log_payment_change"();
