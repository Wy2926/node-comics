import { locales, type Locale } from '../i18n/locales';

export const homeSamples = {
  mono: { original: 'mono-original.png', sourceLocale: 'ja', widths: [480, 836] },
  color: { original: 'color-original.jpg', sourceLocale: 'zh-TW', widths: [480, 836, 1129] },
} satisfies Record<string, { original: string; sourceLocale: Locale; widths: number[] }>;

export type HomeSampleKind = keyof typeof homeSamples;

export function homeSampleLanguages(kind: HomeSampleKind): Locale[] {
  return locales.filter(locale => locale !== homeSamples[kind].sourceLocale);
}

export function homeSampleLanguage(kind: HomeSampleKind, preferred: Locale): Locale {
  return preferred === homeSamples[kind].sourceLocale ? 'en' : preferred;
}
