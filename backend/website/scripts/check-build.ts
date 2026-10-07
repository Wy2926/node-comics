import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { load } from 'cheerio';
import { browserStores, site } from '../src/data/site';
import { publishedAmount } from '../src/components/PublishedLitePricing';
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
    if ($('main input[type=file], main astro-island, .gallery-switches, .product-sources').length) errors.push(`${label}: homepage must keep a focused static extension journey`);
    if ($('.home-hero .button').length !== 1 || !$(`.home-hero a[data-install-extension][href="${localPath('/download/',locale)}"]`).length) errors.push(`${label}: homepage must have one primary installation action`);
    if (!$(`.home-service a[href="${localPath('/pricing/',locale)}"]`).length || $('.home-plan').length !== 2) errors.push(`${label}: missing Free/Lite plan entrance`);
    for (const store of browserStores) {
      const entrance = $(`.hero-store[data-browser="${store.id}"]`);
      const target = store.url || `${localPath('/download/', locale)}#${store.id}`;
      if (entrance.length !== 1 || entrance.attr('href') !== target) errors.push(`${label}: missing configured ${store.id} platform entrance`);
    }
    if ($('.home-faq, .home-cta, .home-steps').length || $('.home-cycle input[type=radio]').length !== 2) errors.push(`${label}: keep one focused hero and a static monthly/yearly plan preview`);
    for (const feature of ['classic', 'model', 'rate', 'priority', 'reading']) {
      if ($(`.home-plan li[data-feature="${feature}"]`).length !== 2) errors.push(`${label}: homepage must compare ${feature}`);
    }
    if ($('.home-plan').first().find('.icon-check').length !== 1 || $('.home-plan-lite .icon-check').length !== 5 || $('.home-plan-lite li strong').length !== 4) errors.push(`${label}: homepage must distinguish shared benefits from Lite advantages`);
    if ($('.home-price .price-currency').length !== 3 || $('.home-cycle-picker .billing-cycle-saving .annual-badge').length !== 1) errors.push(`${label}: homepage needs separated currency typography and a stable annual discount slot`);
    const preview = $('.home-screenshot img').attr('src');
    if (!preview || $('.home-screenshot img').length !== 1 || !$('.home-screenshot img').attr('srcset')) errors.push(`${label}: expected one responsive real product screenshot`);
    else homePreviews.set(locale, preview);
  }
  if (basePath(route) === '/manga-translator/') errors.push(`${label}: removed advertising landing page remains in output`);
  if (basePath(route) === '/translate/') {
    if (!noindex || $('.translation-workbench').length !== 1 || $('.translation-composer input[type=file]').length !== 1) errors.push(`${label}: translator must be a private, usable work surface`);
    if (!$('.translation-composer input[type=file]').is('[multiple]') || $('.translation-files').length !== 1 || $('button[data-download-all][disabled]').length !== 1 || $('button[data-clear-cache][disabled]').length !== 1) errors.push(`${label}: translator needs batch upload, file list, disabled ZIP download and local cache clearing`);
    if ($('.translation-workbench img, .translation-viewer, .translation-canvas, .translation-workbench input[type=range]').length) errors.push(`${label}: translator must not include image previews, comparison or zoom controls`);
  }
  if (basePath(route) === '/pricing/') {
    const published = $('.published-lite-pricing');
    if (published.length !== 1 || published.attr('data-billing-interval') !== 'month' || published.find('.price-value').text() !== publishedAmount('month',locale)) errors.push(`${label}: initial static pricing must show the actual published monthly total`);
    if ($('.pricing-comparison .billing-cycle input[type=radio]').length !== 2) errors.push(`${label}: monthly/yearly preview must be available without an API quote`);
    const comparison = $('.pricing-comparison');
    const table = comparison.find('table.plan-comparison');
    if (comparison.length !== 1 || comparison.find('.pricing-grid .price-card').length !== 2 || table.length !== 1) errors.push(`${label}: pricing cards and feature comparison must share one connected frame`);
    if (table.find('thead th').length !== 3 || table.find('tbody tr').length !== 6) errors.push(`${label}: expected a three-column comparison with six feature rows`);
    for (const feature of ['reading', 'classic', 'model', 'rate', 'priority', 'early']) {
      const row = table.find(`tbody tr[data-feature="${feature}"]`);
      if (row.length !== 1 || row.children('th,td').length !== 3) errors.push(`${label}: missing aligned feature comparison ${feature}`);
      const values = row.children('td');
      if (values.eq(0).find('.icon-check').length !== (feature === 'reading' ? 1 : 0) || values.eq(1).find('.icon-check').length !== 1) errors.push(`${label}: checkmarks must distinguish shared and paid benefits for ${feature}`);
      if (values.eq(1).find('strong').length !== (feature === 'reading' ? 0 : 1)) errors.push(`${label}: paid advantages must have stronger typography for ${feature}`);
    }
    if (comparison.find('.price .price-currency').length !== 2 || comparison.find('.billing-cycle-saving .annual-badge').length !== 1) errors.push(`${label}: pricing needs separated currency typography and an annual discount slot`);
    if (!table.find('[data-feature="rate"] td').last().text().replace(/\D/g,'').includes('1200')) errors.push(`${label}: missing Lite rolling hourly request limit`);
    const models = table.find('[data-feature="model"] td');
    if (!models.eq(0).text().includes('GPT 6 Luna') || !models.eq(1).text().includes('Gemini 3.8 Flash')) errors.push(`${label}: missing plan-specific translation models`);
    if (/PLUS|\b300\b/.test(comparison.text())) errors.push(`${label}: retired PLUS must not be advertised for new purchase`);
    if (comparison.find('.billing-availability button[disabled]').length !== 1 || $('.billing-availability[data-state="loading"]').length !== 1) errors.push(`${label}: static pricing must explain purchase availability with a disabled action`);
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
console.log(`Validated ${htmlFiles.length} static pages and ${locations.length} indexable URLs: unique metadata, reciprocal languages, FAQ content/schema, browser entrances, published Lite pricing, links/anchors, images and index boundaries.`);
