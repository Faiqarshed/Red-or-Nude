"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth";

export type LoginState = { error: "invalid" | "error" | null };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/admin",
    });
    return { error: null };
  } catch (err) {
    // A successful sign-in redirects by throwing NEXT_REDIRECT — that has to
    // propagate. Only genuine auth failures are turned into form state.
    if (err instanceof AuthError) {
      if (err.type === "CredentialsSignin") return { error: "invalid" };

      // Anything else is a server-side failure, not a bad password — most often
      // the database being unreachable from inside authorize(). The user gets a
      // generic message; the real cause goes to the server log, where it is the
      // only way to tell a misconfigured DATABASE_URL from a genuine outage.
      console.error(
        "[auth] sign-in failed:",
        err.type,
        err.cause ?? err.message,
      );
      return { error: "error" };
    }
    throw err;
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/admin/login" });
}
