import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { load } from 'cheerio';
import { site, browserStores } from '../src/data/site';
import { dictionaries, locales, localeFromPath, basePath, localPath, publicPaths } from '../src/i18n';
const root = resolve('dist');
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir,entry.name)]))).flat(); }
const errors: string[] = [];
const titles = new Set<string>();
const descriptions = new Set<string>();
const indexedRoutes = new Set<string>();
const pages = new Map<string, ReturnType<typeof load>>();
const htmlFiles = (await files(root)).filter(path => path.endsWith('.html'));
for (const file of htmlFiles) pages.set(file, load(await readFile(file, 'utf8')));
for (const file of htmlFiles) {
  const html = await readFile(file,'utf8');
  const $ = load(html);
  const label = file.slice(root.length);
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
    if ($('.hero-stores a').length !== 3) errors.push(`${label}: expected three homepage browser entrances`);
    for (const store of browserStores) {
      const link = $(`.hero-stores [data-browser="${store.id}"]`);
      const expected = store.url || `${localPath('/download/', locale)}#${store.id}`;
      if (link.attr('href') !== expected || link.find('img').attr('src') !== store.icon) errors.push(`${label}: wrong browser entrance ${store.id}`);
      if (!store.url && !$('.hero-store-status').text().includes(dictionaries[locale].ui.storeUnavailable)) errors.push(`${label}: missing pending store status`);
    }
  }
  $('img').each((_,node) => { if (!$(node).attr('alt') || !$(node).attr('width') || !$(node).attr('height')) errors.push(`${label}: image missing alt/dimensions`); });
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
for (const forbidden of ['/account/','/auth/','/payment/','/404','/v1/']) if (sitemap.includes(forbidden)) errors.push(`sitemap includes ${forbidden}`);
for (const file of [...locales.flatMap(locale=>['/account/','/auth/callback/','/payment/success/'].map(path=>`${localPath(path,locale)}index.html`)),'404.html']) if (!(await readFile(join(root,file),'utf8')).includes('noindex')) errors.push(`${file}: missing noindex`);
if (errors.length) throw Error(errors.join('\n'));
console.log(`Validated ${htmlFiles.length} static pages and ${locations.length} indexable URLs: unique metadata, reciprocal languages, FAQ content/schema, browser entrances, links/anchors, images and index boundaries.`);
