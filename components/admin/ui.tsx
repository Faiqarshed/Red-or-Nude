// Admin UI primitives.
//
// Deliberately hand-rolled rather than pulled from a component library: every
// layout utility here is logical (ps/pe, start/end, text-start) so the panel
// mirrors correctly in Arabic. Most off-the-shelf admin kits hardcode left/right
// and quietly break in RTL.
//
// Colour discipline (docs/ADMIN-PANEL.md §6): cream ground, white cards, brand
// red reserved for primary and destructive actions only. Dense tables need
// neutral ground — a red-saturated admin is unreadable after an hour.

import { cn } from "@/lib/cn";

// ------------------------------------------------------------- surfaces ----

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(24,23,23,0.04)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] px-5 py-4">
      <div className="text-start">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-ink/50">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="text-start">
        <h1 className="font-display text-2xl font-bold text-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink/55">{subtitle}</p> : null}
      </div>
      {action}
    </header>
  );
}

// -------------------------------------------------------------- controls ---

const buttonVariants = {
  primary: "bg-red text-white hover:bg-red-dark disabled:bg-red/50",
  secondary:
    "bg-white text-ink border border-black/10 hover:bg-black/[0.03] disabled:text-ink/40",
  ghost: "text-ink/70 hover:bg-black/[0.04] hover:text-ink",
  danger: "bg-red text-white hover:bg-red-dark",
} as const;

const buttonSizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky",
        "disabled:cursor-not-allowed",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    />
  );
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink",
        "text-start outline-none transition-colors placeholder:text-ink/35",
        "focus:border-sky focus:ring-2 focus:ring-sky/20",
        "disabled:bg-black/[0.03] disabled:text-ink/40",
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-start">
      <span className="mb-1.5 block text-xs font-medium text-ink/70">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-red">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-ink/45">{hint}</span>
      ) : null}
    </label>
  );
}

// ---------------------------------------------------------------- status ---

/**
 * Status colours are their own semantic scale, not brand colours — a cancelled
 * booking must not read as "on brand".
 */
const badgeTones = {
  neutral: "bg-black/[0.05] text-ink/70",
  info: "bg-sky/15 text-[#2c6a88]",
  success: "bg-[#1f7a4d]/12 text-[#1f7a4d]",
  warning: "bg-[#b7791f]/14 text-[#8a5a06]",
  danger: "bg-red/10 text-red",
} as const;

/**
 * The tone a 1–5 rating is shown in, wherever one is shown.
 *
 * A 2 is a complaint and must never read the same as a 5, so the thresholds
 * belong in one place: the bookings grid, the booking drawer and the reviews
 * table all render the same number and have to agree about what it means.
 */
export function scoreTone(value: number): keyof typeof badgeTones {
  return value >= 4 ? "success" : value === 3 ? "warning" : "danger";
}

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: keyof typeof badgeTones;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="text-start">
          <p className="text-xs font-medium text-ink/55">{label}</p>
          {/* Tabular numerals: figures must align down a column. */}
          <p className="mt-2 font-display text-2xl font-bold tabular-nums text-ink">{value}</p>
          {hint ? <p className="mt-1 text-xs text-ink/45">{hint}</p> : null}
        </div>
        {icon ? <span className="text-ink/25">{icon}</span> : null}
      </div>
    </Card>
  );
}

export function EmptyState({
  title,
  body,
  icon,
}: {
  title: string;
  body?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon ? <span className="text-ink/20">{icon}</span> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {body ? <p className="max-w-sm text-xs text-ink/50">{body}</p> : null}
    </div>
  );
}
