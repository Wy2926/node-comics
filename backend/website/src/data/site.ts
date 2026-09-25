import extensionReleases from '../../../extension-release.json';
const extensionPackages = Object.fromEntries(['chrome', 'edge'].map(browser => {
  const release = extensionReleases.releases.find(item => item.version === extensionReleases.current && item.browser === browser);
  if (!release) throw new Error('Missing current extension package: ' + browser);
  return [browser, release];
}));
// Public, build-time configuration only. Never put credentials in this project.
export const site = {
  name: 'NodeLane Comics',
  url: 'https://comics.nodelane.net',
  email: 'comics@nodelane.net',
  language: 'zh-CN',
  updated: '2026-09-20',
  extensionPackages,
  // Fill with the exact listing URLs; empty values render accessible disabled buttons.
  stores: {
    chrome: 'https://chromewebstore.google.com/detail/aiajdjliifeeaogpalejpggkiccjbneo?utm_source=item-share-cb',
    edge: '',
    firefox: '',
  },
} as const;

export const absolute = (path: string) => new URL(path, site.url).href;
