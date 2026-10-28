import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://zebrack-comic.shueisha.co.jp';
export const validId = (id: string) => /^[1-9]\d{0,9}$/.test(id) && Number(id) <= 0xffffffff;
export const catalogKey = (title: string) => `zebrack:title:${title}`;
export const chapterKey = (title: string, chapter: string) => `${catalogKey(title)}:chapter:${chapter}`;
export const catalogUrl = (title: string) => `${origin}/title/${title}`;
export const chapterUrl = (title: string, chapter: string) => `${catalogUrl(title)}/chapter/${chapter}/viewer`;
export function location(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/title\/([1-9]\d{0,9})(?:\/chapter\/(?:list|([1-9]\d{0,9})\/viewer))?\/?$/.exec(url.pathname);
  return match && validId(match[1]) && (!match[2] || validId(match[2])) ? {title: match[1], chapter: match[2]} : null;
}
export const definition: SourceDefinition = {
  id: 'zebrack', name: 'ゼブラック · Zebrack', installation,
  sites: [{id: 'zebrack', name: 'ゼブラック · Zebrack', url: origin + '/', icon, adaptedOn: '2026-10-12', pricing: 'freemium', isRaw: true, isAdult: false,
    primaryLanguages: ['ja'], contentTags: ['manga'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, completePageList: true, inline: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    if (!loc) return {sourceId: this.id, kind: 'other', pageKey: `${this.id}:${url.href}`, url: url.href};
    return {sourceId: this.id, kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      pageKey: loc.chapter ? chapterKey(loc.title, loc.chapter) : catalogKey(loc.title),
      catalog: {key: catalogKey(loc.title), url: catalogUrl(loc.title)}};
  },
};
