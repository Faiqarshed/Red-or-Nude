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
import Link from "next/link";
import { ChevronLeft, ChevronRight, Loader2, TrendingDown, TrendingUp } from "lucide-react";
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

// Taller below `sm`, where these are thumb targets rather than mouse targets.
// The desktop heights are the ones after the prefix, unchanged.
const buttonSizes = {
  sm: "h-10 px-3 text-xs sm:h-8",
  md: "h-12 px-4 text-sm sm:h-10",
} as const;

/**
 * `pending` is the button's own answer to "did my click do anything?".
 *
 * It disables and shows a spinner in one prop, so a call site cannot do half of
 * it. Every screen in the panel used to hand-roll this pair, and they drifted:
 * the common shape was `setBusy(false)` immediately after the server action
 * returned, followed by an un-awaited `router.refresh()`. That re-enabled the
 * button while the screen still showed pre-mutation data, so the receptionist
 * saw a dead interval and clicked again. Driving this from a `useTransition`
 * `isPending` instead keeps it true until the fresh render is actually on
 * screen, which is the moment she is waiting for.
 *
 * `disabled` still works and is OR-ed with this — a button can be both pending
 * and unavailable for its own reasons.
 */
export function Button({
  variant = "primary",
  size = "md",
  className,
  pending = false,
  disabled,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
  pending?: boolean;
}) {
  return (
    <button
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky",
        "disabled:cursor-not-allowed",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {pending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        // 16px below `sm` is not a type choice: iOS Safari zooms the whole page
        // in on focus for anything smaller, which throws the layout sideways
        // every time someone taps a field. Desktop keeps text-sm.
        "h-12 w-full rounded-xl border border-black/10 bg-white px-3 text-base text-ink sm:h-10 sm:text-sm",
        "text-start outline-none transition-colors placeholder:text-ink/35",
        "focus:border-sky focus:ring-2 focus:ring-sky/20",
        invalidRing,
        "disabled:bg-black/[0.03] disabled:text-ink/40",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Red outline for a control marked `aria-invalid`. Driven by the attribute
 * rather than a prop, so the same flag a screen reader hears is what paints it —
 * and native selects and textareas can take the class too.
 */
export const invalidRing =
  "aria-[invalid=true]:border-red aria-[invalid=true]:focus:border-red aria-[invalid=true]:focus:ring-red/15";

/**
 * Grows a control's *touch* area to 48px without moving a pixel of it.
 *
 * The panel's small round buttons are 32px because that is the right size for a
 * cursor; a thumb needs half as much again. A transparent ::after does it
 * without resizing anything visible, and drops away at `sm` where there is a
 * pointer. The element needs to be a positioning context — every user here is
 * already `relative`.
 *
 * Controls that are not 32px squares set their own inset; this is the common
 * case, not the only one.
 */
export const touchTarget = "after:absolute after:-inset-2 after:content-[''] sm:after:hidden";

/**
 * The same for the 28px icon buttons — ten pixels of reach rather than eight.
 *
 * Only for a button standing on its own. Two of these side by side, as the
 * reorder arrows are, would have overlapping hit areas and take each other's
 * taps; those get bigger instead. See CatalogView.
 */
export const touchTargetSm = "after:absolute after:-inset-2.5 after:content-[''] sm:after:hidden";

/**
 * And for the 20×36px active switches, the smallest targets in the panel.
 *
 * They already carry `relative` for their own knob, so the ::after costs them
 * nothing. Fourteen pixels of reach takes them to 48 tall and 64 wide.
 */
export const touchTargetSwitch =
  "after:absolute after:-inset-3.5 after:content-[''] sm:after:hidden";

/**
 * The segmented tab strips — catalogue, gift cards, no-shows, bookings, my day,
 * performance. Seven of them, each previously carrying its own copy of these
 * classes, which is how the touch target came to be added seven times by hand.
 *
 * Shape only. The strips differ in container, element (button or Link) and text
 * size, so those stay at the call site rather than becoming four props here.
 */
export const tabItem =
  "min-h-[48px] rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:min-h-0";

/** Selected or not, in the one place that decides what selected looks like. */
export const tabTone = (active: boolean) =>
  active ? "bg-red/[0.07] text-red" : "text-ink/55 hover:bg-black/[0.03]";

/**
 * Everything a refused save is waiting on, in one box beside the Save button:
 * the field checks (also shown under their fields, for the ones scrolled out of
 * view), or the server's own refusal once those have passed.
 */
export function FormErrors({
  errors,
  summary,
  server,
}: {
  errors: Record<string, string>;
  summary: (n: number) => string;
  server?: string | null;
}) {
  const list = Object.values(errors);
  if (list.length === 0 && !server) return null;
  return (
    <div role="alert" className="rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
      {list.length > 0 ? (
        <>
          <p className="font-medium">{summary(list.length)}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-4">
            {list.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      ) : (
        server
      )}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  counter,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  /** Shows "12/30" beside the label; amber once the limit is reached. */
  counter?: { value: number; max: number };
  children: React.ReactNode;
}) {
  return (
    <label className="block text-start">
      <span className="mb-1.5 flex items-baseline justify-between gap-2 text-xs font-medium text-ink/70">
        {label}
        {counter ? (
          <span
            dir="ltr"
            className={cn(
              "text-[11px] font-normal tabular-nums",
              counter.value >= counter.max ? "text-[#8a5a06]" : "text-ink/35",
            )}
          >
            {counter.value}/{counter.max}
          </span>
        ) : null}
      </span>
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
 * A figure, at one of three weights.
 *
 * `hero` is for the two or three numbers somebody would act on — today's
 * takings, how full the chairs are. `live` is an ordinary operational count.
 * `quiet` is a reference figure like "how many services exist", which changes
 * monthly and was being given exactly the same visual weight as the money.
 * Five identical tiles make the eye search; two loud ones and three quiet ones
 * do not.
 *
 * Weight is emphasis only. Nothing here means anything by colour alone — the
 * label still says what the figure is, and `delta` spells out its direction in
 * words as well as in colour.
 *
 * `href` makes the whole tile a link and adds the chevron that says so. A
 * number nobody can open is trivia: "38 bookings today" is worth having only
 * if it takes you to the thirty-eight.
 */
const statWeights = {
  hero: { card: "p-5 ring-1 ring-red/15", value: "text-[32px] leading-none", icon: "text-red/40" },
  live: { card: "p-5", value: "text-2xl leading-none", icon: "text-ink/25" },
  quiet: { card: "p-4", value: "text-xl leading-none text-ink/80", icon: "text-ink/20" },
} as const;

export function StatCard({
  label,
  value,
  hint,
  icon,
  weight = "live",
  href,
  delta,
  aside,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  weight?: keyof typeof statWeights;
  /** Makes the tile a link. Omit for a figure with nowhere to go. */
  href?: string;
  /** Movement against the comparable earlier period, already worked out. */
  delta?: { pct: number; up: boolean; label: string };
  /** A sparkline or a bar, beside the figure. */
  aside?: React.ReactNode;
}) {
  const w = statWeights[weight];

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-ink/55">{label}</p>
        {href ? <Chevron /> : icon ? <span className={w.icon}>{icon}</span> : null}
      </div>

      <div className="mt-2 flex items-end justify-between gap-4">
        <div className="min-w-0">
          {/* Tabular numerals: figures must align down a column. */}
          <p className={cn("font-display font-bold tabular-nums text-ink", w.value)}>{value}</p>
          {delta ? <Delta {...delta} /> : null}
          {/* A div, not a p: a hint may carry a Bar, and a block element
              inside a paragraph is invalid markup React will complain about. */}
          {hint ? <div className="mt-1.5 text-xs text-ink/45">{hint}</div> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    </>
  );

  // `max-sm:h-full` on both, because the grid stretches only its own item — the
  // Link — and the Card inside it would otherwise stop at its content. Two
  // tiles side by side on a phone, one label wrapping to a second line, and the
  // pair comes out at two different heights. Scoped below `sm`: the labels fit
  // on one line at desktop widths, so nothing there moves.
  if (!href) return <Card className={cn(w.card, "text-start max-sm:h-full")}>{body}</Card>;

  return (
    <Link href={href} className="group block text-start max-sm:h-full">
      <Card className={cn(w.card, "transition-colors group-hover:border-red/25 max-sm:h-full")}>
        {body}
      </Card>
    </Link>
  );
}

/**
 * The chevron that means "this opens something".
 *
 * Mirrored in Arabic like the sidebar's panel icon: it points the way the
 * reader is going, which is the opposite way round in RTL.
 */
function Chevron() {
  return (
    <ChevronRight
      className="h-4 w-4 shrink-0 text-ink/25 transition-colors group-hover:text-red rtl:rotate-180"
      strokeWidth={1.75}
      aria-hidden
    />
  );
}

/**
 * Movement against an earlier period.
 *
 * `label` says what it is being compared against and is not optional: "+18%"
 * on its own invites the reader to guess the baseline, and they guess wrong.
 */
function Delta({ pct, up, label }: { pct: number; up: boolean; label: string }) {
  return (
    <span
      className={cn(
        "mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        up ? "bg-[#1f7a4d]/12 text-[#1f7a4d]" : "bg-red/10 text-red",
      )}
    >
      {up ? (
        <TrendingUp className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      ) : (
        <TrendingDown className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      )}
      <span className="tabular-nums">{Math.abs(pct)}%</span>
      <span className="font-normal opacity-70">{label}</span>
    </span>
  );
}

/**
 * How full something is, 0–100.
 *
 * The colour is the verdict; the number beside it is the fact. A bar that only
 * turns amber tells a colour-blind manager nothing, so the figure is always
 * printed. Thresholds live here rather than at each call site for the same
 * reason scoreTone does — three screens showing the same percentage have to
 * agree about whether it is good news.
 *
 * Low is red on purpose. An empty chair is the loss nobody sees.
 */
export function Bar({
  value,
  label,
  brand,
}: {
  value: number;
  label?: string;
  /** Brand fill instead of the verdict colours — for a share, not a score. */
  brand?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const fill = brand
    ? "bg-red-grad"
    : pct >= 75
      ? "bg-[#1f7a4d]"
      : pct >= 50
        ? "bg-[#b7791f]"
        : "bg-red";

  return (
    <div className="w-full">
      {label ? (
        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-ink/55">
          <span className="truncate">{label}</span>
          <span className="font-semibold tabular-nums text-ink">{pct}%</span>
        </div>
      ) : null}
      <div className="h-2 overflow-hidden rounded-full bg-black/[0.06]">
        <div className={cn("h-full rounded-full", fill)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * A week of something, at a glance.
 *
 * Deliberately unlabelled and not hoverable: it answers "which way is this
 * going", and the figures themselves are one click away on the screen the tile
 * links to. A chart with axes belongs on that screen, not in a 132px tile.
 */
export function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;

  const w = 132;
  const h = 40;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  // A flat week would divide by zero and, worse, draw a line at the top of the
  // box as if it were a peak. Falling back to 1 draws it along the bottom.
  const span = max - min || 1;

  const xy = points.map((p, i): [number, number] => [
    pad + (i / (points.length - 1)) * (w - pad * 2),
    h - pad - ((p - min) / span) * (h - pad * 2),
  ]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const stroke = points[points.length - 1] >= points[0] ? "#1f7a4d" : "#B80007";
  const [lastX, lastY] = xy[xy.length - 1];

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden>
      <polygon points={`${line} ${w - pad},${h} ${pad},${h}`} fill={stroke} opacity="0.08" />
      <polyline points={line} stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="3" fill={stroke} />
    </svg>
  );
}

/**
 * A staff member where a row needs a face and there is none to show.
 *
 * Dimmed when she is not in today — the same distinction the floor screen
 * draws, so a greyed name means here what it means there.
 */
export function Avatar({
  name,
  size = "sm",
  muted,
}: {
  name: string;
  size?: "sm" | "md";
  muted?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-semibold",
        size === "md" ? "h-9 w-9 rounded-xl text-sm" : "h-7 w-7 rounded-lg text-[11px]",
        muted ? "bg-black/[0.06] text-ink/40" : "bg-red-grad text-white",
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "—"}
    </span>
  );
}

/**
 * One row of a list that goes somewhere.
 *
 * The panel's lists were read-only text: you could see that Sara did nine
 * services and had no way to open her. The whole row is the hit target rather
 * than the name inside it — this is tapped with a thumb, sometimes by someone
 * standing up.
 *
 * Wrap a group in `divide-y divide-black/[0.04]` for the rules between rows;
 * doing it here would put a border under a row that is on its own.
 */
export function DataRow({
  href,
  className,
  children,
}: {
  href?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const inner = (
    <div
      className={cn(
        "flex items-center gap-3 px-5 py-3 text-start",
        href && "transition-colors group-hover:bg-black/[0.02]",
        className,
      )}
    >
      {children}
      {href ? <Chevron /> : null}
    </div>
  );

  if (!href) return inner;
  return (
    <Link href={href} className="group block">
      {inner}
    </Link>
  );
}

// ----------------------------------------------------------------- media ----

const THUMB_SIZES = {
  sm: { box: "h-11 w-11 rounded-lg", px: 44 },
  md: { box: "h-16 w-16 rounded-xl", px: 64 },
  lg: { box: "h-24 w-full rounded-xl", px: 320 },
  // For the one place the picture is the point rather than a hint: a technician
  // is about to paint this by hand, and 64px of it tells her nothing.
  xl: { box: "h-40 w-40 rounded-2xl", px: 320 },
  hero: { box: "h-56 w-full rounded-2xl", px: 640 },
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
    // Shallower on a phone. Fourteen units of padding above and below is a
    // quarter of a small screen spent saying "None", and an empty card that
    // large reads as something that failed to load rather than something with
    // nothing in it yet.
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center sm:py-14">
      {icon ? <span className="text-ink/20">{icon}</span> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {body ? <p className="max-w-sm text-xs text-ink/50">{body}</p> : null}
    </div>
  );
}
/**
 * Step a day at a time, or jump to any date.
 *
 * The arrows are fine for "yesterday" and useless for "the 14th of next
 * month", which is most of what the desk is asked on the phone — so the middle
 * is a real date input. Native, so it opens the platform's own calendar and
 * keeps the keyboard path for anyone who would rather type.
 *
 * `showPicker()` on click because browsers only open the calendar from the
 * small icon otherwise, and the whole control looks clickable. Guarded:
 * Firefox has no such method, and Safari throws if the call is not from a user
 * gesture.
 *
 * The date lives in the URL on both screens that use this, so the component
 * takes a value and a callback and knows nothing about routing.
 */
export function DateStepper({
  date,
  onChange,
  labels,
}: {
  /** `YYYY-MM-DD`. */
  date: string;
  onChange: (date: string) => void;
  labels: { prev: string; next: string; date: string };
}) {
  const step = (days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    onChange(d.toISOString().slice(0, 10));
  };

  return (
    // Full width on a phone so the date sits between its two arrows instead of
    // being squeezed by whatever else shares the toolbar row.
    <div className="flex items-center gap-1 rounded-xl border border-black/[0.06] bg-white p-1 max-sm:w-full">
      <button
        onClick={() => step(-1)}
        className={cn(
          "relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink/50 hover:bg-black/[0.04]",
          touchTarget,
        )}
        aria-label={labels.prev}
      >
        <ChevronLeft className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
      </button>
      <input
        type="date"
        value={date}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        onClick={(e) => {
          const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
          try {
            el.showPicker?.();
          } catch {
            /* not supported here, or not a trusted gesture — the icon still works */
          }
        }}
        aria-label={labels.date}
        className="min-w-0 flex-1 cursor-pointer rounded-lg bg-transparent px-2 text-center text-base font-medium tabular-nums text-ink outline-none focus:bg-black/[0.03] sm:min-w-[130px] sm:flex-none sm:text-sm"
        dir="ltr"
      />
      <button
        onClick={() => step(1)}
        className={cn(
          "relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink/50 hover:bg-black/[0.04]",
          touchTarget,
        )}
        aria-label={labels.next}
      >
        <ChevronRight className="h-4 w-4 rtl:rotate-180" strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * Narrow a screen to one branch, or widen it to all of them.
 *
 * Rendered only where there is a real choice: `options` comes back empty from
 * branchScope() for anyone pinned to a single branch, and an empty list renders
 * nothing rather than a control that cannot change the answer.
 *
 * The branch lives in the URL like the date does, so a screen can be sent to
 * someone and arrive showing what the sender was looking at.
 */
export function BranchFilter({
  branchId,
  options,
  allLabel,
  lang,
  allowAll = true,
  onChange,
}: {
  branchId: string | null;
  options: { id: string; name: { ar: string; en: string } }[];
  allLabel: string;
  lang: "ar" | "en";
  /** False on the desk and the floor: those are one place, never all of them. */
  allowAll?: boolean;
  onChange: (branchId: string | null) => void;
}) {
  if (options.length < 2) return null;

  return (
    <select
      value={branchId ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={allLabel}
      className="h-12 rounded-xl border border-black/[0.06] bg-white px-3 text-base text-ink outline-none sm:h-10 sm:text-sm"
    >
      {allowAll ? <option value="">{allLabel}</option> : null}
      {options.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name[lang] || b.name.en}
        </option>
      ))}
    </select>
  );
}
