"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Button, Card, Field, Input } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { loginAction, type LoginState } from "../actions";

const initialState: LoginState = { error: null };

function SubmitButton() {
  const { t } = useAdminI18n();
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? t.login.submitting : t.login.submit}
    </Button>
  );
}

export default function LoginPage() {
  const { t, lang, toggle } = useAdminI18n();
  const [state, formAction] = useFormState(loginAction, initialState);

  return (
    <div className="grid min-h-screen place-items-center bg-cream px-5">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-red-grad text-sm font-bold text-white">
              R
            </span>
            <div className="text-start">
              <p className="font-display text-sm font-bold text-ink">{t.brand}</p>
              <p className="text-xs text-ink/45">{t.login.subtitle}</p>
            </div>
          </div>
          <button
            onClick={toggle}
            className="rounded-lg px-2 py-1 text-xs font-medium text-ink/50 transition-colors hover:bg-black/[0.04] hover:text-ink"
          >
            {lang === "ar" ? "EN" : "ع"}
          </button>
        </div>

        <Card className="p-6">
          <h1 className="mb-5 text-start font-display text-lg font-bold text-ink">
            {t.login.title}
          </h1>

          <form action={formAction} className="space-y-4">
            <Field label={t.login.email}>
              <Input
                name="email"
                type="email"
                dir="ltr"
                required
                autoComplete="username"
                autoFocus
                className="text-left"
              />
            </Field>

            <Field label={t.login.password}>
              <Input
                name="password"
                type="password"
                dir="ltr"
                required
                minLength={8}
                autoComplete="current-password"
                className="text-left"
              />
            </Field>

            {state.error && (
              <p
                role="alert"
                className="rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red"
              >
                {state.error === "invalid" ? t.login.invalid : t.login.error}
              </p>
            )}

            <SubmitButton />
          </form>
        </Card>

        <p className="mt-4 text-center text-[11px] text-ink/35">{t.login.staffOnly}</p>
      </div>
    </div>
  );
}
