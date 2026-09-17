"use client";

// Admin-side language context. Separate from the public site's LanguageProvider
// (lib/i18n.tsx) — the two never mount together, since /admin has its own root
// layout, so they can't fight over document.documentElement.dir.
//
// Same rule as the site: localStorage is written only in setLang, never from an
// effect, so the mount-time read can't be clobbered by the initial "ar".

import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";
import { adminStrings, type AdminLang, type AdminStrings } from "./strings";

// The saved language has to be applied before the browser paints, or an English
// user watches the whole panel render in Arabic and then swap. It cannot be read
// during the initial render either — the server has no localStorage, so doing so
// would render one language on the server and another on the client and fail
// hydration. A layout effect is the one slot that is after hydration and before
// paint. On the server there is no paint to be before, so it falls back to
// useEffect purely to avoid React's "does nothing on the server" warning.
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Ctx = {
  lang: AdminLang;
  dir: "rtl" | "ltr";
  t: AdminStrings;
  setLang: (l: AdminLang) => void;
  toggle: () => void;
};

const AdminLangContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "ron-admin-lang";

export function AdminLangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<AdminLang>("ar");

  useBeforePaint(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* private mode, blocked site data — Arabic is the right default anyway */
    }
    if (saved === "en" || saved === "ar") setLangState(saved);
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  const setLang = (l: AdminLang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  };

  return (
    <AdminLangContext.Provider
      value={{
        lang,
        dir: lang === "ar" ? "rtl" : "ltr",
        t: adminStrings[lang],
        setLang,
        toggle: () => setLang(lang === "ar" ? "en" : "ar"),
      }}
    >
      {children}
    </AdminLangContext.Provider>
  );
}

export function useAdminI18n(): Ctx {
  const ctx = useContext(AdminLangContext);
  if (!ctx) throw new Error("useAdminI18n must be used within AdminLangProvider");
  return ctx;
}
