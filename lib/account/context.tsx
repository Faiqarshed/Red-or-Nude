"use client";

// Who is signed in, for client components.
//
// The session lives in an httpOnly cookie, which is the point — JavaScript
// cannot read it, so an XSS bug cannot steal it. That also means SiteHeader,
// which is a client component rendered by ten different views (most of them
// client components too), has no way to ask on its own.
//
// So the server layout resolves it once and hands the answer down, the same
// shape LanguageProvider already uses in app/(site)/layout.tsx. It carries a
// single boolean — never the session token, and nothing else that would be a
// problem sitting in the page source.
//
// Deliberately not a fetch to /api/account/me: that would flash the wrong
// button on every page load, on every page.

import { createContext, useContext } from "react";

const AccountContext = createContext(false);

export function AccountProvider({
  signedIn,
  children,
}: {
  signedIn: boolean;
  children: React.ReactNode;
}) {
  return <AccountContext.Provider value={signedIn}>{children}</AccountContext.Provider>;
}

/** Whether someone is signed in. Nothing else — a header needs nothing else. */
export function useAccount(): boolean {
  return useContext(AccountContext);
}
