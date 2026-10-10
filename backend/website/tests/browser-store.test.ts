import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browserStoreUrl, desktopBrowser, installIconBrowser } from '../src/lib/browser-store';
import { site } from '../src/data/site';

const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('install icon recognizes the three browsers and defaults everything else to Chrome', () => {
  for (const [ua, browser] of [[chrome, 'chrome'], [chrome + ' Edg/140.0', 'edge'], ['Firefox/143.0', 'firefox'], ['Android EdgA/140.0', 'edge'], ['iPhone FxiOS/143.0', 'firefox'], ['Safari/605.1', 'chrome'], [chrome + ' OPR/120.0', 'chrome'], ['', 'chrome']] as const)
    assert.equal(installIconBrowser({ userAgent: ua }), browser);
  assert.equal(installIconBrowser({ userAgent: chrome, userAgentData: { brands: [{ brand: 'Microsoft Edge' }] } }), 'edge');
});

test('desktop installation goes to the configured browser store, with Edge before Chrome', () => {
  for (const [userAgent, browser] of [
    [chrome, 'chrome'],
    [chrome + ' Edg/140.0.0.0', 'edge'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0', 'firefox'],
  ] as const) {
    assert.equal(desktopBrowser({ userAgent }), browser);
    assert.equal(browserStoreUrl({ userAgent }, site.stores), site.stores[browser]);
  }
  assert.equal(desktopBrowser({ userAgent: chrome, userAgentData: { brands: [{ brand: 'Microsoft Edge' }] } }), 'edge');
  assert.equal(desktopBrowser({ userAgent: chrome, userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }] } }), 'chrome');
});

test('installation delegation leaves React hydration intact and handles late context menus', () => {
  const source = readFileSync(new URL('../src/layouts/Base.astro', import.meta.url), 'utf8');
  assert.ok(source.includes("if (!link.closest('astro-island')) update(link)"));
  for (const event of ['click', 'auxclick', 'contextmenu'])
    assert.ok(source.includes(`document.addEventListener('${event}', onInstall, true)`), event);
});

test('mobile, unknown and unsupported browsers keep the download chooser', () => {
  for (const identity of [
    { userAgent: 'Mozilla/5.0 Version/18.0 Safari/605.1.15' },
    { userAgent: chrome + ' OPR/120.0' },
    { userAgent: chrome + ' Vivaldi/7.0' },
    { userAgent: chrome + ' Electron/38.0.0' },
    { userAgent: chrome.replace('Chrome/', 'HeadlessChrome/') },
    { userAgent: chrome, userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Unknown Browser' }] } },
    { userAgent: chrome.replace('Windows NT 10.0; Win64; x64', 'Linux; Android 15') },
    { userAgent: chrome, userAgentData: { mobile: true } },
    { userAgent: 'Mozilla/5.0 (iPhone) CriOS/140.0 Mobile Safari/604.1' },
    { userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 },
    { userAgent: '' },
  ]) assert.equal(browserStoreUrl(identity, site.stores), undefined);
  assert.equal(browserStoreUrl({ userAgent: chrome }, { ...site.stores, chrome: '' }), undefined);
});
