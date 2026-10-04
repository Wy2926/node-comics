import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://comic-days.com';
export const seriesKey = (id: string) => `comicdays:series:${id}`;
export const catalogUrl = (series: string) => `${origin}/series/${series}/first_episode`;
export const episodeUrl = (id: string, series?: string) => `${origin}/episode/${id}${series ? '#nodelane-days=' + series : ''}`;
export function comicDaysEpisode(url: URL): string | undefined {
  if (url.origin !== origin || url.username || url.password) return;
  return /^\/episode\/([1-9]\d{0,24})\/?$/.exec(url.pathname)?.[1];
}
export function comicDaysLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const series = /^\/series\/([1-9]\d{0,24})\/first_episode\/?$/.exec(url.pathname)?.[1];
  if (series) return {series, catalog: true as const};
  const episode = comicDaysEpisode(url);
  if (!episode) return null;
  const binding = /^#nodelane-days=([1-9]\d{0,24})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-days') && !binding) return null;
  return {episode, series: binding?.[1], catalog: false as const};
}
export const definition: SourceDefinition = {
  id: 'comicdays', name: 'Comic DAYS', installation,
  sites: [{id: 'comicdays', name: 'Comic DAYS', url: origin + '/', icon,
    adaptedOn: '2026-10-03', contentTags: ['manga'], primaryLanguages: ['ja'], search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = comicDaysLocation(url);
    if (!loc) return {sourceId: this.id, kind: 'other', url: url.href, pageKey: this.id + ':' + url.href};
    return {sourceId: this.id, kind: loc.catalog ? 'catalog' : 'reader', url: url.href,
      pageKey: loc.catalog ? seriesKey(loc.series) : `comicdays:episode:${loc.episode}`,
      ...(loc.series ? {catalog: {key: seriesKey(loc.series), url: catalogUrl(loc.series)}} : {})};
  },
};
