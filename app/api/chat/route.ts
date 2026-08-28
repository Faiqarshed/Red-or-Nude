// The site chat assistant.
//
// Scope is deliberately narrow: FAQs, services, branch hours, and — for a
// signed-in customer — their own bookings. Two different mechanisms hold that
// line, and only one of them is the prompt:
//
//   • What it TALKS about is the system instruction plus knowledgeBlock(). That
//     is an instruction, not a fence. Someone determined can talk a model off
//     topic, and for a salon FAQ bot that is a nuisance, not a breach.
//
//   • What it can DO is the tool list, and that is a real fence. There is no
//     cancel, reschedule, refill or booking tool — not because the prompt
//     forbids it, but because no such function is declared. A model cannot be
//     argued into calling something that does not exist, so "always send them
//     to the website" is enforced by absence rather than by good behaviour.
//
// There are two read tools and the cookie picks between them, server-side.
//
// For a signed-in customer the tool takes no arguments at all: the customer id
// comes from the session, which the model never sees and has no parameter to
// supply, so no conversation can reach another customer's bookings.
//
// For a guest it takes a reference, and returns exactly what typing that
// reference into /my-bookings returns — no more. That does make this a second
// door onto the same reference space, so it carries its own throttle below;
// the exposure is the website's existing one, not a new one.
//
// PRIVACY: the free Gemini tier is in use, and Google's terms say free-tier
// prompts and responses are used to improve their products and may be read by
// human reviewers. The knowledge block is salon-authored, but the transcript is
// whatever a customer types. That is a deliberate, recorded choice; moving to
// the paid tier is a billing switch on the same key, not a code change.
//
// Non-streaming on purpose: answers are capped at ~1024 tokens and land in a
// second or two. generateContentStream behind a ReadableStream is the upgrade
// for when that pause starts to matter.

import { NextResponse } from "next/server";
import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Content,
  type FunctionDeclaration,
} from "@google/genai";
import { z } from "zod";
import { currentCustomer } from "@/lib/account/guard";
import { bookingSummaries } from "@/lib/bookings";
import { knowledgeBlock } from "@/lib/chat/knowledge";
import { clientIp, throttled } from "@/lib/throttle";

export const dynamic = "force-dynamic";

/**
 * Pinned, never an alias like `gemini-flash-latest`: a floating pointer can
 * change the model's behaviour without a deploy, and this one quotes prices.
 *
 * Flash-Lite is the right tier twice over. Reading four facts out of a block of
 * text is the easiest thing a model does, and free-tier quota is granted per
 * model — the heavier Flash models are capped low enough that two customers
 * chatting at once exhaust them, which is a worse failure than a slightly less
 * eloquent answer. Measured, not assumed: gemini-3.6-flash refused at five
 * requests a minute.
 *
 * Note gemini-2.5-flash is closed to new API keys; Google's 404 says so.
 */
const MODEL = "gemini-3.1-flash-lite";

/** One tool call is the honest maximum; two is the seatbelt. */
const MAX_TOOL_ROUNDS = 2;

const body = z.object({
  lang: z.enum(["ar", "en"]),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "model"]),
        text: z.string().trim().min(1).max(1000),
      }),
    )
    .min(1)
    .max(20),
});

const MY_BOOKINGS: FunctionDeclaration = {
  name: "my_bookings",
  description:
    "The signed-in customer's own bookings — date, service, status, total, and whether a " +
    "refill is on offer. Takes no arguments; the customer is identified by their session.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const BOOKING_BY_REFERENCE: FunctionDeclaration = {
  name: "booking_by_reference",
  description:
    "One booking, looked up by the reference from its confirmation email (e.g. RON-4F2K). " +
    "Use only a reference the customer typed in this conversation; never invent or guess one.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      reference: { type: Type.STRING, description: "The booking reference the customer gave." },
    },
    required: ["reference"],
  },
};

/** Same bounds the other public routes hold a reference to. */
const reference = z.string().trim().min(4).max(20);

function rules(lang: "ar" | "en", signedIn: boolean): string {
  return [
    "You are the assistant on the Red Or Nude salon website.",
    "",
    "Answer ONLY from the information below, plus the my_bookings tool if you have it.",
    "In scope: the FAQs, the services with their prices and durations, and the branches",
    "with their addresses, phone numbers and opening hours.",
    "",
    "Anything else — beauty or medical advice, complaints, comparisons with other salons,",
    "general conversation — decline in one sentence and give the branch phone number.",
    "",
    "Never invent a price, a duration, an address or a policy. If the answer is not below,",
    "say you do not have it and offer the branch phone number.",
    "",
    "You CANNOT book, cancel, reschedule or claim a refill, and must never say or imply that",
    "you have done any of them. Send the customer to the website instead:",
    signedIn
      ? "their bookings and those actions are at /account."
      : "an existing booking is managed at /my-bookings with the reference from the confirmation email, and a new booking is made at /booking.",
    signedIn
      ? ""
      : "You CAN look a booking up if they give you its reference — ask for it, then use booking_by_reference. You still cannot change it.",
    "",
    `Reply in ${lang === "ar" ? "Arabic" : "English"}. Keep answers to a few sentences.`,
    "",
    "--- What you know ---",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function POST(request: Request) {
  // An unmetered model endpoint is a billing problem before it is an abuse
  // problem: every message costs money, and a public text box invites volume.
  //
  // Per IP, so it does not protect the project-wide quota upstream — the free
  // tier's few-per-minute ceiling is shared by every visitor at once, and only
  // a paid tier or a queue would fix that. This stops one person hogging it;
  // the catch below handles the day everyone else does.
  if (throttled(`chat:${clientIp(request)}`, { max: 10 })) {
    return NextResponse.json({ error: "too-many" }, { status: 429 });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    // Degrade the way lib/notify does: say so, log it, never crash a page.
    console.error("[chat] GEMINI_API_KEY is not set — the assistant is disabled");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { lang, messages } = parsed.data;

  // The whole of the identity decision, and the only place it is made. Not a
  // field in the request, and not something the conversation can assert.
  const customer = await currentCustomer();

  const config = {
    systemInstruction: `${rules(lang, Boolean(customer))}\n\n${await knowledgeBlock(lang)}`,
    maxOutputTokens: 1024,
    // Low but not zero: these are lookups, not writing.
    temperature: 0.2,
    // Reading four facts out of a block of text needs no deliberation, and
    // thinking is latency and tokens the customer waits through. Note this is
    // `thinkingLevel`, not the 2.x `thinkingBudget` — passing that to a 3.x
    // model is rejected as an invalid argument, with no hint as to which one.
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    // Which tool exists is decided here, from the cookie — never from anything
    // the conversation said about who is asking.
    tools: [{ functionDeclarations: [customer ? MY_BOOKINGS : BOOKING_BY_REFERENCE] }],
  };

  const contents: Content[] = messages.map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const ai = new GoogleGenAI({ apiKey });

  try {
    let response = await ai.models.generateContent({ model: MODEL, contents, config });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const calls = response.functionCalls;
      if (!calls?.length) break;

      const turn = response.candidates?.[0]?.content;
      if (turn) contents.push(turn);

      contents.push({
        role: "user",
        parts: await Promise.all(
          calls.map(async (call) => ({
            functionResponse: {
              id: call.id,
              name: call.name ?? MY_BOOKINGS.name,
              response: await runTool(call.name, call.args, customer, request),
            },
          })),
        ),
      });

      response = await ai.models.generateContent({ model: MODEL, contents, config });
    }

    return NextResponse.json({ text: response.text ?? "" });
  } catch (err) {
    console.error("[chat] generation failed:", err);
    // Google's own quota, not ours. Worth telling apart: the free tier allows
    // only a handful of requests per minute *for the whole project*, so two
    // customers typing at once is enough to hit it — and "wait a minute" is
    // true and actionable where "something went wrong" would send them to the
    // phone for a problem that fixes itself.
    const status = (err as { status?: number })?.status === 429 ? 429 : 502;
    return NextResponse.json({ error: status === 429 ? "too-many" : "failed" }, { status });
  }
}

/**
 * Run a tool call. Arguments from the model are ignored entirely — the only
 * tool takes none, and the customer comes from the cookie.
 *
 * A refusal is handed back to the *model* rather than thrown, so the assistant
 * can say "I can't look that up right now" instead of the widget showing an
 * error where an answer should be.
 */
async function runTool(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  customer: { id: string } | null,
  request: Request,
): Promise<Record<string, unknown>> {
  // Its own budget, separate from the message throttle: one message can provoke
  // several calls, and without this the reference path would be a code-guessing
  // oracle sitting behind a chat box.
  if (throttled(`chat-tool:${clientIp(request)}`, { max: 5 })) return { error: "too-many" };

  if (customer && name === MY_BOOKINGS.name) {
    // `args` is ignored entirely — the declaration has no parameters, and the
    // identity comes from the cookie.
    //
    // Newest first, and only a handful: fifty bookings is a lot of prompt to
    // pay for, and nobody asks about their appointment from two years ago.
    return { bookings: (await bookingSummaries({ customerId: customer.id })).slice(0, 5) };
  }

  if (!customer && name === BOOKING_BY_REFERENCE.name) {
    const parsed = reference.safeParse(args?.reference);
    // A model that invented a reference gets the same nothing a wrong one does.
    if (!parsed.success) return { bookings: [] };
    return { bookings: await bookingSummaries({ code: parsed.data.toUpperCase() }) };
  }

  return { error: "unavailable" };
}
