import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';

export const origin = 'https://comic-days.com';
export function comicDaysEpisode(url: URL): string | undefined {
  if (url.origin !== origin || url.username || url.password) return;
  return /^\/episode\/([1-9]\d{0,24})\/?$/.exec(url.pathname)?.[1];
}
export const definition: SourceDefinition = {
  id: 'comicdays', name: 'Comic DAYS', installation,
  capabilities: {pages: false, inline: true, catalog: false, completePageList: false},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const episode = comicDaysEpisode(url);
    return {sourceId: this.id, kind: episode ? 'reader' : 'other', url: url.href,
      pageKey: episode ? `comicdays:episode:${episode}` : this.id + ':' + url.href};
  },
};
