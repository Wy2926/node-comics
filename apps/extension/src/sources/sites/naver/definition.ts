import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://comic.naver.com';
export const levels = {webtoon: 'WEBTOON', bestChallenge: 'BEST_CHALLENGE', challenge: 'CHALLENGE'} as const;
export type Section = keyof typeof levels;
export function naverLocation(url: URL) {
  if (url.protocol !== 'https:' || url.hostname !== 'comic.naver.com' || url.port || url.username || url.password) return null;
  const match = /^\/(webtoon|bestChallenge|challenge)\/(list|detail)$/.exec(url.pathname);
  const titleId = url.searchParams.get('titleId'), no = url.searchParams.get('no');
  const valid = (value: string | null): value is string => !!value && /^[1-9]\d{0,9}$/.test(value);
  if (!match || !valid(titleId) || url.searchParams.getAll('titleId').length !== 1 ||
    (match[2] === 'detail' ? !valid(no) || url.searchParams.getAll('no').length !== 1 : no !== null)) return null;
  return {section: match[1] as Section, titleId, no: match[2] === 'detail' ? no! : undefined};
}
export const catalogUrl = (titleId: string, section: Section) => `${origin}/${section}/list?titleId=${titleId}`;
export const episodeUrl = (titleId: string, no: number, section: Section) => `${origin}/${section}/detail?titleId=${titleId}&no=${no}`;
export const definition: SourceDefinition = {
  id: 'naver', name: 'NAVER Webtoon',
  sites: [{id: 'naver', name: 'NAVER Webtoon', url: origin + '/', icon}],
  capabilities: {importable: true, pages: true, inline: false, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720}, installation,
  identify(url) {
    if (url.protocol !== 'https:' || url.hostname !== 'comic.naver.com' || url.port || url.username || url.password) return null;
    const loc = naverLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    const key = 'naver:' + loc.section + ':' + loc.titleId;
    return {sourceId: this.id, pageKey: key + (loc.no ? ':episode:' + loc.no : ''),
      kind: loc.no ? 'reader' : 'catalog', url: url.href, catalog: {key, url: catalogUrl(loc.titleId, loc.section)}};
  },
};
