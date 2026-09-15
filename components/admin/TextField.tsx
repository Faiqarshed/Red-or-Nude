"use client";

import { useState } from "react";
import { Field, Input, invalidRing } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import { blockedChar, blockedMessage, numeric, typedText, type TextOpts } from "@/lib/admin/validate";

/**
 * Arabic and English boxes side by side, so a missing translation is visible
 * rather than buried behind a language switch. Each tuple is [ar, en].
 */
export function TextPair({
  labels,
  errors,
  values,
  onChange,
  max,
  long,
  className = "grid gap-3 sm:grid-cols-2",
}: {
  labels: [string, string];
  errors: [string | undefined, string | undefined];
  values: [string, string];
  onChange: [(v: string) => void, (v: string) => void];
  max: number;
  long?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      {(["ar", "en"] as const).map((script, i) => (
        <TextField
          key={script}
          label={labels[i]}
          script={script}
          long={long}
          max={max}
          error={errors[i]}
          value={values[i]}
          onChange={onChange[i]}
        />
      ))}
    </div>
  );
}

/** A number box filtered by `numeric` as it is typed. */
export function NumberField({
  label,
  hint,
  error,
  value,
  onChange,
  placeholder,
  ...digits
}: Parameters<typeof numeric>[1] & {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      <Input
        inputMode={digits.decimals ? "decimal" : "numeric"}
        dir="ltr"
        className="text-left tabular-nums"
        aria-invalid={!!error}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(numeric(e.target.value, digits))}
      />
    </Field>
  );
}

/**
 * A text box that filters as it is typed, and says so. A dropped character or a
 * cut-off paste would otherwise look like a broken keyboard; the note replaces
 * the field's error until her next clean keystroke, or until she leaves the box.
 * `rows` makes it a textarea (pair with `multiline` so line breaks survive).
 */
export default function TextField({
  label,
  script,
  long,
  person,
  multiline,
  email,
  max,
  rows,
  error,
  value,
  onChange,
}: TextOpts & {
  label: string;
  max: number;
  rows?: number;
  error?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useAdminI18n();
  const [note, setNote] = useState<string | null>(null);
  const opts = { script, long, person, multiline, email };

  const control = {
    dir: script === "ar" ? "rtl" : script === "en" ? "ltr" : "auto",
    "aria-invalid": !!(note ?? error),
    value,
    onBlur: () => setNote(null),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const raw = e.target.value;
      const bad = blockedChar(raw, opts);
      const clean = typedText(raw, opts);
      setNote(bad ? blockedMessage(t.validation, bad, opts) : clean.length > max ? t.validation.cut(max) : null);
      onChange(clean.slice(0, max));
    },
  } as const;

  return (
    <Field label={label} counter={{ value: value.length, max }} error={note ?? error}>
      {rows ? (
        <textarea
          rows={rows}
          {...control}
          className={cn(
            "w-full resize-none rounded-xl border border-black/10 bg-white px-3 py-2 text-start text-sm text-ink outline-none focus:border-sky focus:ring-2 focus:ring-sky/20",
            invalidRing,
          )}
        />
      ) : (
        <Input
          {...control}
          inputMode={email ? "email" : undefined}
          autoComplete={email ? "off" : undefined}
          className={script === "en" ? "text-left" : undefined}
        />
      )}
    </Field>
  );
}
