import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.00jf.com';
export interface JfLocation {comic: string; chapter?: string}
export function jfLocation(url: URL): JfLocation | null {
  if (url.origin !== origin || url.username || url.password) return null;
  const comic = /^\/comic_([1-9]\d{0,9})\.html$/.exec(url.pathname);
  if (comic) return {comic: comic[1]};
  const chapter = /^\/chapter_([1-9]\d{0,9})_([1-9]\d{0,9})\.html$/.exec(url.pathname);
  return chapter ? {comic: chapter[1], chapter: chapter[2]} : null;
}
export const catalogKey = (comic: string) => 'jf00:' + comic;
export const catalogUrl = (comic: string) => `${origin}/comic_${comic}.html`;
export const chapterKey = ({comic, chapter}: JfLocation) => `${catalogKey(comic)}:chapter:${chapter}`;
export const chapterUrl = ({comic, chapter}: JfLocation) => `${origin}/chapter_${comic}_${chapter}.html`;
export const definition: SourceDefinition = {
  id: 'jf00', name: '漫画猫 (00jf)', installation,
  sites: [{id: 'jf00', name: '漫画猫 (00jf)', url: origin + '/', icon, adaptedOn: '2026-10-02', contentTags: ['manhua', 'manhwa', 'manga'], primaryLanguages: ['zh-Hans'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = jfLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'jf00:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.comic),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.comic), url: catalogUrl(loc.comic)}};
  },
};
