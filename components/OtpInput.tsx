"use client";

// The six-digit box, wherever a code from an inbox is typed.
//
// Three screens ask for one — signing in, changing an email, and confirming a
// change to a booking — and each had its own copy of the same input with the
// same digit-stripping and the same `tracking-[0.4em]`. The rule that matters
// is the sanitising: digits only, capped at the code's length, so a pasted
// "123 456" or a stray letter cannot make a body the server rejects as
// malformed. One copy of that, not three.

import { OTP_LENGTH } from "@/lib/otp-length";

export default function OtpInput({
  value,
  onChange,
  onEnter,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  /** Submit on Enter, where the surrounding markup is not a <form>. */
  onEnter?: () => void;
  className?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH))}
      onKeyDown={onEnter && ((e) => e.key === "Enter" && onEnter())}
      dir="ltr"
      inputMode="numeric"
      autoComplete="one-time-code"
      // Deliberately no maxLength: it truncates the raw value before onChange
      // sees it, so pasting "123 456" would be cut to "123 45" and sanitise to
      // five digits. The slice above is the real cap, and it counts digits.
      placeholder="000000"
      className={`w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-center text-lg font-bold tracking-[0.4em] text-ink outline-none placeholder:text-ink/20 focus:border-red/40 ${className}`}
    />
  );
}
