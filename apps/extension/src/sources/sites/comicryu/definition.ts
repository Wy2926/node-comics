import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://comic-ryu.jp';
export const catalogUrl = (id: string) => `${origin}/series/${id}`;
export const episodeUrl = (id: string, series?: string) => `${origin}/episodes/${id}${series ? '#nodelane-comicryu=' + series : ''}`;
export function comicryuLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const series = /^\/series\/([a-zA-Z0-9]+)(?:\/(?:[1-9]\d*|new|old))?\/?$/.exec(url.pathname);
  if (series) return {seriesId: series[1], episodeId: undefined};
  const episode = /^\/episodes\/([a-zA-Z0-9]+)(?:\/(?:[1-9]\d*|new|old))?\/?$/.exec(url.pathname);
  if (!episode) return null;
  const binding = /^#nodelane-comicryu=([a-zA-Z0-9]+)$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-comicryu') && !binding) return null;
  return {seriesId: binding?.[1], episodeId: episode[1]};
}
export const definition: SourceDefinition = {
  id: 'comicryu', name: 'COMIC リュウ', installation,
  sites: [{id: 'comicryu', name: 'COMIC リュウ', url: origin + '/', icon, adaptedOn: '2026-10-15',
    pricing: 'freemium', isRaw: true, isAdult: false, contentTags: ['manga'], primaryLanguages: ['ja'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = comicryuLocation(url);
    if (!loc) return {sourceId: this.id, kind: 'other', url: url.href, pageKey: this.id + ':' + url.href};
    const key = loc.seriesId && 'comicryu:series:' + loc.seriesId;
    return {sourceId: this.id, kind: loc.episodeId ? 'reader' : 'catalog', url: url.href,
      pageKey: loc.episodeId ? 'comicryu:episode:' + loc.episodeId : key!,
      ...(key ? {catalog: {key, url: catalogUrl(loc.seriesId!)}} : {})};
  },
};
