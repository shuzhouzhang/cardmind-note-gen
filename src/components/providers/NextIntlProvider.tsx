'use client';

import { NextIntlClientProvider } from 'next-intl';
import type { AbstractIntlMessages } from 'next-intl';
import { Children, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LOCALE,
  LANGUAGE_STORAGE_KEY,
  loadMessagesWithFallback,
  normalizeLocale,
  type SupportedLocale,
} from '@/i18n/config';

export function NextIntlProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<AbstractIntlMessages | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>(DEFAULT_LOCALE);
  const keyedChildren = useMemo(() => Children.toArray(children), [children]);

  useEffect(() => {
    const savedLocale = normalizeLocale(localStorage.getItem(LANGUAGE_STORAGE_KEY));
    setLocale(savedLocale);

    loadMessagesWithFallback(savedLocale).then((loadedMessages) => {
      setMessages(loadedMessages);
    }).catch((error) => {
      console.error(`Failed to load messages for locale: ${savedLocale}`, error);

      if (savedLocale !== DEFAULT_LOCALE) {
        setLocale(DEFAULT_LOCALE);
        void loadMessagesWithFallback(DEFAULT_LOCALE).then(setMessages);
      }
    });
  }, []);

  if (!messages) {
    return null;
  }

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {keyedChildren}
    </NextIntlClientProvider>
  );
}
