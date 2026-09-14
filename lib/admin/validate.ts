// Checks for the admin forms, run before anything is sent.
//
// The server actions still validate — they are the authority — but all they can
// say back is "invalid", which told the salon nothing about which box was
// wrong. These mirror the limits in each action's zod schema and name the
// field in the message, in the panel's own language.
//
// Usage: build `errors` from `rules(t.validation)` on every render once a save
// has been tried, so a message disappears the moment the field is fixed.

import { z } from "zod";
import type { AdminStrings } from "./strings";

export type Errors = Record<string, string>;

const email = z.string().email();

export function rules(v: AdminStrings["validation"]) {
  return {
    text(label: string, value: string, o: { required?: boolean; min?: number; max?: number } = {}) {
      const s = value.trim();
      if (!s) return o.required === false ? undefined : v.required(label);
      if (o.min && s.length < o.min) return v.tooShort(label, o.min);
      if (o.max && s.length > o.max) return v.tooLong(label, o.max);
    },

    number(
      label: string,
      raw: string | number | null | undefined,
      o: { required?: boolean; min?: number; max?: number; int?: boolean; positive?: boolean } = {},
    ) {
      const s = String(raw ?? "").trim();
      if (!s) return o.required === false ? undefined : v.required(label);
      const n = Number(s);
      if (!Number.isFinite(n)) return v.number(label);
      if (o.int && !Number.isInteger(n)) return v.whole(label);
      if (o.positive && n <= 0) return v.positive(label);
      if (o.min !== undefined && n < o.min) return v.min(label, o.min);
      if (o.max !== undefined && n > o.max) return v.max(label, o.max);
    },

    /** Same check the server's `z.string().email()` runs, so the two agree. */
    email(label: string, value: string, o: { required?: boolean; max?: number } = {}) {
      const s = value.trim();
      if (!s) return o.required ? v.required(label) : undefined;
      if (!email.safeParse(s).success) return v.email(label);
      if (o.max && s.length > o.max) return v.tooLong(label, o.max);
    },
  };
}

/** Keep only the fields that failed. */
export function collect(checks: Record<string, string | undefined | null | false>): Errors {
  return Object.fromEntries(Object.entries(checks).filter(([, m]) => m)) as Errors;
}

export const hasErrors = (e: Errors) => Object.keys(e).length > 0;

/**
 * After a refused save, put the cursor in the first box that needs fixing.
 * Focusing scrolls it into view, which matters in a long drawer where the
 * mistake is above the fold and the Save button is below it.
 */
export function focusFirstInvalid() {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
  );
}
