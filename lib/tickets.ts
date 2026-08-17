// Airline-style queue numbers — "K45". Restart at A1 every day, per branch.
//
// Distinct from `bookings.code` (RON-4F2K), which is a permanent unique reference
// for looking a booking up. This is the short number the salon calls out, and it
// only means anything on the day.
//
// Deliberately excludes nothing from the alphabet: unlike `code`, a ticket is
// read off a screen in the room rather than dictated over the phone, and skipping
// letters would make the sequence confusing to follow.

/** 1 → "A1", 99 → "A99", 100 → "B1". */
export function formatTicketNo(n: number): string {
  const i = n - 1;
  const letter = String.fromCharCode(65 + (Math.floor(i / 99) % 26));
  return `${letter}${(i % 99) + 1}`;
  // ponytail: wraps back to A1 after 2574 in one day at one branch. Add a second
  // letter if a branch ever gets near that.
}
