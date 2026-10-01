import extensionReleases from '../../../extension-release.json';
const extensionPackages = Object.fromEntries((['chrome', 'edge', 'firefox'] as const).map(browser => {
  const release = extensionReleases.releases.find(item => item.version === extensionReleases.current_by_browser[browser] && item.browser === browser);
  if (!release) throw new Error('Missing current extension package: ' + browser);
  if (release.download_url) {
    const url = new URL(release.download_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Extension downloads require a permanent public HTTPS URL: ' + browser);
    }
  }
  return [browser, release];
}));
// Public, build-time configuration only. Never put credentials in this project.
export const site = {
  name: 'NodeLane Comics',
  url: 'https://comics.nodelane.net',
  email: 'comics@nodelane.net',
  github: 'https://github.com/Wy2926/node-comics',
  youtube: 'https://www.youtube.com/@NodeLaneNet',
  tutorialVideos: [
    { url: 'https://www.youtube.com/watch?v=miDawIO4Xxw', duration: '3:09' },
    { url: 'https://www.youtube.com/watch?v=pTQOBORnptY', duration: '3:12' },
  ],
  language: 'zh-CN',
  updated: '2026-09-29',
  extensionPackages,
  // Only verified listing URLs. Edge is awaiting store review; offer its package instead.
  stores: {
    chrome: 'https://chromewebstore.google.com/detail/aiajdjliifeeaogpalejpggkiccjbneo',
    edge: '',
    firefox: 'https://addons.mozilla.org/firefox/addon/nodelane-comics/',
  },
} as const;

export const browserStores = [
  { id: 'chrome', name: 'Google Chrome', label: 'Chrome Web Store', icon: '/browsers/chrome.svg', url: site.stores.chrome },
  { id: 'edge', name: 'Microsoft Edge', label: 'Edge Add-ons', icon: '/browsers/edge.png', url: site.stores.edge },
  { id: 'firefox', name: 'Mozilla Firefox', label: 'Firefox Add-ons', icon: '/browsers/firefox.svg', url: site.stores.firefox },
] as const;

export const absolute = (path: string) => new URL(path, site.url).href;
