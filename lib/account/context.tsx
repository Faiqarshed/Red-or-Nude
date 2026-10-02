"use client";

// Who is signed in, for client components.
//
// The session lives in an httpOnly cookie, which is the point — JavaScript
// cannot read it, so an XSS bug cannot steal it. That also means SiteHeader,
// which is a client component rendered by ten different views (most of them
// client components too), has no way to ask on its own.
//
// So the server layout resolves it once and hands the answer down, the same
// shape LanguageProvider already uses in app/(site)/layout.tsx. It carries
// whether she is signed in and her wallet balance — never the session token,
// and nothing else that would be a problem sitting in her own page's source.
//
// Deliberately not a fetch to /api/account/me: that would flash the wrong
// button on every page load, on every page. The balance is here for the same
// reason: fetched by the header, it drew every page without the wallet pill
// and then pushed it in.

import { createContext, useContext, useEffect, useState } from "react";

type Account = {
  signedIn: boolean;
  /** Her wallet balance in halalas, null signed out. */
  walletHalalas: number | null;
  setWalletHalalas: (halalas: number) => void;
};

const AccountContext = createContext<Account>({ signedIn: false, walletHalalas: null, setWalletHalalas: () => {} });

export function AccountProvider({
  signedIn,
  walletHalalas,
  children,
}: {
  signedIn: boolean;
  walletHalalas: number | null;
  children: React.ReactNode;
}) {
  const [wallet, setWallet] = useState(walletHalalas);
  // A refresh re-renders the layout with a new figure (a cancel credits her).
  useEffect(() => setWallet(walletHalalas), [walletHalalas]);
  return (
    <AccountContext.Provider value={{ signedIn, walletHalalas: wallet, setWalletHalalas: setWallet }}>
      {children}
    </AccountContext.Provider>
  );
}

/** Whether someone is signed in. */
export function useAccount(): boolean {
  return useContext(AccountContext).signedIn;
}

/**
 * Her wallet balance as the header shows it, from the first paint, and its
 * setter: the header's own read of the wallet keeps it current, so the next
 * page's header starts from the newest figure too.
 */
export function useWalletHalalas(): [number | null, (halalas: number) => void] {
  const { walletHalalas, setWalletHalalas } = useContext(AccountContext);
  return [walletHalalas, setWalletHalalas];
}
