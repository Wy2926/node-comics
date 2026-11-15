import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://batcave.biz';
export interface BatcaveLocation {work: string; slug?: string; chapter?: string}
export function batcaveLocation(url: URL): BatcaveLocation | null {
  if (url.origin !== origin || url.username || url.password) return null;
  const work = /^\/([1-9]\d{0,11})-([a-zA-Z0-9_/-]{1,512})\.html$/.exec(url.pathname);
  if (work) return {work: work[1], slug: work[2]};
  const reader = /^\/reader\/([1-9]\d{0,11})\/([1-9]\d{0,11})\/?$/.exec(url.pathname);
  if (!reader) return null;
  const binding = /^#nodelane-batcave=([a-zA-Z0-9_/-]{1,512})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-batcave') && !binding) return null;
  return {work: reader[1], chapter: reader[2], slug: binding?.[1]};
}
export const catalogKey = (work: string) => 'batcave:' + work;
export const catalogUrl = (loc: BatcaveLocation) => `${origin}/${loc.work}-${loc.slug}.html`;
export const chapterKey = (loc: BatcaveLocation) => `${catalogKey(loc.work)}:chapter:${loc.chapter}`;
export const chapterUrl = (loc: BatcaveLocation) =>
  `${origin}/reader/${loc.work}/${loc.chapter}${loc.slug ? '#nodelane-batcave=' + loc.slug : ''}`;
export const definition: SourceDefinition = {
  id: 'batcave', name: 'BatCave', installation,
  sites: [{id: 'batcave', name: 'BatCave', url: origin + '/watched/', icon, primaryLanguages: ['en'],
    adaptedOn: '2026-11-15', pricing: 'free', isRaw: false, contentTags: ['western'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = batcaveLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'batcave:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.work),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      ...(loc.slug ? {catalog: {key: catalogKey(loc.work), url: catalogUrl(loc)}} : {})};
  },
};
