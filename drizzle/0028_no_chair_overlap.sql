-- No two live bookings may overlap on one chair (senior review, PR 21).
--
-- bookings_station_slot_unique only refuses the same start on the same chair.
-- 14:00-15:00 against 14:30-15:30 was stopped by reserveStations' lock and
-- overlap check alone: right while every write goes through it, and nothing
-- stopping one that does not. Now the database refuses it too.
--
-- Same statuses as the slot index: a cancelled or no-show booking frees its
-- chair. `[)` ranges, so back-to-back appointments do not overlap. A lapsed
-- hold still holds its range here; createBookings sweeps those before it
-- reserves, so a new booking into one never meets it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_station_no_overlap"
  EXCLUDE USING gist ("station_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&)
  WHERE ("status" NOT IN ('cancelled', 'no_show'));
