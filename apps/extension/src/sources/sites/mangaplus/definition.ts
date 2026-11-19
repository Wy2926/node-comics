import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangaplus.shueisha.co.jp';
export const catalogUrl = (id: string) => `${origin}/titles/${id}`;
export const catalogKey = (id: string) => `mangaplus:title:${id}`;
export const chapterKey = (id: string) => `mangaplus:chapter:${id}`;
export function route(url: URL) {
  if (url.origin !== origin || url.username || url.password) return;
  const match = /^\/(titles|viewer)\/([1-9]\d{0,9})\/?$/.exec(url.pathname);
  if (!match || Number(match[2]) > 0xffffffff) return;
  const reader = match[1] === 'viewer', binding = /^#nodelane-mangaplus=([1-9]\d{0,9})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-mangaplus') && (!reader || !binding || Number(binding[1]) > 0xffffffff)) return;
  return {id: match[2], reader, title: reader ? binding?.[1] : match[2]};
}
export const definition: SourceDefinition = {
  id: 'mangaplus', name: 'MANGA Plus by SHUEISHA', installation,
  sites: [{id: 'mangaplus', name: 'MANGA Plus by SHUEISHA', url: origin + '/', icon, adaptedOn: '2026-11-19',
    pricing: 'freemium', isRaw: false, primaryLanguages: ['en', 'es', 'fr', 'id', 'pt-BR', 'th', 'de', 'vi'],
    contentTags: ['manga'], accessTags: ['partial-web']}],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = route(url);
    if (!loc) return {sourceId: this.id, kind: 'other', url: url.href, pageKey: this.id + ':' + url.href};
    return {sourceId: this.id, url: url.href, kind: loc.reader ? 'reader' : 'catalog',
      pageKey: loc.reader ? chapterKey(loc.id) : catalogKey(loc.id),
      ...(loc.title ? {catalog: {key: catalogKey(loc.title), url: catalogUrl(loc.title)}} : {})};
  },
};
