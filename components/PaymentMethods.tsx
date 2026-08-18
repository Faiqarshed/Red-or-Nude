"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  CARD_NUMBER_MAX,
  cvvLength,
  formatCardNumber,
  formatExpiry,
  validateCard,
  type CardErrors,
  type FieldError,
} from "@/lib/card";

// Shared "Select Payment Method" panel (card form + mada / STC Pay / Apple Pay).
// Used by the booking and gift-card payment steps.
//
// The card fields were previously uncontrolled and decorative — nothing read
// them and Confirm fired whatever was typed. They are now validated against
// lib/card.ts, which holds the rules so they can be tested and can't drift.
//
// Card data still never leaves the browser. When a real gateway lands it will
// collect the PAN in its own hosted iframe, which is what keeps this origin out
// of PCI scope; these rules only catch typos before the customer is told
// "declined". `onValidityChange` lets a page disable its own confirm button too,
// since both this panel and the summary panel can start a payment.
type MethodId = "card" | "mada" | "stc" | "apple";

function Radio({ active }: { active: boolean }) {
  return (
    <span
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${
        active ? "border-red" : "border-red/40"
      }`}
    >
      {active && <span className="h-3 w-3 rounded-full bg-red" />}
    </span>
  );
}

function MethodLogo({ id }: { id: string }) {
  if (id === "stc") return <img src="/pay/stcpay.webp" alt="STC Pay" className="h-6 w-auto" />;
  if (id === "apple") return <img src="/pay/apple.webp" alt="Apple Pay" className="h-6 w-auto" />;
  return (
    <span className="rounded-md bg-[#eef3f7] px-2 py-1 text-left leading-none">
      <span className="block text-[10px] font-bold text-[#1a3668]">مدى</span>
      <span className="block text-[12px] font-extrabold tracking-tight">
        <span className="text-[#84bd00]">ma</span>
        <span className="text-[#00a1e0]">da</span>
      </span>
    </span>
  );
}

function Field({
  label,
  placeholder,
  ltr = false,
  dir,
  value,
  onChange,
  onBlur,
  error,
  inputMode,
  maxLength,
  autoComplete,
}: {
  label: string;
  placeholder: string;
  ltr?: boolean;
  dir: "rtl" | "ltr";
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  /** Shown only once the field has been touched, so typing isn't nagged at. */
  error?: string | null;
  inputMode?: "numeric" | "text";
  maxLength?: number;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] text-ink/55">{label}</span>
      <input
        dir={ltr ? "ltr" : dir}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-[12px] border bg-white px-4 py-3.5 text-sm text-ink outline-none placeholder:text-ink/35 ${
          error ? "border-red/60 focus:border-red" : "border-black/[0.06] focus:border-red/40"
        } ${ltr ? "text-left" : "text-start"}`}
      />
      {error && <span className="mt-1.5 block text-[11px] text-red">{error}</span>}
    </label>
  );
}

export default function PaymentMethods({
  onConfirm,
  onMethodChange,
  onValidityChange,
}: {
  onConfirm: () => void;
  onMethodChange?: (label: string) => void;
  /** Fires whenever the panel becomes payable, so a page can gate its own button. */
  onValidityChange?: (valid: boolean) => void;
}) {
  const { c, dir } = useI18n();
  const p = c.payment;
  const [method, setMethod] = useState<MethodId>("card");

  const [card, setCard] = useState({ number: "", name: "", expiry: "", cvv: "" });
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const errors: CardErrors = useMemo(() => validateCard(card), [card]);

  // The other three methods hand off to their own app or sheet — there is
  // nothing on this page for us to validate.
  const payable = method !== "card" || Object.keys(errors).length === 0;

  useEffect(() => {
    onValidityChange?.(payable);
  }, [payable, onValidityChange]);

  const messageFor = (key: keyof CardErrors): string | null => {
    if (!touched[key]) return null;
    const code: FieldError | undefined = errors[key];
    if (!code) return null;

    const e = p.cardErrors;
    switch (code) {
      case "required":
        return e.required;
      case "card-length":
        return e.cardLength;
      case "card-checksum":
        return e.cardChecksum;
      case "expiry-format":
        return e.expiryFormat;
      case "expiry-month":
        return e.expiryMonth;
      case "expiry-past":
        return e.expiryPast;
      case "expiry-far":
        return e.expiryFar;
      case "cvv-length":
        return e.cvvLength.replace("{n}", String(cvvLength(card.number)));
      case "name-short":
        return e.nameShort;
    }
  };

  const set = (key: keyof typeof card, value: string) =>
    setCard((prev) => ({ ...prev, [key]: value }));
  const blur = (key: string) => () => setTouched((prev) => ({ ...prev, [key]: true }));

  /** Mark everything touched so a click on a disabled-looking form explains itself. */
  const attemptConfirm = () => {
    if (!payable) {
      setTouched({ number: true, name: true, expiry: true, cvv: true });
      return;
    }
    onConfirm();
  };

  const labels: Record<MethodId, string> = {
    card: p.cardTitle,
    mada: p.madaTitle,
    stc: p.stcTitle,
    apple: p.appleTitle,
  };

  useEffect(() => {
    onMethodChange?.(labels[method]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, onMethodChange, labels[method]]);

  const otherMethods = [
    { id: "mada" as const, title: p.madaTitle, sub: p.madaSub },
    { id: "stc" as const, title: p.stcTitle, sub: p.stcSub },
    { id: "apple" as const, title: p.appleTitle, sub: p.appleSub },
  ];

  return (
    <section>
      <h2 className="mb-6 text-start font-display text-2xl font-extrabold text-ink">{p.title}</h2>

      {/* Credit / debit card */}
      <div
        className={`rounded-[20px] p-6 transition-colors ${
          method === "card" ? "bg-[#f9e9e9]" : "bg-white ring-1 ring-black/[0.05]"
        }`}
      >
        <button
          type="button"
          onClick={() => setMethod("card")}
          className="flex w-full items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <img src="/pay/mastercard.webp" alt="Mastercard" className="h-7 w-auto" />
            <div className="text-start">
              <p className="font-display text-base font-bold text-ink">{p.cardTitle}</p>
              <p className="text-[12px] text-ink/50">{p.cardSub}</p>
            </div>
          </div>
          <Radio active={method === "card"} />
        </button>

        {method === "card" && (
          <div className="mt-6 space-y-5">
            <Field
              label={p.cardNumber}
              placeholder="1234 5678 9012 3456"
              ltr
              dir={dir}
              value={card.number}
              // Reformatted as they type, so the grouping follows the brand
              // (Amex is 4-6-5) instead of fighting the caret.
              onChange={(v) => set("number", formatCardNumber(v))}
              onBlur={blur("number")}
              error={messageFor("number")}
              inputMode="numeric"
              maxLength={CARD_NUMBER_MAX + 3}
              autoComplete="cc-number"
            />
            <Field
              label={p.cardName}
              placeholder={p.cardNamePlaceholder}
              dir={dir}
              value={card.name}
              onChange={(v) => set("name", v)}
              onBlur={blur("name")}
              error={messageFor("name")}
              maxLength={120}
              autoComplete="cc-name"
            />
            <div className="grid grid-cols-2 gap-4">
              <Field
                label={p.cvv}
                placeholder={cvvLength(card.number) === 4 ? "1234" : "123"}
                ltr
                dir={dir}
                value={card.cvv}
                // Digits only, and never more than the brand's code length.
                onChange={(v) => set("cvv", v.replace(/\D/g, "").slice(0, cvvLength(card.number)))}
                onBlur={blur("cvv")}
                error={messageFor("cvv")}
                inputMode="numeric"
                maxLength={4}
                autoComplete="cc-csc"
              />
              <Field
                label={p.expiry}
                placeholder="MM/YY"
                ltr
                dir={dir}
                value={card.expiry}
                onChange={(v) => set("expiry", formatExpiry(v))}
                onBlur={blur("expiry")}
                error={messageFor("expiry")}
                inputMode="numeric"
                maxLength={5}
                autoComplete="cc-exp"
              />
            </div>
            <button
              type="button"
              onClick={attemptConfirm}
              aria-disabled={!payable}
              className={`w-full rounded-[12px] py-4 text-center text-sm font-bold transition-opacity ${
                payable
                  ? "bg-red-grad text-white hover:opacity-90"
                  : "cursor-not-allowed bg-black/[0.06] text-ink/40"
              }`}
            >
              {p.confirm}
            </button>
          </div>
        )}
      </div>

      {/* Other methods */}
      <div className="mt-4 space-y-4">
        {otherMethods.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMethod(m.id)}
            className={`flex w-full items-center justify-between rounded-[16px] bg-white px-6 py-5 ring-1 transition-colors ${
              method === m.id ? "ring-red/40" : "ring-black/[0.05] hover:ring-red/20"
            }`}
          >
            <div className="flex items-center gap-3">
              <MethodLogo id={m.id} />
              <div className="text-start">
                <p className="font-display text-base font-bold text-ink">{m.title}</p>
                {m.sub && <p className="text-[12px] text-ink/50">{m.sub}</p>}
              </div>
            </div>
            <Radio active={method === m.id} />
          </button>
        ))}
      </div>
    </section>
  );
}
