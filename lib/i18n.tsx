"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { content, type Content } from "./dictionary";

export type Lang = "ar" | "en";

type Ctx = {
  lang: Lang;
  dir: "rtl" | "ltr";
  setLang: (l: Lang) => void;
  toggle: () => void;
  c: Content;
};

const LanguageContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "ron-lang";

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Server + first client render default to Arabic (matches <html lang="ar">).
  const [lang, setLangState] = useState<Lang>("ar");

  // Adopt the persisted choice after mount. We never WRITE localStorage from an
  // effect — only from setLang below — so this read can't be clobbered by the
  // initial "ar" value (which also avoids a StrictMode double-invoke race).
  useEffect(() => {
    const saved = (typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY)) as Lang | null;
    if (saved === "en" || saved === "ar") setLangState(saved);
  }, []);

  // Keep <html> dir/lang in sync with the active language (no persistence here).
  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = lang === "ar" ? "rtl" : "ltr";
    el.classList.toggle("lang-en", lang === "en");
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  };

  const value: Ctx = {
    lang,
    dir: lang === "ar" ? "rtl" : "ltr",
    setLang,
    toggle: () => setLang(lang === "ar" ? "en" : "ar"),
    c: content[lang],
  };

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
  return ctx;
}
