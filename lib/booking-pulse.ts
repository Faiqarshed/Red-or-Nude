/**
 * What colour a booking is on the screens that watch the floor rather than work
 * it: moving means somebody still has work to do, still means it is over.
 *
 * "Over" is `finished_at`, not `completed` — the technician says when she is
 * done, the receptionist says when the ticket is closed, and there can be
 * twenty minutes of queuing between them. Keying this off `completed` leaves a
 * finished chair pulsing green across the salon while the desk does paperwork.
 *
 * In lib/ because two renderers draw the same booking (the list and the day
 * grid) and a colour rule that exists twice will disagree with itself.
 */

import type { bookingStatus } from "@/lib/db/schema";

type PulseStatus = (typeof bookingStatus)["enumValues"][number];

/** Everything the colour depends on, so any row shape fits. */
export type PulseInput = {
  status: PulseStatus;
  /** When the technician said she was done. Null while she still is. */
  finishedAt?: string | null;
};

/**
 * Tailwind classes for one booking's colour, or `""` for the states with no
 * light of their own — callers keep their existing styling on `""` rather than
 * this knowing about dashed amber borders it has no opinion on.
 */
export function statusPulse(b: PulseInput): string {
  // Here and handed over, nobody on her yet — the salon's waiting time.
  if (b.status === "checked_in") {
    return "animate-row-checkin motion-reduce:animate-none motion-reduce:bg-[#f6e2ae] motion-reduce:border-[#b7791f]";
  }

  if (b.status === "in_progress" && !b.finishedAt) {
    return "animate-running-pulse motion-reduce:animate-none motion-reduce:bg-[#c7e6d4] motion-reduce:border-[#1f7a4d]";
  }

  // Reaching `completed` after `finished_at` changes nothing on screen: the
  // colour tracks the service, not the paperwork.
  if (b.finishedAt || b.status === "completed") {
    return "border-[#1f7a4d]/40 bg-[#1f7a4d]/10";
  }

  return "";
}
