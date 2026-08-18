"use client";

import {
  NATIONAL_LENGTH,
  SAUDI_DIALLING_CODE,
  formatNational,
  toNationalDigits,
  validateSaudiMobile,
} from "@/lib/phone";
import { useI18n } from "@/lib/i18n";

// Mobile number input with the +966 country code fixed in the field.
//
// The code is a static span, not part of the value, so it can't be deleted,
// duplicated ("+966 +966 5…") or replaced with another country's. The caller
// holds only the 9 national digits; lib/phone.ts turns those into the stored
// `05XXXXXXXX` at submit time.
//
// Always LTR regardless of page direction: a phone number is a Latin-digit
// sequence and reverses into a different number under RTL.

export default function PhoneField({
  label,
  value,
  onChange,
  required,
  showError,
  onBlur,
}: {
  label: string;
  /** The 9 national digits, without country code or trunk zero. */
  value: string;
  onChange: (nationalDigits: string) => void;
  required?: boolean;
  /** Errors stay hidden until the field is touched or the form is submitted. */
  showError?: boolean;
  onBlur?: () => void;
}) {
  const { c } = useI18n();
  const p = c.payment;

  const code = validateSaudiMobile(value);
  // An empty optional field isn't an error; an empty required one is.
  const error = showError && code && (required || code !== "required") ? code : null;

  const message =
    error === "required"
      ? p.phoneRequired
      : error === "prefix"
        ? p.phonePrefix
        : error === "length"
          ? p.phoneLength
          : null;

  return (
    <label className="block text-start">
      <span className="mb-1.5 block text-[12px] text-ink/55">
        {label}
        {required ? " *" : ""}
      </span>
      <div
        dir="ltr"
        className={`flex items-stretch overflow-hidden rounded-[12px] border bg-white ${
          message ? "border-red/60" : "border-black/[0.08] focus-within:border-red/40"
        }`}
      >
        <span className="flex select-none items-center gap-1.5 border-e border-black/[0.06] bg-black/[0.02] px-3 text-sm text-ink/60">
          <span aria-hidden>🇸🇦</span>
          {SAUDI_DIALLING_CODE}
        </span>
        <input
          value={formatNational(value)}
          onChange={(e) => onChange(toNationalDigits(e.target.value))}
          onBlur={onBlur}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          // 9 digits plus the two grouping spaces.
          maxLength={NATIONAL_LENGTH + 2}
          placeholder="5X XXX XXXX"
          aria-invalid={message ? true : undefined}
          className="w-full bg-transparent px-4 py-3 text-left text-sm text-ink outline-none placeholder:text-ink/30"
        />
      </div>
      {message && <span className="mt-1.5 block text-[11px] text-red">{message}</span>}
    </label>
  );
}
