import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { load } from 'cheerio';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { browserStores, site } from '../src/data/site';
import { homeSamples, homeSampleLanguage, homeSampleLanguages, type HomeSampleKind } from '../src/data/home-samples';
import { mobilePlatforms } from '../src/data/mobile';
import { mobileCopy } from '../src/i18n/mobile';
import { homeCopy } from '../src/i18n/home';
import { sitesCopy } from '../src/i18n/sites';
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
const pages = new Map<string, ReturnType<typeof load>>();
const sharedFlags = new Map<string, string>();
const checkedFlags = new Set<string>();
type HomePicture = { src: string; srcset: string; full: string; width: number; height: number };
const homeImageMetadata = new Map<string, ReturnType<ReturnType<typeof sharp>['metadata']>>();
async function checkHomePicture(picture: HomePicture, label: string, widths: number[]) {
  if (!picture?.src || !picture.srcset || !picture.full || !picture.width || !picture.height) {
    errors.push(`${label}: missing responsive or full-size artwork`);
    return;
  }
  const candidates = picture.srcset.split(',').map(candidate => candidate.trim().split(/\s+/));
  if (candidates.map(([, width]) => width).join(',') !== widths.map(width => `${width}w`).join(',')) errors.push(`${label}: incorrect width-described responsive images`);
  for (const [url, width] of [...candidates, [picture.full, `${picture.width}w`]]) {
    if (!url.startsWith('/_astro/')) { errors.push(`${label}: artwork must use a local build asset`); continue; }
    let metadata = homeImageMetadata.get(url);
    if (!metadata) {
      metadata = sharp(join(root, url)).metadata();
      homeImageMetadata.set(url, metadata);
    }
    try {
      const image = await metadata;
      if (image.width !== Number.parseInt(width) || !image.height || Math.abs(image.height - Number.parseInt(width) * picture.height / picture.width) > 1)
        errors.push(`${label}: wrong built dimensions ${url}`);
    } catch { errors.push(`${label}: missing or undecodable artwork ${url}`); }
  }
  if (!candidates.some(([url]) => url === picture.src)) errors.push(`${label}: default artwork must be one of its responsive variants`);
}
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
  const policyKey = basePath(route).split('/')[1];
  const policy = dictionaries[locale].documents.policies[policyKey];
  if (policy) {
    if ($('.meta time').attr('datetime') !== policy.updated) errors.push(`${label}: stale policy revision`);
    // The article renderer must not silently omit any privacy or billing disclosure.
    const paragraphs = policy.sections.flatMap(section => section.paragraphs);
    const articleText = $('.prose').text();
    if (paragraphs.some(text => !articleText.includes(text))) errors.push(`${label}: missing policy paragraph`);
  }
  if (!noindex || $('.site-header').length) {
    if ($('.header-download[data-install-extension]').attr('href') !== localPath('/download/', locale)) errors.push(`${label}: installation must retain a localized no-script fallback`);
    if ($('body').attr('data-install-stores') !== JSON.stringify(site.stores)) errors.push(`${label}: installation destinations must use the official store configuration`);
  }
  if ($('footer .directory-badges, footer .directory-track').length) errors.push(label + ': removed directory links remain');
  if ($('html').attr('dir') !== (locale === 'ar' ? 'rtl' : 'ltr')) errors.push(label + ': wrong text direction');
  if ($('html').attr('lang') !== locale) errors.push(`${label}: wrong language`);
  if ($('.language-menu').length) {
    if ($('.language-menu summary .language-flag[loading="eager"]').length !== 1
      || $('.language-menu nav .language-flag[loading="lazy"]').length !== locales.length)
      errors.push(`${label}: only the selected language flag should load before the menu opens`);
    for (const node of $('.language-flag').toArray()) {
      const flag = $(node), src = flag.attr('src') ?? '';
      if (!/^\/_astro\/[a-z]{2}\.[\w-]+\.svg$/.test(src)) { errors.push(`${label}: flag must be an independently cached hashed SVG`); continue; }
      if (!checkedFlags.has(src)) {
        const original = await readFile(join('src/assets/flags', src.split('/').at(-1)!.split('.')[0] + '.svg'));
        if (!original.equals(await readFile(join(root, src)))) errors.push(`${label}: original flag artwork changed`);
        checkedFlags.add(src);
      }
      const language = flag.closest('a').attr('lang') ?? locale;
      if (sharedFlags.has(language) && sharedFlags.get(language) !== src) errors.push(`${label}: flag URL must be shared across routes`);
      sharedFlags.set(language, src);
    }
  }
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
  if (basePath(route) === '/changelog/') {
    const releases = dictionaries[locale].documents.releases;
    const articles = $('.release');
    const feed = load(await readFile(join(root, localPath('/feed.xml', locale)), 'utf8'), { xmlMode: true });
    const items = feed('channel > item');
    if (articles.length !== releases.length || items.length !== releases.length) errors.push(`${label}: missing changelog or RSS entries`);
    releases.forEach((release, index) => {
      const article = articles.eq(index), item = items.eq(index);
      const anchor = `release-${release.id ?? release.date}`;
      const url = `${canonical}#${anchor}`;
      if (article.attr('id') !== anchor || article.find('time').attr('datetime') !== release.date
        || article.find('h2').text() !== release.title
        || JSON.stringify(article.find('li').toArray().map(node => $(node).text())) !== JSON.stringify(release.items))
        errors.push(`${label}: changelog content mismatch ${anchor}`);
      const description = release.items.join(locale === 'zh-CN' ? '；' : '; ');
      if (item.find('title').text() !== release.title || item.find('link').text() !== url || item.find('guid').text() !== url
        || item.find('description').text() !== description
        || item.find('pubDate').text() !== new Date(`${release.date}T00:00:00+08:00`).toUTCString())
        errors.push(`${label}: RSS content mismatch ${anchor}`);
    });
  }
  if (basePath(route) === '/sites/') {
    const cards = $('.supported-site');
    const graph = JSON.parse($('script[type="application/ld+json"]').text())['@graph'];
    const collection = graph.find((entry: Record<string, unknown>) => entry['@id'] === canonical);
    const list = graph.find((entry: Record<string, unknown>) => entry['@type'] === 'ItemList');
    if (!cards.length || collection?.['@type'] !== 'CollectionPage' || collection?.mainEntity?.['@id'] !== `${canonical}#directory`
      || list?.numberOfItems !== cards.length || list?.itemListElement?.length !== cards.length)
      errors.push(`${label}: site collection/schema mismatch`);
    if ($('main astro-island').length || title !== `${sitesCopy[locale].title} · ${dictionaries[locale].ui.brandName}` || description !== sitesCopy[locale].description)
      errors.push(`${label}: site directory must be static and localized`);
    if ($('main [data-install-extension], main a[href$="/download/"]').length || $('.page-intro .intro-description').text() !== sitesCopy[locale].intro)
      errors.push(`${label}: site directory must explain in-extension support without duplicating the navigation download action`);
    const keys = cards.toArray().map(node => $(node).attr('data-site-key'));
    if (new Set(keys).size !== keys.length || keys.some(key => !key)) errors.push(`${label}: duplicate/missing site keys`);
    let previousDate = '9999-99-99';
    cards.each((index, node) => {
      const card = $(node), name = card.find('h3').text().trim(), anchor = card.attr('id');
      const item = list?.itemListElement?.[index];
      if (!name || item?.name !== name || item?.position !== index + 1 || item?.url !== `${canonical}#${anchor}`
        || card.find('.site-reading').text() !== sitesCopy[locale].readOn.replace('{site}', name))
        errors.push(`${label}: site content/schema mismatch ${anchor}`);
      const outbound = card.find('a[href]'), rel = new Set((outbound.attr('rel') ?? '').split(/\s+/));
      if (outbound.length !== 1 || !['nofollow','noopener','noreferrer'].every(value => rel.has(value)) || outbound.attr('target') !== '_blank')
        errors.push(`${label}: source link must be qualified ${anchor}`);
      const date = card.find('time').attr('datetime') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > previousDate) errors.push(`${label}: sites must keep adapter date order`);
      previousDate = date;
      const icon = new URL(card.find('img').attr('src') ?? '', canonical);
      if (icon.origin !== site.url && !icon.href.startsWith('data:image/')) errors.push(`${label}: third-party site icon request`);
      if (!card.find('[data-pricing]').length || !card.find('[data-content-tag]').length || !card.find('.site-languages').text())
        errors.push(`${label}: missing source labels ${anchor}`);
    });
  }
  if (basePath(route) === '/') {
    if (title !== dictionaries[locale].ui.seoHomeTitle || description !== homeCopy[locale].description)
      errors.push(`${label}: redesign must preserve the existing localized SEO title and description`);
    const software = JSON.parse($('script[type="application/ld+json"]').text())['@graph'].find((entry: Record<string, unknown>) => entry['@type'] === 'SoftwareApplication');
    if (software?.offers?.description !== $('.home-access').text() || software?.offers?.price !== '0')
      errors.push(`${label}: free installation structured data must match visible content`);
    const platforms = $('.hero-stores > a').toArray().map(node => $(node).attr('data-browser') ?? $(node).attr('data-platform'));
    if (platforms.join(',') !== 'android,chrome,edge,firefox,ios')
      errors.push(`${label}: mobile platforms must flank the desktop browsers`);
    if ($('main input[type=file], main astro-island, .gallery-switches, .product-sources').length) errors.push(`${label}: homepage must keep a focused static extension journey`);
    if ($('.home-copy a[data-install-extension]').length !== 1 || !$(`.home-hero a[data-install-extension][href="${localPath('/download/',locale)}"]`).length) errors.push(`${label}: homepage must have one primary installation action`);
    if ($('main .home-plan, main .home-price, main .home-cycle, main a[href$="/pricing/"]').length) errors.push(`${label}: pricing belongs on the separate pricing page`);
    if ($('main a[href$="/translate/"]').length || $(`.site-header nav a[href="${localPath('/translate/',locale)}"]`).length !== 2) errors.push(`${label}: translator must be in desktop and mobile navigation`);
    if ($('main [data-install-icon][src="/browsers/chrome.svg"]').length !== 2) errors.push(`${label}: installation icons need a Chrome no-script fallback`);
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
    if ($('.home-screenshot img').length !== 1 || !$('.home-screenshot img').attr('srcset')) errors.push(`${label}: expected one responsive in-tab screenshot`);
    if ($('[data-inline-comparison] input[type=range][hidden]').length !== 1 || $('[data-inline]').length) errors.push(`${label}: in-tab comparison must use an accessible progressively enhanced slider`);
    const scripts = await Promise.all($('script[type=module]').toArray().map(node => $(node).attr('src') ? readFile(join(root, $(node).attr('src')!), 'utf8') : $(node).text()));
    const showcaseScript = scripts.find(text => text.includes('[data-home-showcase]'));
    if (!showcaseScript || gzipSync(showcaseScript).byteLength > 4 * 1024) errors.push(`${label}: homepage interaction script exceeds its 4 KiB gzip budget`);
    if ($('.home-image-pair img[loading="lazy"]').length !== 2 || $('.home-search img[loading="lazy"]').length !== 1) errors.push(`${label}: comparison and search must be lazy-loaded static content`);
    if ($('.home-image-pair input[type=range][hidden]').length !== 1 || $('[data-view-choice]').length) errors.push(`${label}: mobile comparison must use a slider rather than original/translated buttons`);
    if ($('button[data-sample]').length !== 2 || $('[data-language-choice]').length !== locales.length || $('[data-language-choice]:not([hidden])').length !== 16)
      errors.push(`${label}: expected two samples and all 16 available translation languages`);
    if ($('[data-home-showcase]').attr('data-language') !== homeSampleLanguage('mono', locale) || $('[data-home-showcase]').attr('data-sample') !== 'mono')
      errors.push(`${label}: initial comparison must match the page language except the source-language fallback`);
    const languageSelect = $('select[data-language-select]');
    if (languageSelect.length !== 1 || languageSelect.find('option').length !== locales.length || languageSelect.find('option:not([hidden]):not([disabled])').length !== 16)
      errors.push(`${label}: mobile language picker must expose every supported target`);
    for (const language of locales) {
      const button = $(`[data-language-choice="${language}"]`), option = languageSelect.find(`option[value="${language}"]`);
      if (button.length !== 1 || option.length !== 1 || !button.text().trim() || !option.text().trim() || button.attr('lang') !== language)
        errors.push(`${label}: missing accessible native language name ${language}`);
      if (button.is('[hidden]') !== (language === 'ja') || option.is('[hidden][disabled]') !== (language === 'ja'))
        errors.push(`${label}: only the original language should be unavailable ${language}`);
    }
    const fallback = load($('noscript').toArray().map(node => $(node).html()).join(''), { scriptingEnabled: false });
    if (fallback('[data-gallery-link]').length !== 32 || fallback('[data-gallery-original]').length !== 2)
      errors.push(`${label}: no-script gallery must link to both originals and all 32 translations`);
    try {
      const assets = JSON.parse($('[data-home-assets]').text());
      if (Object.keys(assets.languageNames).sort().join(',') !== [...locales].sort().join(',')) errors.push(`${label}: missing native names in the gallery manifest`);
      for (const kind of Object.keys(homeSamples) as HomeSampleKind[]) {
        const sample = assets.samples[kind], targets = homeSampleLanguages(kind);
        if (!sample || Object.keys(sample.translations).sort().join(',') !== [...targets].sort().join(',')) {
          errors.push(`${label}: ${kind} must contain all 16 targets and exclude its source language`);
          continue;
        }
        await checkHomePicture(sample.original, `${label}/${kind}/original`, homeSamples[kind].widths);
        for (const language of targets) {
          const picture = sample.translations[language];
          if (picture.width !== sample.original.width || picture.height !== sample.original.height) errors.push(`${label}: ${kind}/${language} changed the artwork dimensions`);
          await checkHomePicture(picture, `${label}/${kind}/${language}`, homeSamples[kind].widths);
          const link = fallback(`[data-gallery-link][data-sample-key="${kind}"][lang="${language}"]`);
          if (link.length !== 1 || link.attr('href') !== picture.full || !link.text().trim()) errors.push(`${label}: missing full-size static translation link ${kind}/${language}`);
        }
      }
      const selected = assets.samples.mono.translations[homeSampleLanguage('mono', locale)];
      if ($('[data-comparison=translated] img').attr('src') !== selected.src || $('[data-comparison=translated] a').attr('href') !== selected.full)
        errors.push(`${label}: static comparison image and full-size link must use the selected page language`);
    } catch { errors.push(`${label}: invalid homepage gallery manifest`); }
    const directory = pages.get(join(root, localPath('/sites/', locale), 'index.html'));
    const entries = directory?.('.supported-site').toArray().map(node => ({ anchor: directory(node).attr('id'), name: directory(node).find('h3').text(), price: directory(node).find('[data-pricing]').text() })) ?? [];
    const minis = $('.sites-group:not(.sites-clone) a.site-mini');
    if ($('.home-sites .sites-row').length !== 3 || !entries.length || minis.length !== entries.length)
      errors.push(`${label}: homepage must contain three rows and every supported site`);
    if ($('.home-sites input, .sites-pause').length || $('.home-sites-heading p').text() !== sitesCopy[locale].carouselBody)
      errors.push(`${label}: carousel must explain support scope without a pause checkbox`);
    for (const entry of entries) {
      const mini = minis.filter(`[href="${localPath('/sites/',locale)}#${entry.anchor}"]`);
      if (mini.length !== 1 || mini.children().length !== 2 || mini.find('bdi').text() !== entry.name || mini.find('[data-pricing]').text() !== entry.price)
        errors.push(`${label}: mini card must contain only the source name and pricing ${entry.anchor}`);
    }
    if ($('.sites-clone:not([aria-hidden=true]), .sites-clone a:not([tabindex="-1"])').length) errors.push(`${label}: carousel copies must not duplicate keyboard/screen-reader navigation`);
    const carouselScript = scripts.find(text => text.includes('[data-sites-carousel]'));
    if (!carouselScript || gzipSync(carouselScript).byteLength > 1024) errors.push(`${label}: carousel visibility script exceeds 1 KiB gzip`);
  }
  const mobilePlatform = mobilePlatforms.find(platform => basePath(route) === `/guides/${platform.slug}/`);
  if (mobilePlatform) {
    const expected = mobilePlatform.id === 'android' ? 3 : 0;
    if ($('.guide-screenshot img').length !== expected || $('.screenshot-placeholder').length !== 0)
      errors.push(`${label}: incorrect Android screenshots or premature iOS screenshots`);
    for (const [index, element] of $('.guide-screenshot img').toArray().entries()) {
      const image = $(element);
      const language = locale.startsWith('zh') ? 'zh-CN' : 'en';
      const source = join('src/assets/guides/firefox', language, ['01-firefox-open', '02-add-extension', '03-read-sample'][index] + '.png');
      const full = image.parent('a').attr('href') ?? '';
      if (!full.startsWith('/_astro/') || !(await readFile(source)).equals(await readFile(join(root, full)))) errors.push(`${label}: original mobile screenshot or language changed`);
      if (image.attr('width') !== '720' || image.attr('height') !== '1600' || image.attr('loading') !== 'lazy' || image.attr('sizes') !== '252px')
        errors.push(`${label}: incorrect screenshot language, dimensions or loading`);
      await checkHomePicture({src: image.attr('src') ?? '', srcset: image.attr('srcset') ?? '', full, width:1080, height:2400}, `${label}/mobile-${index}`, [320,540,720]);
      for (const candidate of (image.attr('srcset') ?? '').split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (!url.endsWith('.webp') || (await stat(join(root, url))).size > 200_000) errors.push(`${label}: mobile preview exceeds its 200 kB WebP budget`);
      }
    }
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
    const upload = $('.translation-composer input[type=file]');
    const accepted = (upload.attr('accept') ?? '').split(',');
    if (!upload.is('[multiple]') || !['image/jpeg', 'image/png', 'image/webp', '.pdf', '.zip', '.cbz'].every(type => accepted.includes(type)) || $('.translation-files').length !== 1 || $('.document-workbench, .translation-kind-nav').length) errors.push(`${label}: translator needs one mixed-file upload and one task list`);
    if ($('button[data-download-all], button[data-clear-cache]').length) errors.push(`${label}: empty translator must not show image-only history actions`);
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
      if (card.find('.plan-models .icon-check').length !== publishedModels.free.length + (index === 0 ? 0 : publishedModels.paid_extra.length)) errors.push(`${label}: incorrect free/paid model access`);
    }
    const table = comparison.find('.plan-comparison');
    if (table.find('thead th').length !== 4 || table.find('tr[data-model]').length !== publishedModels.free.length + publishedModels.paid_extra.length) errors.push(`${label}: missing Free/PLUS/Pro model comparison`);
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
if (checkedFlags.size !== locales.length || sharedFlags.size !== locales.length) errors.push('expected one shared SVG for each supported language');
if (errors.length) throw Error(errors.join('\n'));
console.log(`Validated ${htmlFiles.length} static pages and ${locations.length} indexable URLs: unique metadata, reciprocal languages, FAQ content/schema, browser entrances, published PLUS/Pro pricing, links/anchors, images and index boundaries.`);
