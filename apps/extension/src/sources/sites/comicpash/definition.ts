import installation from './installation.json';
import type { SourceDefinition } from '../../contracts/definition';
export const origin = 'https://comicpash.jp';
export function comicpashLocation(url: URL) {
  if (url.protocol !== 'https:' || !['comicpash.jp', 'www.comicpash.jp'].includes(url.hostname) ||
    url.port || url.username || url.password) return null;
  const series = /^\/series\/([a-zA-Z0-9]+)(?:\/(?:[1-9]\d*|new|old))?\/?$/.exec(url.pathname);
  if (series) return {seriesId: series[1], episodeId: undefined};
  const episode = /^\/episodes\/([a-zA-Z0-9]+)(?:\/(?:[1-9]\d*|new|old))?\/?$/.exec(url.pathname);
  if (!episode) return null;
  // Episode paths lack series identity. Verify this local binding against reader HTML.
  const binding = /^#nodelane-comicpash=([a-zA-Z0-9]+)$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-comicpash') && !binding) return null;
  return {seriesId: binding?.[1], episodeId: episode[1]};
}
export const catalogUrl = (id: string) => `${origin}/series/${id}`;
export const episodeUrl = (id: string, series?: string) => `${origin}/episodes/${id}${series ? '#nodelane-comicpash=' + series : ''}`;
export const definition: SourceDefinition = {
  id: 'comicpash',
  name: 'Comic PASH!',
  sites: [{ id: 'comicpash', name: 'Comic PASH!', url: 'https://comicpash.jp/', icon: '/site-icons/comicpash.svg' }],
  capabilities: { importable: true, pages: true, inline: true, catalog: true, completePageList: true },
  catalogSync: {intervalMinutes: 720},
  installation,
  identify(url) {
    if (url.protocol !== 'https:' || !['comicpash.jp', 'www.comicpash.jp'].includes(url.hostname) ||
      url.port || url.username || url.password) return null;
    const loc = comicpashLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    const key = loc.seriesId && 'comicpash:series:' + loc.seriesId;
    return {sourceId: this.id, pageKey: loc.episodeId ? 'comicpash:episode:' + loc.episodeId : key!,
      kind: loc.episodeId ? 'reader' : 'catalog', url: url.href,
      ...(key ? {catalog: {key, url: catalogUrl(loc.seriesId!)}} : {})};
  },
};
