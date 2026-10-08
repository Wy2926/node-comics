// Browser setup routes, not standalone mobile application downloads.
export const mobilePlatforms = [
  { id: 'android', name: 'Android', browser: 'Firefox', icon: '/browsers/android.svg', slug: 'android-firefox', browserUrl: 'https://www.firefox.com/browsers/mobile/android/', sourceUrl: 'https://support.mozilla.org/en-US/kb/find-and-install-add-ons-firefox-android' },
  { id: 'ios', name: 'iOS', browser: 'Orion', icon: '/browsers/apple.svg', slug: 'ios-orion', browserUrl: 'https://help.kagi.com/orion/getting-started/installing-orion.html', sourceUrl: 'https://help.kagi.com/orion/browser-extensions/ios-ipados-extensions.html' },
] as const;

export type MobilePlatform = typeof mobilePlatforms[number]['id'];
