-- One return per booking per service, mirroring pack_txns_booking_unique.
--
-- returnPackCredits decided this by reading the ledger for an existing `+1`,
-- which is a check before a write and races the same way a double spend would.
-- Two receptionists cancelling one appointment, or one button pressed twice,
-- both read nothing and both write — and a second `+1` is a credit the customer
-- was never sold. See the note on the index in lib/db/schema.ts.
--
-- Refuses to create where a double return has already happened, which is wanted:
-- those rows are exactly what it forbids, and somebody has to look at them.
create unique index "pack_txns_return_unique"
  on "pack_txns" ("booking_id", "service_id")
  where "booking_id" is not null and "delta" > 0;
