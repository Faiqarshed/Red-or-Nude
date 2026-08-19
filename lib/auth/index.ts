// Node-runtime Auth.js setup: credentials provider backed by the staff table.

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare, hash as bcryptHash } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { staff } from "@/lib/db/schema";
import { authConfig } from "./config";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/**
 * Does this match the owner credentials in the environment?
 *
 * `SEED_OWNER_PASSWORD` is the source of truth for the owner's password: change
 * it in the environment and the next sign-in adopts it. Without this, the seed
 * hashes a password exactly once and editing the variable afterwards silently
 * does nothing — which is precisely how an owner ends up locked out of their own
 * panel holding what they believe are the right credentials.
 *
 * Both variables must be set and the password must be long enough. That guard
 * is not decoration: without it an unset variable would make the empty string a
 * valid owner password on every deployment.
 */
function matchesEnvOwner(email: string, password: string): boolean {
  const envEmail = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.SEED_OWNER_PASSWORD;

  if (!envEmail || !envPassword || envPassword.length < 8) return false;
  if (email.trim().toLowerCase() !== envEmail) return false;

  // Constant-time, so the password cannot be narrowed by timing the response.
  const a = Buffer.from(password);
  const b = Buffer.from(envPassword);
  return a.length === b.length && timingSafeEqual(Uint8Array.from(a), Uint8Array.from(b));
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        // Auth.js turns *anything* that goes wrong in here — a thrown error as
        // much as a returned null — into the same opaque `CredentialsSignin`.
        // So an unreachable database looks exactly like a mistyped password,
        // which is unhelpful in production. Catch and log the real reason; the
        // caller still only learns "those credentials didn't work".
        let member: typeof staff.$inferSelect | undefined;
        try {
          [member] = await db
            .select()
            .from(staff)
            .where(eq(staff.email, email.toLowerCase().trim()))
            .limit(1);
        } catch (err) {
          console.error("[auth] could not read the staff table — check DATABASE_URL:", err);
          return null;
        }

        // Compare even when the account is missing or has no password, so a
        // wrong email and a wrong password take the same time to fail.
        const hash = member?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
        const ok = await compare(password, hash);

        if (!member || !member.passwordHash || !member.active || !ok) {
          // The stored hash didn't match (or there is no row yet). Fall back to
          // the owner credentials in the environment, and bring the staff row
          // into line with them.
          //
          // The row is still what the rest of the panel runs on — id, role,
          // branch scoping and the audit log's foreign key all point at it — so
          // this syncs that row rather than signing in a user who exists only in
          // an environment variable and would break every audited action.
          if (!matchesEnvOwner(email, password)) return null;

          try {
            const passwordHash = await bcryptHash(password, 10);
            const [synced] = await db
              .insert(staff)
              .values({
                email: email.toLowerCase().trim(),
                name: member?.name ?? "Owner",
                role: "owner",
                passwordHash,
                active: true,
              })
              .onConflictDoUpdate({
                target: staff.email,
                set: { passwordHash, active: true, updatedAt: new Date() },
              })
              .returning();

            console.warn(`[auth] owner password synced from SEED_OWNER_PASSWORD for ${synced.email}`);
            member = synced;
          } catch (err) {
            console.error("[auth] could not sync the owner account from the environment:", err);
            return null;
          }
        }

        // Bookkeeping, not authentication. A failure here must not turn a valid
        // login into a rejected one.
        try {
          await db
            .update(staff)
            .set({ lastLoginAt: new Date() })
            .where(eq(staff.id, member.id));
        } catch (err) {
          console.error("[auth] signed in but could not record lastLoginAt:", err);
        }

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
