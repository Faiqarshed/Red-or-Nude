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
      return { error: err.type === "CredentialsSignin" ? "invalid" : "error" };
    }
    throw err;
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/admin/login" });
}
