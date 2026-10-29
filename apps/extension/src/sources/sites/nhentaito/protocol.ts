import {SourceProtocolError} from '../../contracts/network';
import {attributes, inertHtml, tags} from '../../shared/html';
import {galleryLocation, maxPages, readerUrl} from './definition';

const invalid = (): never => {throw new SourceProtocolError('nHentai.to 页面不完整或作品归属无效，请检查源站页面。');};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) return invalid();
  return value as number;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value.trim();
}

/** Read the reader's JSON object, allowing only the observed trailing object comma. Never evaluate JavaScript. */
function galleryData(body: string) {
  let depth = 0, quoted = false, escaped = false;
  if (body[0] !== '{') return invalid();
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      let data: unknown;
      try {data = JSON.parse(body.slice(0, i + 1).replace(/,\s*}$/, '}'));} catch {return invalid();}
      const suffix = /^\s*,\s*start_page\s*:\s*([1-9]\d*)\s*}\s*\)\s*;/.exec(body.slice(i + 1));
      if (!suffix) return invalid();
      return {data: object(data), page: Number(suffix[1])};
    }
  }
  return invalid();
}
const extensions: Record<string, string> = {j: 'jpg', p: 'png', g: 'gif', w: 'webp'};
function image(value: unknown) {
  const data = object(value), type = text(data.t, 1);
  if (!Object.hasOwn(extensions, type)) return invalid();
  return {extension: extensions[type], width: positive(data.w, 100000), height: positive(data.h, 100000)};
}
const languages: Record<string, string> = {english: 'en', japanese: 'ja', chinese: 'zh'};

export function parseReader(html: string, url: string) {
  const loc = galleryLocation(new URL(url));
  if (!loc?.page) return invalid();
  const clean = inertHtml(html), canonical = tags(clean, 'link').filter(tag => tag.rel === 'canonical');
  if (canonical.length !== 1 || canonical[0].href !== readerUrl(loc.id, loc.page)) return invalid();
  const scripts = html.replace(/<!--[\s\S]*?-->|<(template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const readers = [...scripts.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].flatMap(match => {
    const attrs = attributes('script ' + match[1]);
    if (attrs.src || (attrs.type && !['text/javascript', 'application/javascript'].includes(attrs.type))) return [];
    const header = /^\s*N\.init\(\s*\)\s*;\s*var\s+reader\s*=\s*new\s+N\.reader\s*\(\s*\{\s*media_url\s*:\s*(['"])([^'"]+)\1\s*,\s*gallery\s*:\s*/.exec(match[2]);
    if (!header) return [];
    if (header[2] !== 'https://supercdn.site/') return invalid();
    return [{...galleryData(match[2].slice(header[0].length)), mediaUrl: header[2]}];
  });
  if (readers.length !== 1) return invalid();
  const {data, page, mediaUrl} = readers[0];
  if (String(positive(data.id)) !== loc.id || page !== loc.page) return invalid();
  const mediaId = text(data.media_id, 12), total = positive(data.num_pages, maxPages);
  if (!/^[1-9]\d*$/.test(mediaId) || loc.page > total) return invalid();
  const titleData = object(data.title), title = text(titleData.pretty || titleData.english || titleData.japanese);
  const images = object(data.images);
  if (!Array.isArray(images.pages) || images.pages.length !== total) return invalid();
  const base = `${mediaUrl}galleries/${mediaId}/`, cover = image(images.cover);
  const pages = images.pages.map((value, index) => {
    const page = image(value);
    return {width: page.width, height: page.height, url: `${base}${index + 1}.${page.extension}`};
  });
  // Bind the source's full-array recipe to the actual selected page, not thumbnails or recommendations.
  const containers = [...clean.matchAll(/<(?:section|div)\b[^>]*\bid=(["'])image-container\1[^>]*>([\s\S]*?)<\/(?:section|div)\s*>/gi)];
  const current = containers.length === 1 ? tags(containers[0][2], 'img') : [];
  if (current.length !== 1 || current[0].src !== pages[loc.page - 1].url) return invalid();
  if (!Array.isArray(data.tags) || data.tags.length > 500) return invalid();
  const labels = data.tags.map(object);
  const contentLanguages = [...new Set(labels.filter(tag => tag.type === 'language' && typeof tag.name === 'string'
    && Object.hasOwn(languages, tag.name)).map(tag => languages[tag.name as string]))];
  const categories = [...new Set(labels.filter(tag => tag.type === 'category').map(tag => text(tag.name, 180)))];
  return {id: loc.id, title, pages, cover: `${base}cover.${cover.extension}`, categories,
    contentLanguage: contentLanguages.length === 1 ? contentLanguages[0] : undefined};
}
