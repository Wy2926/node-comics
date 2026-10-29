import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://weloma.net';
export const isOrigin = (url: URL) => url.origin === origin && !url.username && !url.password;
export interface WelomaLocation {work?: string; chapter?: string}
export function welomaLocation(url: URL): WelomaLocation | null {
  if (!isOrigin(url) || url.search) return null;
  const match = /^\/(m|c)\/([A-Za-z0-9]{1,64})\/?$/.exec(url.pathname);
  if (!match) return null;
  if (match[1] === 'm') return url.hash ? null : {work: match[2]};
  const binding = /^#nodelane-weloma=([A-Za-z0-9]{1,64})$/.exec(url.hash);
  if (url.hash && !binding) return null;
  return {chapter: match[2], ...(binding ? {work: binding[1]} : {})};
}
export const catalogKey = (work: string) => 'weloma:manga:' + work;
export const chapterKey = (chapter: string) => 'weloma:chapter:' + chapter;
export const catalogUrl = (work: string) => `${origin}/m/${work}`;
export const chapterUrl = (chapter: string, work?: string) => `${origin}/c/${chapter}${work ? '#nodelane-weloma=' + work : ''}`;
export const definition: SourceDefinition = {
  id: 'weloma', name: 'WeLoMa', installation,
  sites: [{id: 'weloma', name: 'WeLoMa', url: origin + '/', icon, adaptedOn: '2026-10-15',
    pricing: 'free', contentTags: ['manga'], isRaw: true, primaryLanguages: ['ja'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = welomaLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc.chapter) : catalogKey(loc.work!),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      ...(loc.work ? {catalog: {key: catalogKey(loc.work), url: catalogUrl(loc.work)}} : {})};
  },
};
