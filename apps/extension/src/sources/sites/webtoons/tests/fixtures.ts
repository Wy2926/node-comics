export const catalogUrl = 'https://www.webtoons.com/en/canvas/fixture/list?title_no=7';
export const episodeUrl = (no = 1) => `https://www.webtoons.com/en/canvas/fixture/episode-${no}/viewer?title_no=7&episode_no=${no}`;
export const image = 'https://webtoon-phinf.pstatic.net/20260927_1/page.jpg';
export const metadata = (url: string) => `<meta property="og:url" content="${url}"><meta property="og:title" content="WEBTOON fixture"><meta property="og:image" content="${image}">`;
export const catalogHtml = () => metadata(catalogUrl) + '<div class="detail_header"><div class="info">WEBTOON fixture</div></div>';
export const episodePage = (ids = [1, 2, 3], nextCursor = 0) => ({success: true, result: {
  episodeList: ids.map(no => ({episodeNo: no, episodeTitle: `Episode ${no}`, viewerLink: episodeUrl(no).replace('https://www.webtoons.com', '')})), nextCursor}});
export const readerHtml = (no = 1) => metadata(episodeUrl(no)) + `<div id="toolbar"><div class="subj_info">WEBTOON fixture</div></div><div id="_imageList">` +
  [0, 1, 2].map(() => `<img class="_images" data-url="${image}" src="${image}" width="800" height="1200">`).join('') + '</div>';
export const mobileCatalogHtml = `<meta property="og:url" content="https:///en/canvas/fixture/list?title_no=7"><meta property="og:title" content="">
  <link rel="canonical" href="${catalogUrl}"><div class="detail_info_wrap"><div class="info_area"><strong class="subject">WEBTOON fixture</strong></div></div>
  <ul class="detail_list_wrap _titleHomeEpisodeList"></ul>`;
export const mobileReaderHtml = (no = 1) => metadata(episodeUrl(no)) + `<header id="header"><h1 class="h1_viewer">Episode ${no}</h1></header>
  <div id="_viewer"><div class="_imageWrap"><img class="_checkVisible" src="${image}" width="800" height="1200"></div></div>`;
export const searchHtml = (section = 'canvas', query = 'fixture') => `<a href="/en/search/${section}?keyword=${query}" aria-current="page">${section}</a>` +
  (section === 'canvas' ? `<a class="_card_item" data-title-no="7" href="${catalogUrl}"><div><img src="${image}"></div><div class="info_text"><strong class="title">WEBTOON fixture</strong><div class="author">Author</div></div></a>` : '');
export function commentsPage(pageId: string, more = false) {
  const rows = (more ? ['b'] : ['d','c']).map(suffix => {
    const id = `GW-epicom:0-${pageId}-${suffix}`;
    return {id, rootId:id, pageId, status:'SERVICE', bodyFormat:{type:'PLAIN'}, createdBy:{name:`Reader ${suffix}`},
      createdAt:1700000000000, body:`Comment ${pageId}/${suffix}`, settings:{spoilerFilter:suffix === 'c' ? 'ON' : 'OFF'}};
  });
  return {status:'success', result:{posts:rows, pagination:{next:more ? null : rows.at(-1)!.id}}};
}
