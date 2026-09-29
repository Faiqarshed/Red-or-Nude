"use client";

// Admin-side language context. Separate from the public site's LanguageProvider
// (lib/i18n.tsx) — the two never mount together, since /admin has its own root
// layout, so they can't fight over document.documentElement.dir.
//
// The language is a cookie the root layout reads, so the server renders the
// panel in it from the first byte, the way the site does (lib/i18n.tsx). It
// used to live in localStorage, which the server cannot see: every refresh
// painted Arabic first and flipped to English once the page's code ran.

import { createContext, useContext, useEffect, useState } from "react";
import { ADMIN_LANG_COOKIE } from "@/lib/localized";
import { adminStrings, type AdminLang, type AdminStrings } from "./strings";

type Ctx = {
  lang: AdminLang;
  dir: "rtl" | "ltr";
  t: AdminStrings;
  setLang: (l: AdminLang) => void;
  toggle: () => void;
};

const AdminLangContext = createContext<Ctx | null>(null);

function remember(l: AdminLang) {
  document.cookie = `${ADMIN_LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
}

export function AdminLangProvider({
  children,
  initialLang,
}: {
  children: React.ReactNode;
  /** From the cookie, via the root layout: the language the server rendered. */
  initialLang: AdminLang;
}) {
  const [lang, setLangState] = useState<AdminLang>(initialLang);

  // A choice made before the cookie existed lives only in localStorage (the
  // same key). Carried over once, into the cookie, so the next refresh
  // renders it on the server too.
  useEffect(() => {
    try {
      const old = localStorage.getItem(ADMIN_LANG_COOKIE);
      localStorage.removeItem(ADMIN_LANG_COOKIE);
      if ((old === "en" || old === "ar") && old !== initialLang) {
        remember(old);
        setLangState(old);
      }
    } catch {
      /* storage blocked — the cookie is all there is */
    }
  }, [initialLang]);

  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  const setLang = (l: AdminLang) => {
    setLangState(l);
    remember(l);
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
