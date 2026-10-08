import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dictionaries, locales, publicPaths, localPath } from '../src/i18n';
import { mobileCopy } from '../src/i18n/mobile';
import { mobilePlatforms } from '../src/data/mobile';
import { site } from '../src/data/site';
import { desktopBrowser, mobileGuidePath } from '../src/lib/browser-store';

test('mobile actions route to guides including iPad desktop user agents', () => {
  for (const [identity, path] of [
    [{ userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0' }, '/guides/android-firefox/'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile' }, '/guides/android-firefox/'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Mobile Safari/604.1' }, '/guides/ios-orion/'],
    [{ userAgent: 'Mozilla/5.0 (iPad) Mobile Safari/604.1' }, '/guides/ios-orion/'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }, '/guides/ios-orion/'],
  ] as const) {
    assert.equal(mobileGuidePath(identity), path);
    assert.equal(desktopBrowser(identity), undefined);
    for (const locale of locales) assert.ok(localPath(path, locale).endsWith(path));
  }
  assert.equal(mobileGuidePath({ userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 }), undefined);
  assert.equal(mobileGuidePath({ userAgent: '', userAgentData: { mobile: true } }), undefined);
});

test('all locales provide Android screenshots and an honest iOS compatibility status', () => {
  assert.deepEqual(Object.keys(mobileCopy).sort(), [...locales].sort());
  for (const locale of locales) {
    const copy = mobileCopy[locale];
    assert.equal(copy.steps.length, 3, locale);
    assert.ok(copy.iosStatus.trim());
    assert.ok(copy.steps.every(step => step.length === 2 && step.every(text => text.trim())), locale);
    const dictionary = dictionaries[locale];
    assert.equal(dictionary.ui.downloadDescription, copy.availability);
    assert.ok(dictionary.documents.faqs.find(faq => faq.id === 'browsers')?.answer.includes(copy.notices[1]));
    for (const platform of mobilePlatforms) {
      const guide = dictionary.documents.guides.find(guide => guide.slug === platform.slug)!;
      assert.ok(publicPaths.includes(`/guides/${guide.slug}/`));
      const screenshots = guide.sections.flatMap(section => section.screenshot ? [section.screenshot] : []);
      assert.equal(screenshots.length, platform.id === 'android' ? 3 : 0);
      if (platform.id === 'ios') {
        assert.ok(guide.title.includes(copy.iosStatus));
        assert.equal(guide.description, copy.notices[1]);
      } else assert.ok(guide.sections.some(section => section.paragraphs.includes(copy.screenshotNote)));
      screenshots.forEach((shot, i) => {
        assert.equal(shot.id, `${platform.id}-${i + 1}`);
        assert.equal(shot.label, copy.placeholder);
        const language = locale.startsWith('zh') ? 'zh-CN' : 'en';
        assert.equal(shot.src, `/guides/firefox/${language}/${['01-firefox-open', '02-add-extension', '03-read-sample'][i]}.png`);
        const png = readFileSync(new URL(`../public${shot.src}`, import.meta.url));
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.equal(png.readUInt32BE(16), 1080);
        assert.equal(png.readUInt32BE(20), 2400);
      });
      const links = guide.sections.flatMap(section => section.links ?? []);
      for (const url of platform.id === 'android' ? [platform.browserUrl, platform.sourceUrl, site.stores.firefox] : [platform.sourceUrl])
        assert.ok(links.some(link => link.href === url), `${locale}/${platform.id}: ${url}`);
      assert.ok(!links.some(link => /\.apk|\.ipa|\.zip|\.xpi/.test(link.href)));
    }
  }
});

test('mobile platform icons are local SVGs with distributed license', () => {
  for (const platform of mobilePlatforms) {
    const svg = readFileSync(new URL(`../public${platform.icon}`, import.meta.url), 'utf8');
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.doesNotMatch(svg, /<script|<foreignObject|href=/);
  }
  assert.match(readFileSync(new URL('../public/licenses/simple-icons.txt', import.meta.url), 'utf8'), /CC0 1.0 Universal/);
});
