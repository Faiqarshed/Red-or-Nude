// Edge-safe half of the Auth.js config. No database, no bcrypt — middleware runs
// on the edge runtime and can't load either. The Credentials provider lives in
// lib/auth/index.ts, which is Node-only.

import type { NextAuthConfig } from "next-auth";
import type { StaffRole } from "@/lib/db/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: StaffRole;
      branchId: string | null;
    };
  }
}

/**
 * What we put on the JWT. Not declared via module augmentation of
 * "next-auth/jwt" — that subpath's types don't resolve under bundler resolution
 * in this setup. Auth.js's JWT already carries an index signature, so writing
 * these keys is fine; reading them back goes through this type.
 */
type StaffToken = {
  id?: string;
  role?: StaffRole;
  branchId?: string | null;
};

export const authConfig = {
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 }, // a shift, not a month
  pages: { signIn: "/admin/login", error: "/admin/login" },
  callbacks: {
    jwt({ token, user }) {
      // `user` is only present on the sign-in pass; afterwards the token is
      // whatever we wrote here, so these keys are always set on a valid session.
      if (user) {
        const member = user as { id?: string; role: StaffRole; branchId: string | null };
        token.id = member.id;
        token.role = member.role;
        token.branchId = member.branchId;
      }
      return token;
    },
    session({ session, token }) {
      const claims = token as StaffToken;
      if (session.user && claims.id && claims.role) {
        session.user.id = claims.id;
        session.user.role = claims.role;
        session.user.branchId = claims.branchId ?? null;
      }
      return session;
    },
    /**
     * Gate for middleware. This is a coarse "is signed in" check only —
     * capability checks happen server-side in each action (lib/auth/guard.ts).
     * Middleware alone is not an authorization boundary: CVE-2025-29927 was
     * exactly that mistake, which is why next is pinned to a patched 14.2.x.
     */
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      if (!pathname.startsWith("/admin")) return true;
      if (pathname === "/admin/login") return true;
      return !!auth?.user;
    },
  },
  providers: [], // filled in by lib/auth/index.ts
} satisfies NextAuthConfig;
