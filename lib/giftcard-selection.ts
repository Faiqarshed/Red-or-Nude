// Gift-card builder selection, carried from /gift-card to /gift-card/payment.
// Same pattern as the booking selection: sessionStorage holds it only until the
// purchase is confirmed, at which point the card itself becomes the record.

import type { Localized } from "@/lib/localized";

export type GiftSelection = {
  amountSar: number;
  designId: string | null;
  designName: Localized | null;
  designImg: string | null;
  recipientName: string;
  recipientEmail: string;
  senderName: string;
  /** Optional: where the buyer's receipt, with the code, is sent. */
  senderEmail?: string;
  message: string;
  /**
   * This purchase attempt, made on the payment page. A reload or a second tap
   * reuses it and so resumes the same checkout; a stranger buying an identical
   * card never has it. Editing the card in the builder saves a new selection
   * without one, which starts a new attempt.
   */
  attemptId?: string;
};

const KEY = "ron-giftcard";

export function saveGiftSelection(sel: GiftSelection) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(KEY, JSON.stringify(sel));
}

export function loadGiftSelection(): GiftSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as GiftSelection) : null;
  } catch {
    return null;
  }
}

export function clearGiftSelection() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(KEY);
}
