import {getRequestConfig} from 'next-intl/server';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  loadMessagesWithFallback,
} from './config';

export const locales = SUPPORTED_LOCALES;
export const defaultLocale = DEFAULT_LOCALE;

export default getRequestConfig(async ({requestLocale}) => {
  const requestedLocale = await requestLocale;
  const locale = requestedLocale && isSupportedLocale(requestedLocale)
    ? requestedLocale
    : DEFAULT_LOCALE;

  return {
    locale,
    messages: await loadMessagesWithFallback(locale)
  };
});
