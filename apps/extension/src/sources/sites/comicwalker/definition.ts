import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://comic-walker.com';
export const workCode = /^KC_\d{6}_S$/;
export const episodeCode = /^KC_\d{16}_E$/;
export const catalogUrl = (work: string) => `${origin}/detail/${work}`;
export const episodeUrl = (work: string, episode: string, type = 'first') => `${catalogUrl(work)}/episodes/${episode}?episodeType=${type}`;
export const catalogKey = (work: string) => `comicwalker:work:${work}`;
export const episodeKey = (episode: string) => `comicwalker:episode:${episode}`;
export function location(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const detail = /^\/detail\/(KC_\d{6}_S)(?:\/episodes(?:\/(KC_\d{16}_E))?)?\/?$/.exec(url.pathname);
  if (detail) return {work: detail[1], episode: detail[2]};
  const viewer = /^\/viewer\/(KC_\d{16}_E)\/?$/.exec(url.pathname);
  return viewer ? {work: undefined, episode: viewer[1]} : null;
}
export const definition: SourceDefinition = {
  id: 'comicwalker', name: 'ComicWalker',
  sites: [{id: 'comicwalker', name: 'カドコミ · ComicWalker', url: origin + '/', icon,
    adaptedOn: '2026-10-09', primaryLanguages: ['ja'], contentTags: ['manga'], search: true}],
  capabilities: {pages: true, inline: true, catalog: true, completePageList: true, importable: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720}, installation,
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    if (!loc) return {sourceId: this.id, pageKey: `${this.id}:${url.href}`, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.episode ? episodeKey(loc.episode) : catalogKey(loc.work!),
      kind: loc.episode ? 'reader' : 'catalog', url: url.href,
      ...(loc.work ? {catalog: {key: catalogKey(loc.work), url: catalogUrl(loc.work)}} : {})};
  },
};
