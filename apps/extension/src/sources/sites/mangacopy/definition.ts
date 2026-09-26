import installation from './installation.json';
import type { SourceDefinition } from '../../contracts/definition';
export const MANGACOPY_DOMAINS = ['mangacopy.com', 'copy4000.com'];
export function isMangaCopyUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password &&
      MANGACOPY_DOMAINS.some((host) => u.hostname === host || u.hostname.endsWith('.' + host))
    );
  } catch {
    return false;
  }
}
export function mangaCopyLocation(value: string): { slug: string; chapterId?: string } | null {
  try {
    const u = new URL(value);
    if (!isMangaCopyUrl(value)) return null;
    const m = u.pathname.match(/^\/comic\/([a-zA-Z0-9_-]+)(?:\/chapter\/([a-f0-9-]{36}))?\/?$/);
    return m ? { slug: m[1], chapterId: m[2] } : null;
  } catch {
    return null;
  }
}
export const definition: SourceDefinition = {
  id: 'mangacopy',
  name: 'MangaCopy',
  sites: [
    { id: 'copy4000', name: '拷贝漫画', url: 'https://www.copy4000.com/', icon: '/site-icons/mangacopy.svg', primaryLanguages: ['zh-Hans'] },
    { id: 'mangacopy', name: 'MangaCopy', url: 'https://www.mangacopy.com/', icon: '/site-icons/mangacopy.svg', primaryLanguages: ['zh-Hans'] },
  ],
  capabilities: { importable: true, pages: true, inline: true, catalog: true, completePageList: true },
  catalogSync: { intervalMinutes: 720 },
  installation,
  identify(url) {
    if (!isMangaCopyUrl(url.href)) return null;
    const loc = mangaCopyLocation(url.href);
    if (!loc) return { sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href };
    const key = `mangacopy:${loc.slug}`;
    return {
      sourceId: this.id,
      pageKey: key + (loc.chapterId ? ':' + loc.chapterId : ''),
      kind: loc.chapterId ? 'reader' : 'catalog',
      url: url.href,
      catalog: { key, url: new URL('/comic/' + loc.slug, url).href },
    };
  },
};
