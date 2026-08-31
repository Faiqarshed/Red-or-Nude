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

import Image from "next/image";
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

/**
 * `live` marks a figure that moves during the day — today's bookings, today's
 * takings — against reference counts like "how many services exist", which
 * change monthly and were being given exactly the same visual weight. Five
 * identical tiles make the eye search; two loud ones and three quiet ones do not.
 *
 * It is emphasis only. Nothing here encodes meaning by colour alone: the label
 * above each figure still says what it is.
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  live = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  live?: boolean;
}) {
  return (
    <Card className={cn("p-5", live && "ring-1 ring-red/15")}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-start">
          <p className="text-xs font-medium text-ink/55">{label}</p>
          {/* Tabular numerals: figures must align down a column. */}
          <p
            className={cn(
              "mt-2 font-display font-bold tabular-nums text-ink",
              live ? "text-3xl" : "text-2xl",
            )}
          >
            {value}
          </p>
          {hint ? <p className="mt-1 text-xs text-ink/45">{hint}</p> : null}
        </div>
        {icon ? <span className={live ? "text-red/40" : "text-ink/25"}>{icon}</span> : null}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------- media ----

const THUMB_SIZES = {
  sm: { box: "h-11 w-11 rounded-lg", px: 44 },
  md: { box: "h-16 w-16 rounded-xl", px: 64 },
  lg: { box: "h-24 w-full rounded-xl", px: 320 },
} as const;

/**
 * A picture of the thing, wherever a row or card names one.
 *
 * The panel was entirely text: a technician read "Almond — Ombré" and had to
 * picture it. Every service, design and add-on already carries an image, so the
 * screens simply weren't asking for them.
 *
 * Three rules make it safe to drop anywhere:
 *
 * 1. **Null is normal.** A catalogue row without an image renders a tinted block
 *    in the brand cream, not a broken-image icon and not a gap that shifts the
 *    layout. Nothing here is required to exist.
 * 2. **It never carries meaning alone.** Every caller keeps its text label. The
 *    thumbnail is recognition at a glance; the words are still the record, and
 *    they are what a screen reader gets when `alt` is empty by design.
 * 3. **`fixed` sizing, always.** These sit in dense grids, so an image that
 *    reflows on load would jump the row under the receptionist's finger.
 *
 * `src` is expected to have been through `mediaUrl` (lib/storage) already —
 * resolving storage keys is a server concern and this is a client component.
 */
export function Thumb({
  src,
  alt,
  size = "sm",
  className,
}: {
  src?: string | null;
  alt?: string;
  size?: keyof typeof THUMB_SIZES;
  className?: string;
}) {
  const { box, px } = THUMB_SIZES[size];
  const shell = cn("shrink-0 overflow-hidden bg-cream ring-1 ring-black/[0.06]", box, className);

  if (!src) return <div className={shell} aria-hidden />;

  return (
    <div className={shell}>
      <Image
        src={src}
        alt={alt ?? ""}
        width={px}
        height={px}
        // Decorative by default: the row's own text already says what this is,
        // so an empty alt keeps a screen reader from hearing it twice.
        className="h-full w-full object-cover"
      />
    </div>
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
