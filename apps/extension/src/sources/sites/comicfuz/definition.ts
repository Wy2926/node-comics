import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://comic-fuz.com';
export const validId = (value: string) => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 0xffffffff;
export const catalogKey = (manga: string) => `comicfuz:manga:${manga}`;
export const chapterKey = (chapter: string) => `comicfuz:chapter:${chapter}`;
export const catalogUrl = (manga: string) => `${origin}/manga/${manga}`;
export const chapterUrl = (manga: string, chapter: string) => `${catalogUrl(manga)}?chapterId=${chapter}`;
export function location(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/manga\/([1-9]\d{0,9})\/?$/.exec(url.pathname);
  if (!match || !validId(match[1])) return null;
  const chapters = url.searchParams.getAll('chapterId');
  if (chapters.length > 1 || chapters.length && !validId(chapters[0])) return null;
  return {manga: match[1], chapter: chapters[0]};
}
export const definition: SourceDefinition = {
  id: 'comicfuz', name: 'COMIC FUZ', installation,
  sites: [{id: 'comicfuz', name: 'COMIC FUZ', url: origin + '/', icon, adaptedOn: '2026-10-12', pricing: 'freemium', isRaw: true,
    primaryLanguages: ['ja'], contentTags: ['manga'], accessTags: ['login-required'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, completePageList: true, inline: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    if (!loc) return {sourceId: this.id, kind: 'other', pageKey: this.id + ':' + url.href, url: url.href};
    return {sourceId: this.id, kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      pageKey: loc.chapter ? chapterKey(loc.chapter) : catalogKey(loc.manga),
      catalog: {key: catalogKey(loc.manga), url: catalogUrl(loc.manga)}};
  },
};
