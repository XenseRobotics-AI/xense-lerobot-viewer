"use client";

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DEFAULT_LOCALE,
  htmlLang,
  localeCookieValue,
  type Locale,
} from "@/i18n/config";
import { interpolate, pluralKey, type InterpolationVars } from "@/i18n/format";
import { richInterpolate } from "@/i18n/rich";
import { MESSAGES, type MessageKey } from "@/i18n/messages";
import {
  LocaleContext,
  type LocaleContextType,
  type PluralBase,
} from "./locale-context-state";
export type { PluralBase } from "./locale-context-state";

export const useLocale = () => {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within a LocaleProvider");
  return ctx;
};

/** Shorthand for the common case — only the translate function is needed. */
export const useT = () => useLocale().t;

export const LocaleProvider: React.FC<{
  /** Seeded from the cookie server-side, so the first paint is already right. */
  initialLocale?: Locale;
  children: React.ReactNode;
}> = ({ initialLocale = DEFAULT_LOCALE, children }) => {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // Keep the document in sync with the choice. The server already rendered the
  // right `lang`, so this only matters after an in-page switch — but it means
  // the switch needs no router round trip to be correct.
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    // State first: every translated string lives in a client component, so the
    // UI flips immediately. The cookie only has to survive until the next load.
    setLocaleState(next);
    try {
      document.cookie = localeCookieValue(next);
    } catch {
      // Cookies disabled — the choice still holds for this session.
    }
  }, []);

  const value = useMemo<LocaleContextType>(() => {
    const dict = MESSAGES[locale];
    const lookup = (key: MessageKey): string => dict[key] ?? key;
    const resolvePlural = (base: PluralBase, count: number): MessageKey =>
      pluralKey(base, count, locale) as MessageKey;

    const t = (key: MessageKey, vars?: InterpolationVars) =>
      interpolate(lookup(key), vars);

    const tRich = (key: MessageKey, nodes: Record<string, React.ReactNode>) =>
      richInterpolate(lookup(key), nodes);

    return {
      locale,
      setLocale,
      t,
      tp: (base, count, vars) =>
        t(resolvePlural(base, count), { count, ...vars }),
      tRich,
      tpRich: (base, count, nodes) =>
        tRich(resolvePlural(base, count), { count, ...nodes }),
    };
  }, [locale, setLocale]);

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
};
