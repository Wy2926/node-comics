import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.sunday-webry.com';
export const seriesKey = (id: string) => `sundaywebry:series:${id}`;
export const episodeUrl = (id: string, series?: string) => `${origin}/episode/${id}${series ? '#nodelane-webry=' + series : ''}`;
// This site embeds the work directory below every episode; it has no /series/<id> page.
export const catalogUrl = (series: string, episode: string) => `${episodeUrl(episode)}#nodelane-webry-catalog=${series}`;
export function webryLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/episode\/([1-9]\d{0,24})\/?$/.exec(url.pathname);
  if (!match) return null;
  const binding = /^#nodelane-webry(-catalog)?=([1-9]\d{0,24})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-webry') && !binding) return null;
  return {episode: match[1], series: binding?.[2], catalog: !!binding?.[1]};
}
export const definition: SourceDefinition = {
  id: 'sundaywebry', name: 'Sunday Webry', installation,
  sites: [{id: 'sundaywebry', name: 'サンデーうぇぶり', url: origin + '/', icon,
    adaptedOn: '2026-09-27', contentTags: ['manga'], primaryLanguages: ['ja'], search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, catalog: true, pages: true, completePageList: true, inline: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = webryLocation(url);
    if (!loc) return {sourceId: this.id, kind: 'other', pageKey: this.id + ':' + url.href, url: url.href};
    return {sourceId: this.id, kind: loc.catalog ? 'catalog' : 'reader', url: url.href,
      pageKey: loc.catalog ? seriesKey(loc.series!) : 'sundaywebry:episode:' + loc.episode,
      ...(loc.series ? {catalog: {key: seriesKey(loc.series), url: catalogUrl(loc.series, loc.episode)}} : {})};
  },
};
