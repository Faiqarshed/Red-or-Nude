"use client";

// The chat bubble, on every page of the public site.
//
// The conversation lives in this component's state and nowhere else — no
// database, no session id, no localStorage. Partly because nobody has asked to
// read transcripts, and partly for the reason MyBookingsView refuses to
// remember a reference: this site is opened on shared and public browsers, and
// a transcript can contain someone's appointment.
//
// The whole history is posted on every message because the API is stateless by
// design (see app/api/chat/route.ts). That is why the server caps the array at
// twenty and each message at a thousand characters rather than trusting this
// screen to behave.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

type Turn = { role: "user" | "model"; text: string };

/** `**bold**`, and the rest as it was written. */
function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

/**
 * The little the assistant is allowed to format: a heading, a bullet list, a
 * bold label, a paragraph. Everything else is text.
 *
 * Not a markdown library. The reply is a few sentences and a short list, and
 * `react-markdown` brings a whole parser toolchain to draw three shapes. The
 * prompt in app/api/chat/route.ts asks for exactly these three, so what the
 * model writes and what this draws stay one decision rather than two that drift
 * — and anything it writes anyway degrades to a plain line rather than to
 * literal asterisks in a customer's face.
 *
 * Built as elements, never `dangerouslySetInnerHTML`. The text is model output
 * and model output is data, on a page where a booking reference has just been
 * read out.
 */
function Formatted({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={out.length} className="list-outside list-disc space-y-1 ps-4">
        {bullets.map((b, i) => (
          <li key={i}>{inline(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of text.trim().split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }

    flush();
    // The site's own heading treatment, one step up from the 14px body — bold
    // alone at the same size and colour as the text under it does not read as a
    // heading at all. Nudged off whatever precedes it so two headed lists in one
    // reply read as two, not as one long run.
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <p
          key={out.length}
          className="pt-2 font-display text-base font-extrabold text-ink first:pt-0"
        >
          {inline(heading[1])}
        </p>,
      );
      continue;
    }

    if (line.trim()) out.push(<p key={out.length}>{inline(line)}</p>);
  }

  flush();
  return <>{out}</>;
}

export default function ChatWidget() {
  const { c, lang, dir } = useI18n();
  const t = c.chat;

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    // The server sees the same twenty-message window this keeps, so a long
    // conversation drops its oldest turns here rather than being rejected there.
    const next: Turn[] = [...turns, { role: "user" as const, text }].slice(-20);
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang, messages: next }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 429) setError(t.tooMany);
        else if (res.status === 503) setError(t.unavailable);
        else setError(t.failed);
        return;
      }
      setTurns((prev) => [...prev, { role: "model", text: String(data.text ?? "") }]);
    } catch {
      setError(t.failed);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 end-5 z-40 rounded-full bg-red-grad px-6 py-3.5 text-sm font-bold text-white shadow-[0_18px_40px_rgba(0,0,0,0.22)] transition-opacity hover:opacity-90"
      >
        {t.open}
      </button>
    );
  }

  return (
    <div
      dir={dir}
      className="fixed bottom-5 end-5 z-40 flex h-[min(560px,calc(100vh-2.5rem))] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-[20px] bg-white text-start shadow-[0_30px_80px_rgba(0,0,0,0.28)]"
    >
      <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-4">
        <h2 className="font-display text-base font-extrabold text-ink">{t.title}</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t.close}
          className="rounded-full px-2 text-lg leading-none text-ink/40 transition-colors hover:text-red"
        >
          ×
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {turns.length === 0 && (
          <>
            <p className="text-sm text-ink/55">{t.intro}</p>
            <p className="text-[11px] leading-relaxed text-ink/35">{t.disclaimer}</p>
          </>
        )}

        {turns.map((turn, i) =>
          turn.role === "user" ? (
            // Not formatted. A customer's own words are shown as typed — nobody
            // means a list when they open a line with a dash.
            <p
              key={i}
              className="ms-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-[14px] bg-red-grad px-4 py-2.5 text-sm text-white"
            >
              {turn.text}
            </p>
          ) : (
            <div
              key={i}
              className="w-fit max-w-[85%] space-y-2 rounded-[14px] bg-black/[0.04] px-4 py-2.5 text-sm leading-relaxed text-ink"
            >
              <Formatted text={turn.text} />
            </div>
          ),
        )}

        {busy && <p className="text-xs text-ink/40">{t.thinking}</p>}
        {error && (
          <p role="alert" className="rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex items-center gap-2 border-t border-black/[0.06] px-4 py-3"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 1000))}
          maxLength={1000}
          placeholder={t.placeholder}
          className="min-w-0 flex-1 rounded-[12px] border border-black/[0.08] px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className={`shrink-0 rounded-[12px] px-4 py-2.5 text-sm font-bold transition-opacity ${
            busy || !draft.trim()
              ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
              : "bg-red-grad text-white hover:opacity-90"
          }`}
        >
          {t.send}
        </button>
      </form>
    </div>
  );
}
