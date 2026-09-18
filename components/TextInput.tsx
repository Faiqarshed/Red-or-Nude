"use client";

import { useState } from "react";
import { typedInput, type TextOpts } from "@/lib/admin/validate";
import { useI18n } from "@/lib/i18n";
import { validationMessages } from "@/lib/validation-messages";

// A text box for the public site, filtered as it is typed like the admin
// panel's TextField: a dropped character or a cut-off paste says why, instead
// of looking like a broken keyboard. The field's own error waits until she
// leaves the box or presses the button (`showError`), like PhoneField.

export default function TextInput({
  label,
  value,
  onChange,
  opts,
  max,
  error,
  showError,
  autoComplete,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  opts: TextOpts;
  max: number;
  error?: string;
  showError?: boolean;
  autoComplete?: string;
  placeholder?: string;
  /** Shown under the box while there is no error to show instead. */
  hint?: string;
}) {
  const { lang } = useI18n();
  const [note, setNote] = useState<string | null>(null);
  const [blurred, setBlurred] = useState(false);
  const message = note ?? (showError || blurred ? error : undefined);

  return (
    <label className="block text-start">
      <span className="mb-1.5 block text-[12px] text-ink/55">{label}</span>
      <input
        value={value}
        onChange={(e) => {
          const typed = typedInput(validationMessages[lang], e.target.value, opts, max);
          setNote(typed.note);
          onChange(typed.value);
        }}
        onBlur={() => {
          setNote(null);
          setBlurred(true);
        }}
        type={opts.email ? "email" : "text"}
        inputMode={opts.email ? "email" : undefined}
        dir={opts.email ? "ltr" : "auto"}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={message ? true : undefined}
        className={`w-full rounded-[12px] border bg-white px-4 py-3 text-sm text-ink outline-none placeholder:text-ink/30 ${
          opts.email ? "text-left" : ""
        } ${message ? "border-red/60" : "border-black/[0.08] focus:border-red/40"}`}
      />
      {message ? (
        <span className="mt-1.5 block text-[11px] text-red">{message}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[11px] text-ink/40">{hint}</span>
      ) : null}
    </label>
  );
}
