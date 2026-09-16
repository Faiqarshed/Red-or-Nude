"use client";

// "Pick your time again?" — asked before a change costs her the time she chose,
// and said when a time restored from checkout can't be kept. Shared by /booking
// and /booking/group so the two pages give the same reasons in the same words.

import Modal from "./Modal";
import { guestTotals, type GuestState } from "./GuestPicker";
import { pick } from "@/lib/localized";
import type { Content } from "@/lib/dictionary";
import type { HeldTimeProblem } from "@/lib/booking";
import type { PublicCatalog } from "@/lib/catalog";

type Strings = Content["booking"];

export type Redo = {
  title: string;
  body: string;
  /** Carry out the change. Absent when there is nothing to confirm, only to say. */
  apply?: () => void;
  /** Open the calendar for whoever has to pick again. */
  pickTime: () => void;
};

/**
 * Why changing `prev` to `next` loses her time, or null when it keeps.
 *
 * The time keeps only while the appointment is exactly the length it was picked
 * for — going 90 → 60 → 90 lands back on it. Longer may have no chair free for
 * the extra minutes; shorter was chosen from times offered for the wrong length.
 */
export function guestRedo(
  catalog: PublicCatalog,
  prev: GuestState,
  next: GuestState,
  checkedMin: number,
  heldTime: string,
  b: Strings,
  lang: "ar" | "en",
): { title: string; body: string } | null {
  const to = guestTotals(catalog, next).durationMin;
  if (to === checkedMin) return null;

  const added = next.addons.find((i) => !prev.addons.includes(i));
  const [kind, name] =
    next.service !== prev.service && next.service !== null
      ? (["service", catalog.services[next.service].name] as const)
      : added !== undefined
        ? (["addon", catalog.addons[added].name] as const)
        : next.addons.length < prev.addons.length
          ? (["addonRemoved", null] as const)
          : (["removal", catalog.removals.find((r) => r.id === next.removal)?.name] as const);

  return {
    title: b.redoTitle[kind],
    body: `${(to > checkedMin ? b.redoLonger : b.redoShorter)
      .replace("{name}", name ? pick(name, lang) : "")
      .replace("{to}", String(to))
      .replaceAll("{from}", String(checkedMin))
      .replace("{time}", heldTime)} ${b.redoNext}`,
  };
}

/** A different branch has different chairs and hours, so the time never carries. */
export function branchRedo(b: Strings, heldTime: string, branchName: string) {
  return {
    title: b.redoTitle.branch,
    body: `${b.redoBranch.replace("{time}", heldTime).replace("{name}", branchName)} ${b.redoNext}`,
  };
}

/** One line for a restored time that could not be kept. */
export function restoredLine(b: Strings, problem: HeldTimeProblem, heldTime: string) {
  const line = { passed: b.redoPassed, changed: b.redoChanged, taken: b.redoTaken }[problem];
  return line.replace("{time}", heldTime);
}

export default function RedoDialog({
  redo,
  b,
  onClose,
}: {
  redo: Redo;
  b: Strings;
  onClose: () => void;
}) {
  return (
    <Modal title={redo.title} onClose={onClose} className="max-w-[460px]">
      <p className="whitespace-pre-line text-start text-sm leading-6 text-ink/70">{redo.body}</p>
      {/* Side by side the two answers split a phone's width in half, and the
          longer one wraps to two lines while the other stays on one — a pair of
          mismatched boxes at the moment she is deciding. Stacked below `sm`
          each answer gets the full width and reads on one line, in the same
          order as the row. */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {redo.apply && (
          <button
            type="button"
            onClick={onClose}
            className="min-h-[48px] flex-1 rounded-[12px] bg-black/[0.05] py-3.5 text-sm font-bold text-ink transition-colors hover:bg-black/[0.08]"
          >
            {b.redoKeep}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            redo.apply?.();
            onClose();
            // Straight to the calendar: picking the time again is what is left.
            redo.pickTime();
          }}
          className="min-h-[48px] flex-1 rounded-[12px] bg-red-grad py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          {redo.apply ? b.redoContinue : b.redoPick}
        </button>
      </div>
    </Modal>
  );
}
