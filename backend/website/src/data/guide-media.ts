import type { ImageMetadata } from 'astro';
import type { Locale } from '../i18n/types';

export const screenshotLocales = ['zh-CN', 'en', 'ja', 'ko'] as const;
export type ScreenshotLocale = typeof screenshotLocales[number];
export const screenshotNames = ['library', 'reader-directory', 'reader-settings', 'translation-settings', 'channel-form', 'remote-library', 'search', 'search-results'] as const;
export type GuideImage = typeof screenshotNames[number];

const images = import.meta.glob<{ default: ImageMetadata }>('../assets/guides/*/*.webp', { eager: true });

export function screenshotLocale(locale: Locale): ScreenshotLocale {
  return locale.startsWith('zh') ? 'zh-CN' : locale === 'ja' || locale === 'ko' ? locale : 'en';
}

export function guideImage(name: GuideImage, locale: Locale): ImageMetadata {
  const key = `../assets/guides/${screenshotLocale(locale)}/${name}.webp`;
  const image = images[key]?.default;
  if (!image) throw new Error(`Missing tutorial screenshot: ${key}`);
  return image;
}

// Only substantial, actionable workflows lead the tutorial directory.
export const featuredGuides = ['manga-translation', 'local-comics', 'find-manga', 'remote-library', 'local-translation', 'android-firefox'];

export const guideCovers: Record<string, GuideImage> = {
  'manga-translation': 'translation-settings', 'local-comics': 'library', 'find-manga': 'search',
  'remote-library': 'remote-library', 'local-translation': 'channel-form',
};

export const guideImages: Record<string, Partial<Record<number, GuideImage>>> = {
  'manga-translation': { 0: 'library', 1: 'translation-settings', 3: 'reader-settings' },
  'local-comics': { 0: 'library', 1: 'reader-directory', 3: 'reader-settings' },
  'translation-modes': { 1: 'translation-settings', 2: 'channel-form', 3: 'reader-settings' },
  'remote-library': { 0: 'remote-library' },
  'local-translation': { 3: 'channel-form', 4: 'translation-settings' },
  'find-manga': { 0: 'search', 2: 'search-results' },
};
