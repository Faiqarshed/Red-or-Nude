// Node-runtime Auth.js setup: credentials provider backed by the staff table.

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { staff } from "@/lib/db/schema";
import { authConfig } from "./config";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        // A throw here surfaces as a generic "could not sign in" with no clue
        // why, so name the failure explicitly in the log. This is the single
        // most likely thing to break on a fresh deploy: DATABASE_URL missing,
        // or pointing at the IPv6-only direct host instead of the pooler.
        let member;
        try {
          [member] = await db
            .select()
            .from(staff)
            .where(eq(staff.email, email.toLowerCase().trim()))
            .limit(1);
        } catch (err) {
          console.error("[auth] database unreachable during sign-in:", err);
          throw err;
        }

        // Compare even when the account is missing or has no password, so a
        // wrong email and a wrong password take the same time to fail.
        const hash = member?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
        const ok = await compare(password, hash);

        if (!member || !member.passwordHash || !member.active || !ok) return null;

        await db
          .update(staff)
          .set({ lastLoginAt: new Date() })
          .where(eq(staff.id, member.id));

        return {
          id: member.id,
          name: member.name,
          email: member.email,
          role: member.role,
          branchId: member.branchId,
        };
      },
    }),
  ],
});
