// Gift-card builder selection, carried from /gift-card to /gift-card/payment.
// Same pattern as the booking selection: sessionStorage holds it only until the
// purchase is confirmed, at which point the card itself becomes the record.

export type GiftSelection = {
  amountSar: number;
  designId: string | null;
  recipientName: string;
  recipientEmail: string;
  senderName: string;
  message: string;
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
