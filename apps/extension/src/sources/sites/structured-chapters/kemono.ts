import {msg} from '../../../i18n/runtime';
import type {SourceLocation} from '../../contracts/definition';
import type {SourceNetworkContext} from '../../contracts/network';
import type {SourceSnapshot} from '../../contracts/source';
import {safeImageUrl} from '../../shared/urls';
import {catalogData, directory, incomplete, markup} from './catalog';

const imageName = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;
const hashName = /\/([a-f\d]{64})\.[\w]+$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function badPages(): never {throw Error(msg('来源图片清单不可用。'));}
async function api(origin: string, path: string, ctx: SourceNetworkContext) {
  ctx.signal?.throwIfAborted();
  const raw = await ctx.request(origin + '/api/v1' + path, {redirect:'error'});
  ctx.signal?.throwIfAborted();
  return catalogData(raw);
}
function files(row: Record<string, unknown>) {
  if (row.attachments !== undefined && !Array.isArray(row.attachments)) incomplete();
  const attachments = row.attachments ?? [];
  if (attachments.length > 10000) incomplete();
  return [...(row.file == null ? [] : [row.file]), ...attachments].map(f => record(f) ? f : incomplete());
}

export async function creatorPosts(work: SourceLocation, ctx: SourceNetworkContext) {
  const {origin, pathname} = new URL(work.url), [,service,,user] = pathname.split('/');
  const profile = await api(origin, pathname + '/profile', ctx);
  if (profile?.service !== service || profile.id !== user) incomplete();
  const result = directory(work, profile.name);
  let list = pathname + '/posts';
  let rows = await api(origin,list,ctx).catch(error => {
    // Earlier v1 implementations serve the list on the creator route itself.
    if (error?.kind !== 'http' || error.details?.status !== 404) throw error;
    list = pathname;
    return api(origin,list,ctx);
  });
  for (let offset = 0; ; offset += 50) {
    if (!Array.isArray(rows) || rows.length > 50 || offset + rows.length > 10000) incomplete();
    for (const row of rows) {
      if (!record(row) || row.service !== service || row.user !== user || typeof row.id !== 'string' || !/^[\w-]{1,128}$/.test(row.id)) incomplete();
      const readable = row.attachments === undefined || files(row).some(f => (f.path || f.temp_url) &&
        [f.path, f.name].some(s => typeof s === 'string' && imageName.test(s))) || typeof row.content === 'string' && /<img\b/i.test(row.content);
      result.add(`${work.url}/post/${row.id}`, typeof row.title === 'string' && row.title.trim() || '#' + row.id, readable);
    }
    if (rows.length < 50) return result.finish();
    rows = await api(origin,`${list}?o=${offset+50}`,ctx);
  }
}

function media(value: unknown, base: URL) {
  const href = typeof value === 'string' && safeImageUrl(value,base.href);
  if (!href) return;
  const u = new URL(href);
  if (u.protocol === base.protocol && u.port === base.port &&
      (u.hostname === base.hostname || u.hostname.endsWith('.' + base.hostname)) && imageName.test(u.pathname)) return u;
}
export async function postPages(page: SourceLocation, doc: DocumentFragment, ctx: SourceNetworkContext): Promise<SourceSnapshot> {
  ctx.signal?.throwIfAborted();
  const base = new URL(page.url), [,service,,user,,id] = base.pathname.split('/');
  const images = new Map<string,{url: string; preview: boolean}>();
  const add = (url: URL, preview = false, thumbnail?: URL) => {
    const key = hashName.exec(url.pathname)?.[1] ?? (thumbnail && hashName.exec(thumbnail.pathname)?.[1]) ?? url.origin + url.pathname;
    if (!images.has(key) || images.get(key)!.preview && !preview) images.set(key,{url:url.href,preview});
    if (images.size > 1500) badPages();
  };
  const inline = (scope: ParentNode) => {
    for (const img of scope.querySelectorAll('img')) {
      const u = media(img.getAttribute('data-src') || img.getAttribute('src'),base);
      if (u?.pathname.startsWith('/data/') && hashName.test(u.pathname)) add(u);
    }
  };
  let title: string;
  const section = doc.querySelector('.site-section--post'), scope = section ?? doc;
  if (section || scope.querySelector('.post__files, .post__content')) {
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
    const owner = scope.querySelector('a.post__user-name[href]')?.getAttribute('href');
    if (canonical && safeImageUrl(canonical,page.url) !== page.url || owner && safeImageUrl(owner,page.url) !== page.catalog!.url) badPages();
    if (section?.hasAttribute('data-id')) {
      if (section.getAttribute('data-service') !== service || section.getAttribute('data-user') !== user || section.getAttribute('data-id') !== id) badPages();
    } else if (!canonical || !owner) badPages();
    title = scope.querySelector('.post__title span, .post__title')?.textContent?.trim() || '#' + id;
    const content = scope.querySelector('.post__content');
    if (content) inline(content);
    // Some mirrors advertise absent originals in the API. The gallery links only files it actually offers.
    for (const box of scope.querySelectorAll('.post__files .post__thumbnail')) {
      const img = box.querySelector('img');
      if (!img) continue;
      const shown = media(img.getAttribute('data-src') || img.getAttribute('src'),base);
      const href = box.querySelector('a.fileThumb[href]')?.getAttribute('href');
      const asset = href ? media(href,base) : shown;
      if (!asset) badPages();
      add(asset,!href && /\/thumbnail\//.test(asset.pathname),shown);
    }
  } else {
    const detail = await api(base.origin,base.pathname,ctx), row = detail?.post ?? detail;
    if (!record(row) || row.service !== service || row.user !== user || row.id !== id) badPages();
    title = typeof row.title === 'string' && row.title.trim() || '#' + id;
    if (typeof row.content === 'string' && /<img\b/i.test(row.content)) inline(markup(row.content));
    for (const file of files(row)) {
      if (![file.path,file.name].some(s => typeof s === 'string' && imageName.test(s))) continue;
      if (file.temp_url) {add(media(file.temp_url,base) ?? badPages()); continue;}
      if (file.preview_only || file.deferred || row.has_full === false) continue;
      if (typeof file.path !== 'string' || !/^\/[\da-f]{2,3}\/[\da-f]{2}\/[\da-f]{64}\.[\w]+$/i.test(file.path)) badPages();
      const server = file.server ?? base.origin;
      if (typeof server !== 'string' || !URL.canParse(server) || new URL(server).origin !== server) badPages();
      add(media(`${server}/data${file.path}`,base) ?? badPages());
    }
  }
  if (!images.size) badPages();
  const items = await Promise.all([...images].map(async ([key,{url,preview}],order) => {
    const stable = /^[a-f\d]{64}$/i.test(key) ? key : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),
      n => n.toString(16).padStart(2,'0')).join('');
    return {id:(preview ? 'preview-' : 'file-') + stable, order, width:0, height:0, resource:{kind:'http' as const,url}};
  }));
  ctx.signal?.throwIfAborted();
  return {adapter:page.sourceId,url:page.url,title,direction:'ltr',discoveryComplete:true,knownTotal:items.length,
    note:items.some(i => i.id.startsWith('preview-')) ? '部分或全部图片为源站提供的预览图。' : '',items};
}
