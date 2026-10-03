import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';

export const origin = 'https://manga-one.com';
export function mangaOneChapter(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/manga\/([1-9]\d{0,9})\/chapter\/([1-9]\d{0,9})\/?$/.exec(url.pathname);
  return match ? {work: match[1], chapter: match[2]} : null;
}

export const definition: SourceDefinition = {
  id: 'mangaone', name: 'マンガワン', installation,
  capabilities: {pages: false, inline: true, catalog: false, completePageList: false},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const chapter = mangaOneChapter(url);
    return {sourceId: this.id, kind: chapter ? 'reader' : 'other', url: url.href,
      pageKey: chapter ? `mangaone:${chapter.work}:${chapter.chapter}` : this.id + ':' + url.href};
  },
};
