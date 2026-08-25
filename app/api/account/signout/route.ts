// Sign out — drop the cookie.
//
// POST and not GET on purpose: a GET would let any page on the internet sign a
// customer out with an <img src>. Harmless as attacks go, but it costs nothing
// to not have.
//
// The token is stateless, so there is nothing server-side to delete. A copy
// captured before this request would still decode until it expires; that is the
// trade for having no sessions table, and the answers to it are the same two
// that were always there — `customers.blocked` for one person, rotating
// AUTH_SECRET for everyone.

import { NextResponse } from "next/server";
import { ACCOUNT_COOKIE } from "@/lib/account/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ACCOUNT_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
