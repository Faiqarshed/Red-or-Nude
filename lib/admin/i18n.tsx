"use client";

// Admin-side language context. Separate from the public site's LanguageProvider
// (lib/i18n.tsx) — the two never mount together, since /admin has its own root
// layout, so they can't fight over document.documentElement.dir.
//
// Same rule as the site: localStorage is written only in setLang, never from an
// effect, so the mount-time read can't be clobbered by the initial "ar".

import { createContext, useContext, useEffect, useState } from "react";
import { adminStrings, type AdminLang, type AdminStrings } from "./strings";

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

  useEffect(() => {
    const saved = (typeof window !== "undefined" &&
      localStorage.getItem(STORAGE_KEY)) as AdminLang | null;
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
