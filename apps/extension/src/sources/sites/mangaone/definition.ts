import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://manga-one.com';
export const validId = (value: string) => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 0xffffffff;
export const catalogKey = (work: string) => `mangaone:${work}`;
export const chapterKey = (work: string, chapter: string) => `${catalogKey(work)}:${chapter}`;
// The site has no /manga/<id> detail page; its first-chapter route is the work entry.
export const catalogUrl = (work: string) => `${origin}/manga/${work}/chapter/first`;
export const chapterUrl = (work: string, chapter: string) => `${origin}/manga/${work}/chapter/${chapter}`;
export function location(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/manga\/([1-9]\d{0,9})\/chapter\/(first|[1-9]\d{0,9})\/?$/.exec(url.pathname);
  return match && validId(match[1]) && (match[2] === 'first' || validId(match[2]))
    ? {work: match[1], chapter: match[2] === 'first' ? undefined : match[2]} : null;
}
export const definition: SourceDefinition = {
  id: 'mangaone', name: 'マンガワン', installation,
  sites: [{id: 'mangaone', name: 'マンガワン · Manga One', url: origin + '/', icon, adaptedOn: '2026-10-03', pricing: 'freemium', isRaw: true,
    primaryLanguages: ['ja'], contentTags: ['manga'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    if (!loc) return {sourceId: this.id, kind: 'other', url: url.href, pageKey: this.id + ':' + url.href};
    return {sourceId: this.id, kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      pageKey: loc.chapter ? chapterKey(loc.work, loc.chapter) : catalogKey(loc.work),
      catalog: {key: catalogKey(loc.work), url: catalogUrl(loc.work)}};
  },
};
