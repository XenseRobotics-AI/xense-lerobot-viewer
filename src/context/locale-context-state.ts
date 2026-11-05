"use client";

import { createContext, type ReactNode } from "react";
import type { Locale } from "@/i18n/config";
import type { InterpolationVars } from "@/i18n/format";
import type { MessageKey } from "@/i18n/messages";

/** Base names of the locale dictionaries' plural key pairs. */
type PluralBaseOf<K> = K extends `${infer B}_one` ? B : never;
export type PluralBase = PluralBaseOf<MessageKey>;

export type LocaleContextType = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, vars?: InterpolationVars) => string;
  tp: (base: PluralBase, count: number, vars?: InterpolationVars) => string;
  tRich: (key: MessageKey, nodes: Record<string, ReactNode>) => ReactNode;
  tpRich: (
    base: PluralBase,
    count: number,
    nodes: Record<string, ReactNode>,
  ) => ReactNode;
};

// Keep identity outside the provider/hooks module: refreshing translations or
// provider code must not disconnect existing providers from refreshed consumers.
// Only type imports depend on i18n, so dictionary edits do not reload this module.
export const LocaleContext = createContext<LocaleContextType | undefined>(
  undefined,
);
