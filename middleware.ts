// Signed-in gate for /admin. Deliberately thin: it redirects anonymous visitors
// to the login page and nothing more. Authorization lives in lib/auth/guard.ts,
// called from every page and action — middleware is not a security boundary.

import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth/config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: ["/admin/:path*"],
};
