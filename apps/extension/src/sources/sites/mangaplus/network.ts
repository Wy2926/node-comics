import {SourceProtocolError, type SourceNetwork, type SourceNetworkContext, type SourceDocumentProjection} from '../../contracts/network';
import type {SourceCatalogSnapshot, SourceSnapshot} from '../../contracts/source';
import {catalogKey, catalogUrl, chapterKey, origin, route} from './definition';
import {projectCatalog, projectViewer} from './document';
import {rememberPages} from './image';

const changed = () => new SourceProtocolError('MANGA Plus 网页数据不完整或读取协议已变化。');
const validId = (n:unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 0xffffffff;
const label = (v:unknown) => {if (typeof v !== 'string' || !v.trim() || v.length > 1000) throw changed(); return v.trim();};
const languages = ['en', 'es', 'fr', 'id', 'pt-BR', 'ru', 'th', 'de', 'it', 'vi'];
function location(url:string, reader:boolean) {
  const loc = route(new URL(url));
  if (!loc || loc.reader !== reader) throw changed();
  return loc;
}
async function read(ctx:SourceNetworkContext, project:SourceDocumentProjection) {
  ctx.signal?.throwIfAborted();
  if (!ctx.readDocument) throw Error('请在浏览器插件中打开 MANGA Plus。');
  const raw = await ctx.readDocument(project);
  ctx.signal?.throwIfAborted();
  try {return JSON.parse(raw);} catch {throw changed();}
}
export const network = {
  async catalog(url, ctx): Promise<SourceCatalogSnapshot> {
    const {id} = location(url, false), key = catalogKey(id);
    const m = await read(ctx, projectCatalog);
    if (m?.id !== Number(id) || !Array.isArray(m.rows) || !m.rows.length || m.rows.length > 10000) throw changed();
    const seen = new Set<number>(), entries:SourceCatalogSnapshot['entries'] = [];
    for (const row of m.rows) {
      if (!row || row.work !== m.id || !validId(row.id) || seen.has(row.id) || typeof row.readable !== 'boolean') throw changed();
      seen.add(row.id);
      const chapter = String(row.id);
      entries.push({id:chapterKey(chapter), remoteId:chapter, catalogId:key, sequenceId:key,
        url:`${origin}/viewer/${chapter}#nodelane-mangaplus=${id}`,
        title:label(row.name) + (row.subtitle ? ' · ' + label(row.subtitle) : ''), order:entries.length,
        readable:row.readable, related:false, groupIds:[], rawTypes:[], contentLanguage:languages[m.language]});
    }
    return {id:key, sourceId:'mangaplus', url:catalogUrl(id), title:label(m.name), complete:true, observedAt:Date.now(),
      groups:[], entries, defaultEntryId:entries.find(e => e.readable)?.id,
      note:'网页公开目录；仅限 App 的章节以源站为准。'};
  },
  async resolveCatalog(url, ctx) {
    const loc = location(url, true), m = await read(ctx, projectViewer);
    if (m?.id !== Number(loc.id) || !validId(m.work)) throw changed();
    return catalogUrl(String(m.work));
  },
  async pages(url, ctx): Promise<SourceSnapshot> {
    const loc = location(url, true), m = await read(ctx, projectViewer);
    if (m?.id !== Number(loc.id) || !validId(m.work) || loc.title && m.work !== Number(loc.title) ||
        typeof m.vertical !== 'boolean' || typeof m.token !== 'string' || !/^[a-f0-9]{32}$/i.test(m.token) ||
        !Array.isArray(m.pages) || !m.pages.length || m.pages.length > 1500) throw changed();
    const title = label(m.name), items:SourceSnapshot['items'] = [];
    const assets = new Map<string,{url:string; processing?:string}>();
    const path = new RegExp(`^/secure/title/${m.work}/chapter/${m.id}/manga_page/(?:low|high|super_high)/[\\w.-]+\\.(?:jpe?g|png|webp)$`, 'i');
    for (const p of m.pages) {
      if (!p || typeof p.url !== 'string' || p.url.length > 8192 || !URL.canParse(p.url) ||
          ![p.width,p.height].every(n => Number.isInteger(n) && n > 0 && n <= 100000) ||
          typeof p.key !== 'string' || p.key && !/^[a-f\d]{128}$/i.test(p.key)) throw changed();
      const asset = new URL(p.url), locator = asset.origin + asset.pathname;
      if (!/^https:\/\/jumpg-assets(?:[1-9]\d?)?\.tokyo-cdn\.com$/.test(asset.origin) || asset.username || asset.password ||
          asset.hash || !path.test(asset.pathname) || assets.has(locator)) throw changed();
      assets.set(locator, {url:asset.href, processing:p.key || undefined});
      items.push({id:'page-' + items.length, order:items.length, width:p.width, height:p.height,
        contentKey:'mangaplus:' + asset.pathname, resource:{kind:'http', url:locator}});
    }
    rememberPages(loc.id, assets, m.token);
    return {adapter:'mangaplus', url, title, direction:m.vertical ? 'ltr' : 'rtl', discoveryComplete:true,
      knownTotal:items.length, items, note:''};
  },
} satisfies SourceNetwork;
