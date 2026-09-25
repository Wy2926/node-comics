import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { load } from 'cheerio';
import { site } from '../src/data/site';
import { locales, localeFromPath, basePath, localPath, publicPaths } from '../src/i18n';
const root = resolve('dist');
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir,entry.name)]))).flat(); }
const errors: string[] = [];
const titles = new Set<string>();
const htmlFiles = (await files(root)).filter(path => path.endsWith('.html'));
for (const file of htmlFiles) {
  const html = await readFile(file,'utf8');
  const $ = load(html);
  const label = file.slice(root.length);
  if ($('h1').length !== 1) errors.push(`${label}: expected one h1`);
  const title = $('title').text();
  if (!title || titles.has(title)) errors.push(`${label}: missing/duplicate title`);
  titles.add(title);
  if (!$('meta[name=description]').attr('content')) errors.push(`${label}: missing description`);
  const canonical = $('link[rel=canonical]').attr('href') ?? '';
  if (!canonical.startsWith(site.url)) errors.push(`${label}: bad canonical`);
  const route = new URL(canonical || site.url).pathname;
  const locale = localeFromPath(route);
  if ($('html').attr('lang') !== locale) errors.push(`${label}: wrong language`);
  if (!$('meta[name=robots]').attr('content')?.includes('noindex')) {
    for (const language of locales) if ($(`link[hreflang="${language}"]`).attr('href') !== site.url + localPath(basePath(route),language)) errors.push(`${label}: wrong hreflang ${language}`);
    if ($('link[hreflang="x-default"]').attr('href') !== site.url + basePath(route)) errors.push(`${label}: wrong default language`);
  }
  $('script[type="application/ld+json"]').each((_,node) => { try { JSON.parse($(node).html()!); } catch { errors.push(`${label}: invalid JSON-LD`); } });
  $('img').each((_,node) => { if (!$(node).attr('alt') || !$(node).attr('width') || !$(node).attr('height')) errors.push(`${label}: image missing alt/dimensions`); });
  for (const node of $('a[href],img[src],script[src],link[rel=stylesheet]').toArray()) {
    const target = $(node).attr('href') ?? $(node).attr('src') ?? '';
    if (!target.startsWith('/') || target.startsWith('//')) continue;
    const path = new URL(target, site.url).pathname;
    if (Object.values(site.extensionPackages).some(release => path === release.path)) continue; // Backend allowlisted R2 downloads.
    const actual = join(root, path.endsWith('/') ? `${path}index.html` : path);
    if (!await stat(actual).catch(() => false)) errors.push(`${label}: broken local link ${target}`);
  }
  if (/(sk-[a-zA-Z0-9]{20,}|sub2api\.nodelane\.net)/.test(html)) errors.push(`${label}: private generation config leaked`);
}
const sitemap = await readFile(join(root,'sitemap.xml'),'utf8');
for(const path of publicPaths) for(const locale of locales) if(!sitemap.includes(`<loc>${site.url}${localPath(path,locale)}</loc>`)) errors.push(`sitemap missing ${localPath(path,locale)}`);
for (const forbidden of ['/account/','/auth/','/payment/','/404','/v1/']) if (sitemap.includes(forbidden)) errors.push(`sitemap includes ${forbidden}`);
for (const file of [...locales.flatMap(locale=>['/account/','/auth/callback/','/payment/success/'].map(path=>`${localPath(path,locale)}index.html`)),'404.html']) if (!(await readFile(join(root,file),'utf8')).includes('noindex')) errors.push(`${file}: missing noindex`);
if (errors.length) throw Error(errors.join('\n'));
console.log(`Validated ${htmlFiles.length} static pages: metadata, JSON-LD, local links, images, index boundaries.`);
