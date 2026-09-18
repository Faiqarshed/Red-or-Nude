"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { content, type Content } from "./dictionary";
import { LANG_COOKIE } from "./localized";

export type Lang = "ar" | "en";

type Ctx = {
  lang: Lang;
  dir: "rtl" | "ltr";
  setLang: (l: Lang) => void;
  toggle: () => void;
  c: Content;
};

const LanguageContext = createContext<Ctx | null>(null);


function remember(l: Lang) {
  document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
}

export function LanguageProvider({
  children,
  initialLang,
}: {
  children: React.ReactNode;
  /** From the cookie, via the layout — the same value the server rendered with. */
  initialLang: Lang;
}) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  // A choice made before the cookie existed lives only in localStorage. Carried
  // over once, into the cookie, so the next refresh renders it server-side too.
  useEffect(() => {
    try {
      const old = localStorage.getItem(LANG_COOKIE);
      localStorage.removeItem(LANG_COOKIE);
      if ((old === "en" || old === "ar") && old !== initialLang) {
        remember(old);
        setLangState(old);
      }
    } catch {
      /* storage blocked — the cookie is all there is */
    }
  }, [initialLang]);

  // Keep <html> dir/lang in sync with the active language (no persistence here).
  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = lang === "ar" ? "rtl" : "ltr";
    el.classList.toggle("lang-en", lang === "en");
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    remember(l);
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
