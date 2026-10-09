import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { load } from 'cheerio';
import { browserStores, site } from '../src/data/site';
import { mobilePlatforms } from '../src/data/mobile';
import { mobileCopy } from '../src/i18n/mobile';
import { publishedAmount } from '../src/components/PublishedPlanPricing';
import { comparisonRows } from '../src/lib/pricing-comparison';
import { publishedModels } from '../src/data/published-plans';
import { dictionaries, locales, localeFromPath, basePath, localPath, publicPaths } from '../src/i18n';
const root = resolve('dist');
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir,entry.name)]))).flat(); }
const errors: string[] = [];
const titles = new Set<string>();
const descriptions = new Set<string>();
const indexedRoutes = new Set<string>();
const homePreviews = new Map<string, string>();
const pages = new Map<string, ReturnType<typeof load>>();
const htmlFiles = (await files(root)).filter(path => path.endsWith('.html'));
for (const file of htmlFiles) pages.set(file, load(await readFile(file, 'utf8')));
for (const file of htmlFiles) {
  const html = await readFile(file,'utf8');
  const $ = load(html);
  const label = file.slice(root.length);
  if (/redraw|重[绘繪]|再描画|다시\s*그리|neuzeich|redessin|redibuj|redesenh|ridisegn|przerys|перерис|перемал|yeniden\s*çiz|gambar\s+ulang|vẽ\s+lại/iu.test(html)) errors.push(`${label}: retired image feature remains in rendered content or metadata`);
  if ($('h1').length !== 1) errors.push(`${label}: expected one h1`);
  const title = $('title').text();
  if (!title || titles.has(title)) errors.push(`${label}: missing/duplicate title`);
  titles.add(title);
  const description = $('meta[name=description]').attr('content') ?? '';
  if (!description.trim()) errors.push(`${label}: missing description`);
  const canonical = $('link[rel=canonical]').attr('href') ?? '';
  const noindex = $('meta[name=robots]').attr('content')?.includes('noindex');
  const fileRoute = '/' + relative(root, file).replaceAll('\\', '/').replace(/index\.html$/, '');
  // Astro renders the /404/ route into the special root 404.html output.
  const canonicalRoute = fileRoute === '/404.html' ? '/404/' : fileRoute;
  if ($('link[rel=canonical]').length !== 1 || canonical !== site.url + canonicalRoute) errors.push(`${label}: canonical must match its own static route`);
  const route = new URL(canonical || site.url).pathname;
  const locale = localeFromPath(route);
  if (!noindex || $('.site-header').length) {
    if ($('.header-download[data-install-extension]').attr('href') !== localPath('/download/', locale)) errors.push(`${label}: installation must retain a localized no-script fallback`);
    if ($('body').attr('data-install-stores') !== JSON.stringify(site.stores)) errors.push(`${label}: installation destinations must use the official store configuration`);
  }
  if ($('footer .directory-badges, footer .directory-track').length) errors.push(label + ': removed directory links remain');
  if ($('html').attr('dir') !== (locale === 'ar' ? 'rtl' : 'ltr')) errors.push(label + ': wrong text direction');
  if ($('html').attr('lang') !== locale) errors.push(`${label}: wrong language`);
  if (!noindex) {
    indexedRoutes.add(route);
    if (!publicPaths.includes(basePath(route))) errors.push(`${label}: unexpected indexed page`);
    if (descriptions.has(`${locale}:${description}`)) errors.push(`${label}: duplicate localized description`);
    descriptions.add(`${locale}:${description}`);
    for (const language of locales) if ($(`link[hreflang="${language}"]`).attr('href') !== site.url + localPath(basePath(route),language)) errors.push(`${label}: wrong hreflang ${language}`);
    if ($('link[hreflang="x-default"]').attr('href') !== site.url + basePath(route)) errors.push(`${label}: wrong default language`);
  }
  for (const [selector, expected] of [['meta[property="og:title"]', title], ['meta[name="twitter:title"]', title], ['meta[property="og:description"]', description], ['meta[name="twitter:description"]', description], ['meta[property="og:url"]', canonical]]) {
    if (!noindex && $(selector).attr('content') !== expected) errors.push(`${label}: inconsistent social metadata ${selector}`);
  }
  if (!noindex && !$('meta[property="og:image"]').attr('content')?.startsWith(site.url + '/')) errors.push(`${label}: missing absolute social image`);
  const ids = $('[id]').toArray().map(node => $(node).attr('id'));
  if (new Set(ids).size !== ids.length) errors.push(`${label}: duplicate HTML ids`);
  if (!noindex && $('script[type="application/ld+json"]').length !== 1) errors.push(`${label}: expected one JSON-LD graph`);
  $('script[type="application/ld+json"]').each((_,node) => {
    try {
      const { '@graph': graph } = JSON.parse($(node).html()!);
      const page = graph.find((entry: Record<string, unknown>) => entry['@id'] === canonical);
      if (page?.inLanguage !== locale || page?.description !== description) errors.push(`${label}: structured page does not match metadata`);
      const faq = graph.find((entry: Record<string, unknown>) => entry['@type'] === 'FAQPage');
      if (basePath(route) === '/faq/') {
        const items = dictionaries[locale].documents.faqs;
        if (faq?.mainEntity?.length !== items.length || $('.faq-item').length !== items.length) errors.push(`${label}: missing FAQ entries`);
        items.forEach((item, i) => {
          const rendered = $(`#${item.id}`);
          if (rendered.find('summary').text().trim() !== item.question || rendered.find('.faq-answer').text() !== item.answer
            || faq?.mainEntity?.[i]?.name !== item.question || faq?.mainEntity?.[i]?.acceptedAnswer?.text !== item.answer
            || faq?.mainEntity?.[i]?.['@id'] !== `${canonical}#${item.id}`) errors.push(`${label}: FAQ content/schema mismatch ${item.id}`);
        });
      } else if (faq) errors.push(`${label}: FAQ schema should describe the full FAQ page only`);
    } catch { errors.push(`${label}: invalid JSON-LD graph`); }
  });
  if (basePath(route) === '/') {
    const platformRows = $('.hero-stores > .hero-store-row');
    if (platformRows.length !== 2 || platformRows.eq(0).attr('data-platform-row') !== 'desktop'
      || platformRows.eq(0).find('[data-browser]').length !== 3
      || platformRows.eq(1).attr('data-platform-row') !== 'mobile'
      || platformRows.eq(1).find('[data-platform]').length !== 2)
      errors.push(`${label}: desktop browsers must be grouped above the mobile tutorials`);
    if ($('main input[type=file], main astro-island, .gallery-switches, .product-sources').length) errors.push(`${label}: homepage must keep a focused static extension journey`);
    if ($('.home-hero .button').length !== 1 || !$(`.home-hero a[data-install-extension][href="${localPath('/download/',locale)}"]`).length) errors.push(`${label}: homepage must have one primary installation action`);
    if (!$(`.home-service a[href="${localPath('/pricing/',locale)}"]`).length || $('.home-plan').length !== 3) errors.push(`${label}: missing Free/PLUS/Pro plan entrance`);
    $('.home-plan').each((index, card) => {
      const expected = index === 0 ? publishedModels.free : [...publishedModels.free, ...publishedModels.paid_extra];
      const models = $(card).find('[data-feature="model"] .home-model-list > bdi').toArray().map(item => $(item).text());
      if (JSON.stringify(models) !== JSON.stringify(expected)) errors.push(`${label}: homepage models must be complete and on separate lines`);
    });
    for (const store of browserStores) {
      const entrance = $(`.hero-store[data-browser="${store.id}"]`);
      const target = store.url || `${localPath('/download/', locale)}#${store.id}`;
      if (entrance.length !== 1 || entrance.attr('href') !== target) errors.push(`${label}: missing configured ${store.id} platform entrance`);
    }
    for (const platform of mobilePlatforms) {
      const entrance = $(`.hero-store[data-platform="${platform.id}"]`);
      if (entrance.length !== 1 || entrance.attr('href') !== localPath(`/guides/${platform.slug}/`, locale)
        || entrance.attr('download') !== undefined || entrance.attr('target') || !entrance.text().includes(platform.id === 'ios' ? mobileCopy[locale].iosStatus : mobileCopy[locale].label))
        errors.push(`${label}: mobile entrance must be a localized tutorial or compatibility status ${platform.id}`);
    }
    if ($('.home-faq, .home-cta, .home-steps').length || $('.home-cycle input[type=radio]').length !== 2) errors.push(`${label}: keep one focused hero and a static quarterly/yearly plan preview`);
    for (const feature of ['classic', 'model', 'rate', 'priority', 'reading']) {
      if ($(`.home-plan li[data-feature="${feature}"]`).length !== 3) errors.push(`${label}: homepage must compare ${feature}`);
    }
    if ($('.home-plan').first().find('.icon-check').length !== 1 || $('.home-plan-paid .icon-check').length !== 10 || $('.home-plan-paid li strong').length !== 8) errors.push(`${label}: homepage must distinguish shared benefits from Lite advantages`);
    if ($('.home-price .price-currency').length !== 5 || $('.home-cycle-picker .billing-cycle-saving .annual-badge').length !== 1) errors.push(`${label}: homepage needs separated currency typography and a stable annual discount slot`);
    const preview = $('.home-screenshot img').attr('src');
    if (!preview || $('.home-screenshot img').length !== 1 || !$('.home-screenshot img').attr('srcset')) errors.push(`${label}: expected one responsive real product screenshot`);
    else homePreviews.set(locale, preview);
  }
  const mobilePlatform = mobilePlatforms.find(platform => basePath(route) === `/guides/${platform.slug}/`);
  if (mobilePlatform) {
    const expected = mobilePlatform.id === 'android' ? 3 : 0;
    if ($('.guide-screenshot img').length !== expected || $('.screenshot-placeholder').length !== 0)
      errors.push(`${label}: incorrect Android screenshots or premature iOS screenshots`);
    $('.guide-screenshot img').each((index, element) => {
      const image = $(element);
      const language = locale.startsWith('zh') ? 'zh-CN' : 'en';
      const expectedSrc = `/guides/firefox/${language}/${['01-firefox-open', '02-add-extension', '03-read-sample'][index]}.png`;
      if (image.attr('src') !== expectedSrc || image.attr('width') !== '1080' || image.attr('height') !== '2400' || image.attr('loading') !== 'lazy')
        errors.push(`${label}: incorrect screenshot language, dimensions or loading`);
    });
    if (mobilePlatform.id === 'ios' && !$('h1').text().includes(mobileCopy[locale].iosStatus))
      errors.push(`${label}: missing iOS compatibility status`);
    if ($('.mobile-platform[aria-current=page]').length !== 1 || !$(`a[href="${mobilePlatform.sourceUrl}"]`).length)
      errors.push(`${label}: missing mobile navigation or official reference`);
  }
  if (['/download/', '/help/'].includes(basePath(route))) {
    for (const platform of mobilePlatforms) {
      if (!$(`.mobile-platform[href="${localPath(`/guides/${platform.slug}/`, locale)}"]`).length)
        errors.push(`${label}: missing mobile setup guide ${platform.id}`);
    }
  }
  if (basePath(route) === '/manga-translator/') errors.push(`${label}: removed advertising landing page remains in output`);
  if (basePath(route) === '/translate/') {
    if (!noindex || $('.translation-workbench').length !== 1 || $('.translation-composer input[type=file]').length !== 1) errors.push(`${label}: translator must be a private, usable work surface`);
    if (!$('.translation-composer input[type=file]').is('[multiple]') || $('.translation-files').length !== 1 || $('button[data-download-all][disabled]').length !== 1 || $('button[data-clear-cache][disabled]').length !== 1) errors.push(`${label}: translator needs batch upload, file list, disabled ZIP download and local cache clearing`);
    if ($('.translation-workbench img, .translation-viewer, .translation-canvas, .translation-workbench input[type=range]').length) errors.push(`${label}: translator must not include image previews, comparison or zoom controls`);
  }
  if (basePath(route) === '/pricing/') {
    const published = $('.published-plan-pricing');
    if (published.length !== 2 || published.attr('data-billing-interval') !== 'quarter' || published.first().find('.price .price-value').text() !== publishedAmount('quarter',locale)) errors.push(`${label}: initial static pricing must show the actual published quarterly total`);
    if ($('.pricing-comparison .billing-cycle input[type=radio]').length !== 2) errors.push(`${label}: quarterly/yearly preview must be available without an API quote`);
    const comparison = $('.pricing-comparison');
    const cards = comparison.find('.subscription-card');
    if (comparison.length !== 1 || cards.length !== 3) errors.push(`${label}: expected Free and preview subscription cards`);
    const expectedRows = comparisonRows(locale, 0);
    for (const [index, tier] of ['free', 'lite', 'lite'].entries()) {
      const card = cards.eq(index);
      if (card.find('.subscription-allowance').length !== 1) errors.push(`${label}: missing prominent page allowance`);
      for (const feature of expectedRows.filter(row => row.key === 'rate' || row.key === 'priority')) {
        const row = card.find(`[data-feature="${feature.key}"]`);
        if (row.length !== 1 || row.find('strong').text() !== feature[tier as 'free' | 'lite']) errors.push(`${label}: missing localized card benefit ${tier}/${feature.key}`);
      }
      if (card.find('.plan-models .icon-check').length !== (index === 0 ? 2 : 4)) errors.push(`${label}: incorrect free/paid model access`);
    }
    const table = comparison.find('.plan-comparison');
    if (table.find('thead th').length !== 4 || table.find('tr[data-model]').length !== 4) errors.push(`${label}: missing Free/PLUS/Pro model comparison`);
    if (!comparison.find('[data-plan="pro"] .plan-difference').text().includes((1500).toLocaleString(locale))) errors.push(`${label}: missing catalog-driven paid quota difference`);
    for (const feature of expectedRows.filter(row => row.detail)) {
      const row = table.find(`[data-feature="${feature.key}"]`), trigger = row.find('.feature-info-trigger'), tip = row.find('[role="tooltip"]');
      if (trigger.length !== 1 || trigger.attr('aria-label') !== feature.label || trigger.attr('aria-describedby') !== tip.attr('id') || tip.text() !== feature.detail || !tip.is('[hidden]')) errors.push(`${label}: missing accessible localized feature tip ${feature.key}`);
    }
    if (comparison.find('.price .price-currency').length !== 3 || comparison.find('.billing-cycle-saving .annual-badge').length !== 1) errors.push(`${label}: pricing needs currency typography and annual discount`);
    if (comparison.find('.comparison-note').length < 2) errors.push(`${label}: missing quota consumption and renewal disclosures`);
    if (comparison.find('.billing-availability button[disabled]').length !== 2 || $('.billing-availability[data-state="loading"]').length !== 2) errors.push(`${label}: static pricing must explain purchase availability with a disabled action`);
    if ($('a[href*="price="]').length || $('[data-billing-catalog="live"]').length) errors.push(`${label}: static pricing must not fabricate a purchasable API offer`);
  }
  $('img').each((_,node) => {
    const image = $(node);
    const decorative = image.attr('alt') === '' && image.attr('aria-hidden') === 'true';
    const dimensions = image.attr('width') && image.attr('height');
    if ((!image.attr('alt') && !decorative) || !dimensions) errors.push(`${label}: image missing alt/dimensions`);
  });
  for (const node of $('a[href],img[src],script[src],link[rel=stylesheet]').toArray()) {
    const target = $(node).attr('href') ?? $(node).attr('src') ?? '';
    const resolved = new URL(target, canonical);
    if (resolved.origin !== site.url) continue;
    const path = resolved.pathname;
    if (Object.values(site.extensionPackages).some(release => path === release.path)) continue; // Backend allowlisted R2 downloads.
    const actual = target.startsWith('#') ? file : join(root, path.endsWith('/') ? `${path}index.html` : path);
    if (!await stat(actual).catch(() => false)) errors.push(`${label}: broken local link ${target}`);
    const targetPage = pages.get(actual);
    if (resolved.hash && targetPage && !targetPage('[id]').toArray().some(node => targetPage(node).attr('id') === decodeURIComponent(resolved.hash.slice(1)))) errors.push(`${label}: missing link anchor ${target}`);
  }
  if (/(sk-[a-zA-Z0-9]{20,}|sub2api\.nodelane\.net)/.test(html)) errors.push(`${label}: private generation config leaked`);
}
for (const locale of locales) {
  const expected = locale.startsWith('zh') ? homePreviews.get('zh-CN') : homePreviews.get('en');
  if (homePreviews.get(locale) !== expected) errors.push(`${locale}: incorrect screenshot language`);
}
if (homePreviews.get('zh-CN') === homePreviews.get('en')) errors.push('Chinese and English screenshot sets must differ');
const sitemap = await readFile(join(root,'sitemap.xml'),'utf8');
const xml = load(sitemap, { xmlMode: true });
const locations = xml('url > loc').toArray().map(node => xml(node).text());
if (locations.length !== publicPaths.length * locales.length || new Set(locations).size !== locations.length) errors.push('sitemap must contain every public language route exactly once');
for (const node of xml('url').toArray()) {
  const route = new URL(xml(node).find('loc').text()).pathname;
  if (!indexedRoutes.has(route)) errors.push(`sitemap targets non-indexable page ${route}`);
  const alternates = xml(node).find('xhtml\\:link');
  if (alternates.length !== locales.length + 1) errors.push(`sitemap missing language alternates ${route}`);
  for (const language of [...locales, 'x-default'] as const) {
    const target = site.url + (language === 'x-default' ? basePath(route) : localPath(basePath(route), language));
    if (alternates.filter((_, element) => xml(element).attr('hreflang') === language).attr('href') !== target) errors.push(`sitemap wrong alternate ${route}: ${language}`);
  }
}
for(const path of publicPaths) for(const locale of locales) if(!sitemap.includes(`<loc>${site.url}${localPath(path,locale)}</loc>`)) errors.push(`sitemap missing ${localPath(path,locale)}`);
for (const forbidden of ['/account/','/auth/','/payment/','/uninstall/','/manga-translator/','/404','/v1/']) if (sitemap.includes(forbidden)) errors.push(`sitemap includes ${forbidden}`);
for (const file of [...locales.flatMap(locale=>['/account/','/auth/callback/','/payment/success/','/uninstall/'].map(path=>`${localPath(path,locale)}index.html`)),'404.html']) if (!(await readFile(join(root,file),'utf8')).includes('noindex')) errors.push(`${file}: missing noindex`);
if (errors.length) throw Error(errors.join('\n'));
console.log(`Validated ${htmlFiles.length} static pages and ${locations.length} indexable URLs: unique metadata, reciprocal languages, FAQ content/schema, browser entrances, published PLUS/Pro pricing, links/anchors, images and index boundaries.`);
