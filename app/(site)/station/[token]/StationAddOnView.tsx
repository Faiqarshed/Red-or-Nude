"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { declineMessage, usePaymentReturn, type PaymentOutcome } from "@/components/StreamPayCheckout";
import { CheckingModal, PayNoticeModal, PayStep } from "@/components/PayFlow";
import GuestPicker, { emptyGuest, guestTotals, toMemberSelection, type GuestState } from "@/components/booking/GuestPicker";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { saveBooking, formatDateLabel, formatTime } from "@/lib/booking";
import { UTC_OFFSET_HOURS } from "@/lib/time";
import type { PublicCatalog } from "@/lib/catalog";
import type { Localized } from "@/lib/localized";
// Type-only, so it is erased before bundling and the `server-only` guard in
// lib/availability.ts is never actually imported into this client component.
import type { StationChoice } from "@/lib/availability";

// The scan-to-add screen (brief §2.7): what the QR sticker on her table opens.
//
// Two jobs, so two tabs, each ending in one button:
//
//   For right now — a basket for the visit she is in: treats, and service
//   add-ons when the chair is free long enough after her. One payment, here,
//   through lib/station-treat.ts.
//
//   Next appointment — the booking page's own picker (service, add-ons,
//   removal, design) for a slot right after her, this chair or a free one.
//   Hands off to the ordinary /booking/payment, with the chosen chair pinned.
//
// Kept as two payments on purpose. A treat is added to the visit and done; a
// new appointment holds a chair that can be lost meanwhile. One payment for
// both would leave her charged for a coffee and a booking that failed.
//
// There is deliberately no date picker. The point of the QR is "the moment I
// finish"; any other time is the booking page's job.

type Props = {
  branchId: string;
  branchName: Localized | null;
  /** The chair whose sticker was scanned, free or not. */
  scannedLabel: string;
  /** ISO UTC — the current appointment's finish, or now for an empty chair. */
  startsAt: string;
  inService: boolean;
  currentServiceName: Localized | null;
  customerName: string | null;
  /** Chairs free at `startsAt` for long enough to fit something. May be empty. */
  options: StationChoice[];
  catalog: PublicCatalog;
  /** How long the scanned chair is free after her visit: what add-ons may take. */
  freeAfterMin: number;
  /** Add-on ids already on her visit. */
  added: string[];
  /** The scanned sticker, which is the whole credential for buying now. */
  token: string;
  /** Back from the bank (`?paid=`): the loader is drawn from the first paint. */
  returning: boolean;
};

type NowItem = { id: string; name: Localized; price: number; img: string | null; durationMin: number };

export default function StationAddOnView({
  branchId,
  branchName,
  scannedLabel,
  startsAt,
  inService,
  currentServiceName,
  customerName,
  options,
  catalog,
  freeAfterMin,
  added: addedAtLoad,
  token: scannedToken,
  returning,
}: Props) {
  const router = useRouter();
  const { c, lang } = useI18n();
  const s = c.station;
  const p = c.payment;
  const named = (label: string) => `${s.at} ${label}`;

  const [tab, setTab] = useState<"now" | "next">(inService ? "now" : "next");

  // Local wall-clock: she cares about "3:40", not an ISO instant.
  const localDate = new Date(new Date(startsAt).getTime() + UTC_OFFSET_HOURS * 3_600_000).toISOString();
  const timeLabel = formatTime(localDate.slice(11, 16), c.date);
  const dateLabel = formatDateLabel(localDate.slice(0, 10), lang);

  // ---- For right now ------------------------------------------------------

  const treats: NowItem[] = catalog.checkoutAddons.map((t) => ({ ...t, durationMin: 0 }));
  const addons: NowItem[] = catalog.addons;
  const all = [...treats, ...addons];

  const [added, setAdded] = useState<string[]>(addedAtLoad);
  const [basket, setBasket] = useState<string[]>([]);
  const [checkout, setCheckout] = useState<{ ref: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** What was just bought, for the confirmation pop-up. */
  const [bought, setBought] = useState<NowItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const notify = (m: string) => {
    setNotice(m);
    setNoticeOpen(true);
  };

  const inBasket = all.filter((i) => basket.includes(i.id));
  const basketTotal = inBasket.reduce((n, i) => n + i.price, 0);
  const basketMin = inBasket.reduce((n, i) => n + i.durationMin, 0);
  const toggle = (id: string) => {
    setBasket((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
  };

  const refusal = (code: string | undefined) =>
    code === "already-added"
      ? s.treatAlready
      : code === "not-in-service"
        ? s.treatNotInService
        : code === "no-time"
          ? s.treatNoTime
          : code === "declined" || code === "payment-declined"
            ? s.treatDeclined
            : s.treatFailed;

  const onPaid = (outcome: PaymentOutcome) => {
    if (outcome.status === "paid" && outcome.result.kind === "treat") {
      // Matched by name: back from a full-window checkout, names are all there is.
      const names = (outcome.result.names as { en: string }[]).map((n) => n.en);
      const items = all.filter((i) => names.includes(i.name.en));
      setAdded((a) => [...a, ...items.map((i) => i.id)]);
      setBasket([]);
      setCheckout(null);
      setBought(items);
      return;
    }
    setCheckout(outcome.status === "failed" ? (outcome.checkout ?? null) : null);
    notify(declineMessage(c.payDecline, outcome) ?? refusal(outcome.status === "failed" ? outcome.error : undefined));
  };
  const checkingPayment = usePaymentReturn(onPaid, returning);

  const pay = async () => {
    if (basket.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/station/treat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: scannedToken, addonIds: basket }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) return notify(refusal(data?.error));
      if (data.checkout) {
        setCheckout(data.checkout);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      onPaid({ status: "paid", result: { kind: "treat", names: data.names } });
    } catch {
      notify(s.treatFailed);
    } finally {
      setBusy(false);
    }
  };

  // ---- Next appointment ---------------------------------------------------

  // The scanned chair is first when it is on offer at all: "can I stay put?".
  const stay = options[0]?.isCurrent ? options[0] : null;
  const alternatives = options.filter((o) => !o.isCurrent);
  const [chairToken, setChairToken] = useState<string | null>(stay?.token ?? null);
  const chair = options.find((o) => o.token === chairToken) ?? null;
  const [guest, setGuest] = useState<GuestState>(emptyGuest);

  // Only services that fit this chair's free time. The picker renders by index,
  // so the same filtered catalogue is used for pricing and for the hand-off.
  const fitting = useMemo(
    () => ({ ...catalog, services: catalog.services.filter((x) => chair && x.durationMin <= chair.freeMin) }),
    [catalog, chair],
  );
  const totals = guestTotals(fitting, guest);
  const tooLong = guest.service !== null && chair !== null && totals.durationMin > chair.freeMin;

  const proceed = () => {
    if (!chair || guest.service === null || tooLong) return;
    saveBooking({
      branchId,
      startsAt,
      members: [{ ...toMemberSelection(fitting, guest, lang), guestName: null }],
      branch: branchName ? pick(branchName, lang) : null,
      dateLabel,
      timeLabel,
      checkoutAddons: catalog.checkoutAddons,
      grossTotal: totals.price,
      total: totals.price,
      refillOf: null,
      // The chosen chair — this table, or the one she moves to. Re-checked under
      // a lock by POST /api/bookings.
      stationToken: chair.token,
    });
    router.push("/booking/payment");
  };

  // ---- Screen -------------------------------------------------------------

  const itemRow = (item: NowItem) => {
    const has = added.includes(item.id);
    const on = basket.includes(item.id);
    // An add-on that would not fit beside what is already in the basket.
    const noRoom = !on && item.durationMin > 0 && basketMin + item.durationMin > freeAfterMin;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => toggle(item.id)}
        disabled={has || noRoom || checkout !== null}
        aria-pressed={on}
        className={`flex items-center gap-3 rounded-[16px] border p-3 text-start transition-colors disabled:cursor-not-allowed ${
          has
            ? "border-[#2f7d4f]/30 bg-[#eaf5ee]"
            : on
              ? "border-red bg-red/[0.04] ring-1 ring-red"
              : "border-black/[0.08] bg-white hover:border-red/30 disabled:opacity-50"
        }`}
      >
        {item.img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.img} alt="" className="h-14 w-14 shrink-0 rounded-[12px] object-cover" />
        ) : (
          <span className="h-14 w-14 shrink-0 rounded-[12px] bg-black/[0.05]" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{pick(item.name, lang)}</span>
          <span className="flex items-center gap-1 text-[13px] text-ink/55">
            <Riyal className="h-3 w-3" />
            {item.price}
            {item.durationMin > 0 && <span className="ms-1">· {s.extraMin.replace("{n}", String(item.durationMin))}</span>}
          </span>
        </span>
        <span
          aria-hidden
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[13px] font-bold ${
            has ? "bg-[#2f7d4f] text-white" : on ? "bg-red text-white" : "bg-black/[0.06] text-transparent"
          }`}
        >
          ✓
        </span>
        {(has || noRoom) && (
          <span className="shrink-0 text-[11px] font-semibold text-ink/50">{has ? s.treatAdded : s.noRoom}</span>
        )}
      </button>
    );
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[620px] px-4 pb-40 pt-[112px] sm:px-6">
        <p className="text-[11px] uppercase tracking-wider text-ink/40">
          {named(scannedLabel)}
          {branchName ? ` · ${pick(branchName, lang)}` : ""}
        </p>
        <h1 className="mt-1 font-display text-2xl font-extrabold text-red">{s.title}</h1>
        <p className="mt-1 text-[13px] text-ink/55">
          {inService ? (
            <>
              {customerName ? `${customerName} · ` : ""}
              {currentServiceName ? `${pick(currentServiceName, lang)} · ` : ""}
              {s.afterCurrent} <span className="font-semibold text-ink">{timeLabel}</span>
            </>
          ) : (
            <>
              {s.startsAt} <span className="font-semibold text-ink">{timeLabel}</span>
            </>
          )}
        </p>

        {/* Two jobs, two tabs. Only shown while she is in the chair: an empty
            table has no visit to add to, so it goes straight to booking. */}
        {inService && (
          <div role="tablist" className="mt-6 grid grid-cols-2 gap-1 rounded-full bg-white p-1 ring-1 ring-black/[0.05]">
            {(["now", "next"] as const).map((k) => (
              <button
                key={k}
                role="tab"
                type="button"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`rounded-full px-3 py-2.5 text-sm font-semibold transition-colors ${
                  tab === k ? "bg-red text-white" : "text-ink/60 hover:text-ink"
                }`}
              >
                {k === "now" ? s.tabNow : s.tabNext}
              </button>
            ))}
          </div>
        )}

        {tab === "now" && inService ? (
          checkout ? (
            <div className="mt-6">
              <PayStep
                checkout={checkout}
                onDone={onPaid}
                notice={notice}
                sub={inBasket.map((i) => pick(i.name, lang)).join(" · ")}
              />
              <button
                type="button"
                onClick={() => setCheckout(null)}
                className="mt-3 text-[13px] font-semibold text-ink/55 underline underline-offset-4 hover:text-red"
              >
                {s.changeOrder}
              </button>
            </div>
          ) : (
            <section className="mt-6 space-y-6">
              <p className="text-[13px] text-ink/60">{s.nowNote}</p>

              {treats.length > 0 && (
                <div>
                  <p className="mb-3 font-display text-base font-extrabold text-ink">{s.treatsHeading}</p>
                  <div className="grid gap-2">{treats.map(itemRow)}</div>
                </div>
              )}

              {addons.length > 0 && (
                <div>
                  <p className="font-display text-base font-extrabold text-ink">{s.addonsHeading}</p>
                  <p className="mb-3 mt-1 text-[12px] text-ink/50">
                    {freeAfterMin > 0
                      ? s.addonsFree.replace("{table}", named(scannedLabel)).replace("{n}", String(freeAfterMin))
                      : s.addonsNone}
                  </p>
                  {freeAfterMin > 0 && <div className="grid gap-2">{addons.map(itemRow)}</div>}
                </div>
              )}
            </section>
          )
        ) : options.length === 0 ? (
          <div className="mt-6 rounded-[20px] bg-[#fbeaea] p-5">
            <p className="font-display text-lg font-extrabold text-red">{s.noneTitle}</p>
            <p className="mt-1 text-[13px] text-ink/70">{s.noneNote}</p>
            <Link href="/booking" className="mt-4 inline-flex rounded-full bg-red px-6 py-3 text-sm font-semibold text-white">
              {s.bookElsewhere}
            </Link>
          </div>
        ) : (
          <section className="mt-6">
            {/* The answer first: can she stay where she is. */}
            <div className={`rounded-[20px] p-5 ${stay ? "bg-[#eaf5ee] ring-1 ring-[#2f7d4f]/15" : "bg-[#fbeaea]"}`}>
              <p className={`font-display text-lg font-extrabold ${stay ? "text-[#2f7d4f]" : "text-red"}`}>
                {stay ? s.stayTitle.replace("{table}", named(scannedLabel)) : s.takenTitle.replace("{table}", named(scannedLabel))}
              </p>
              <p className="mt-1 text-[13px] text-ink/70">
                {stay ? s.stayNote.replace("{n}", String(stay.freeMin)) : s.takenNote}
              </p>
            </div>

            {!stay && (
              <>
                <p className="mt-6 font-display text-base font-extrabold text-ink">{s.pickTable}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {alternatives.map((o) => (
                    <button
                      key={o.token}
                      type="button"
                      onClick={() => {
                        setChairToken(o.token);
                        // What fitted the last chair may not fit this one.
                        setGuest(emptyGuest);
                      }}
                      aria-pressed={chairToken === o.token}
                      className={`rounded-full px-4 py-2.5 text-sm ring-1 transition-all ${
                        chairToken === o.token ? "bg-red text-white ring-red" : "bg-white text-ink ring-black/[0.06] hover:ring-red/40"
                      }`}
                    >
                      <span className="font-semibold">{named(o.label)}</span>
                      <span className={chairToken === o.token ? "text-white/70" : "text-ink/45"}>
                        {" · "}
                        {s.freeForShort.replace("{n}", String(o.freeMin))}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {chair && (
              <div className="mt-6">
                <p className="mb-3 text-[12px] text-ink/45">{s.onlyFitting}</p>
                <GuestPicker catalog={fitting} value={guest} onChange={setGuest} />
                <p className="mt-4 text-[12px] text-ink/45">
                  {stay ? s.confirmWithTech : s.confirmAtTable.replace("{table}", named(chair.label))}
                </p>
              </div>
            )}
          </section>
        )}
      </div>

      {/* One bar, one button, whichever tab: what she has picked and its total. */}
      {((tab === "now" && inService && !checkout && basket.length > 0) || (tab === "next" && chair && guest.service !== null)) && (
        <div
          data-pay-bar
          className="fixed inset-x-0 bottom-0 z-40 border-t border-black/[0.06] bg-white/95 px-4 pt-3 backdrop-blur"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
        >
          <div className="mx-auto flex max-w-[620px] items-center justify-between gap-3">
            <div className="min-w-0">
              {tab === "now" ? (
                <p className="text-[13px] text-ink/60">{s.selected.replace("{n}", String(basket.length))}</p>
              ) : (
                <p className={`truncate text-[13px] ${tooLong ? "text-red" : "text-ink/60"}`}>
                  {tooLong
                    ? s.nextTooLong.replace("{n}", String(totals.durationMin)).replace("{m}", String(chair!.freeMin))
                    : `${totals.durationMin} ${s.minutes} · ${timeLabel}`}
                </p>
              )}
              <p className="flex items-center gap-1 font-display text-xl font-extrabold text-red">
                <Riyal className="h-4 w-4" />
                {tab === "now" ? basketTotal : totals.price}
              </p>
            </div>
            <button
              type="button"
              onClick={tab === "now" ? () => void pay() : proceed}
              disabled={tab === "now" ? busy : tooLong}
              className="shrink-0 rounded-full bg-red-grad px-6 py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {tab === "now" ? (busy ? p.confirming : s.pay) : s.proceed}
            </button>
          </div>
        </div>
      )}

      <SiteFooter />
      {checkingPayment && <CheckingModal />}
      {bought && !checkingPayment && <PaidModal items={bought} onClose={() => setBought(null)} />}
      {noticeOpen && notice && !checkingPayment && (
        <PayNoticeModal message={notice} retry={checkout !== null} onClose={() => setNoticeOpen(false)} />
      )}
    </main>
  );
}

/** "Added to your visit": what she just paid for, in front of the page. */
function PaidModal({ items, onClose }: { items: NowItem[]; onClose: () => void }) {
  const { c, lang } = useI18n();
  const s = c.station;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const total = items.reduce((n, i) => n + i.price, 0);
  const extra = items.reduce((n, i) => n + i.durationMin, 0);

  return (
    <div role="presentation" onClick={onClose} className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="paid-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-[24px] bg-white p-7 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]"
      >
        <span aria-hidden className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-[#2f7d4f] text-2xl font-bold text-white">
          ✓
        </span>
        <h3 id="paid-title" className="font-display text-xl font-extrabold text-ink">
          {s.paidDone}
        </h3>
        <ul className="mt-5 divide-y divide-black/[0.06] rounded-[16px] bg-cream px-4 text-start">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 py-3 text-sm">
              <span className="font-semibold text-ink">
                {pick(i.name, lang)}
                {i.durationMin > 0 && <span className="ms-1 text-[12px] font-normal text-ink/50">{s.extraMin.replace("{n}", String(i.durationMin))}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-ink/70">
                <Riyal className="h-3 w-3" />
                {i.price}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 flex items-center justify-center gap-1 font-display text-lg font-extrabold text-red">
          {c.payment.total}: <Riyal className="h-4 w-4" />
          {total}
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink/60">{extra > 0 ? s.paidNoteAddons : s.paidNote}</p>
        <p className="mt-1 text-[12px] text-ink/45">{s.paidEmail}</p>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="mt-6 w-full rounded-[12px] bg-red-grad py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          {c.payment.close}
        </button>
      </div>
    </div>
  );
}
