export const user = {userId: '7', name: 'Pixiv fixture'};
export const tag = '二創';
export const imageUrl = (id = '101', page = 0) => `https://i.pximg.net/img-original/img/2026/09/01/12/00/00/${id}_p${page}.png`;
export const work = (id = '101', overrides: Record<string, unknown> = {}) => ({id, userId: user.userId, title: `作品 ${id}`,
  illustType: 0, tags: [tag], pageCount: 3, isMasked: false, seriesId: undefined as string | undefined, ...overrides});
export const detail = (id = '101', overrides: Record<string, unknown> = {}) => ({...work(id), tags: {tags: [{tag}]}, ...overrides});
export const pages = (id = '101') => [0, 1, 2].map(page => ({urls: {original: imageUrl(id, page)}, width: 800, height: 1200}));
export const response = (body: unknown) => JSON.stringify({error: false, message: '', body});
export function fixtureBody(url: string, rows = [work('101', {seriesId: '9'}), work('102', {illustType: 1, seriesId: '9'}), work('103', {tags: ['other']})]) {
  const target = new URL(url), path = target.pathname;
  if (path === '/ajax/user/7') return user;
  if (path.endsWith('/profile/all')) return {illusts: Object.fromEntries(rows.filter(row => row.illustType !== 1).map(row => [row.id, null])),
    manga: Object.fromEntries(rows.filter(row => row.illustType === 1).map(row => [row.id, null]))};
  if (path.endsWith('/profile/illusts')) return {works: Object.fromEntries(rows.filter(row => target.searchParams.getAll('ids[]').includes(row.id)).map(row => [row.id, row]))};
  const category = /\/(illustmanga|illusts|manga)\/tag$/.exec(path)?.[1];
  if (category) {
    const tagged = rows.filter(row => row.tags.includes(target.searchParams.get('tag')!) &&
      (category === 'illustmanga' || (row.illustType === 1) === (category === 'manga'))).reverse(), offset = Number(target.searchParams.get('offset'));
    return {total: tagged.length, works: tagged.slice(offset, offset + 48)};
  }
  const seriesId = /^\/ajax\/series\/(\d+)$/.exec(path)?.[1];
  if (seriesId) {
    const members = rows.filter(row => row.seriesId === seriesId), total = members.length, offset = (Number(target.searchParams.get('p')) - 1) * 12;
    const positions = members.map((row, i) => ({workId: row.id, order: i + 1})).reverse().slice(offset, offset + 12);
    return {page: {seriesId: Number(seriesId), total, series: positions, isSetCover: false},
      illustSeries: [{id: '99', userId: '8', title: 'Other series', total: 1}, {id: seriesId, userId: user.userId, title: 'Series fixture',
        total, updateDate: '2026-09-01', firstIllustId: members[0]?.id, latestIllustId: members.at(-1)?.id}],
      thumbnails: {illust: [...members.filter(row => positions.some(p => p.workId === row.id)).reverse(), work('999', {seriesId: '99', userId: '8'})]}};
  }
  const artwork = /^\/ajax\/illust\/(\d+)(\/pages)?$/.exec(path);
  if (artwork) {
    const row = rows.find(row => row.id === artwork[1]);
    return artwork[2] ? pages(artwork[1]) : detail(artwork[1], {...row,
      seriesNavData: row?.seriesId ? {seriesId: row.seriesId, order: rows.filter(r => r.seriesId === row.seriesId).findIndex(r => r.id === row.id) + 1} : null,
      tags: {tags: (row?.tags ?? [tag]).map(tag => ({tag}))}});
  }
  throw Error('Unexpected fixture request: ' + path);
}
