import { getRequestConfig } from 'next-intl/server';
import { notFound } from 'next/navigation';

type SupportedLocale = 'en' | 'es' | 'pt';
const locales: SupportedLocale[] = ['en', 'es', 'pt'];

export default getRequestConfig(async ({ locale }: { locale?: string }) => {
  const activeLocale = locale ?? 'en';
  if (!locales.includes(activeLocale as SupportedLocale)) notFound();

  return {
    locale: activeLocale,
    messages: (await import(`../public/locales/${activeLocale}.json`)).default,
  };
});
