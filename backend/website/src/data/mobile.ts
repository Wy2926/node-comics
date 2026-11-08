import { appRelease } from './app';

// Preserve legacy mobile routes. Android remains the Firefox extension tutorial.
export const mobilePlatforms = [
  { id: 'android', name: 'Android', browser: 'Firefox', slug: 'android-firefox', browserUrl: 'https://www.firefox.com/browsers/mobile/android/', sourceUrl: 'https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android' },
  { id: 'ios', slug: appRelease.iosSlug, sourceUrl: appRelease.repository },
] as const;
