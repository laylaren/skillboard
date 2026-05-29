import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, createElement } from 'react';
import en from './messages.en.json';
import zh from './messages.zh.json';

export type Locale = 'zh' | 'en';

const MESSAGES: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  zh: zh as Record<string, string>,
};

const STORAGE_KEY = 'skillboard-locale';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  setLocale: () => {},
});

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  // Default to zh if the user's browser primary language starts with "zh".
  const navLang = window.navigator.language?.toLowerCase() ?? '';
  return navLang.startsWith('zh') ? 'zh' : 'en';
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale());

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, locale);
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    }
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale }), [locale]);
  return createElement(LocaleContext.Provider, { value }, children);
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/**
 * Substitute `{name}` placeholders in `template` with values from `vars`.
 * Missing keys fall through unchanged so the original template surfaces the bug
 * instead of silently dropping content.
 */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const { locale } = useLocale();
  // Memoize so the function ref is stable across renders within a locale.
  // Without this, every consumer's `useCallback([t])` becomes unstable, which
  // turns dependent useEffects into per-render fires.
  return useCallback(
    (key, vars) => {
      const table = MESSAGES[locale];
      const raw = table[key] ?? MESSAGES.en[key] ?? key;
      return interpolate(raw, vars);
    },
    [locale],
  );
}
