'use client';

import React, { ReactNode, useState } from 'react';

type Locale = 'en' | 'es' | 'pt';

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  messages: Record<string, unknown>;
}

const I18nContext = React.createContext<I18nContextType | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('en');
  const [messages, setMessages] = useState<Record<string, unknown>>({});

  const handleSetLocale = async (newLocale: Locale) => {
    setLocale(newLocale);
    try {
      const localeMessages = await import(`../public/locales/${newLocale}.json`);
      setMessages(localeMessages.default);
    } catch (error) {
      console.error(`Failed to load locale ${newLocale}:`, error);
    }
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale: handleSetLocale, messages }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = React.useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
}

export function useTranslations() {
  const { messages } = useI18n();
  
  return (key: string, defaultValue: string = key) => {
    const keys = key.split('.');
    let value: unknown = messages;
    
    for (const k of keys) {
      if (typeof value === 'object' && value !== null) {
        value = (value as Record<string, unknown>)[k];
      }
    }
    
    return typeof value === 'string' ? value : defaultValue;
  };
}
