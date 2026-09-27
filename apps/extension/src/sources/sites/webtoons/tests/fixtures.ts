export const catalogUrl = 'https://www.webtoons.com/en/canvas/fixture/list?title_no=7';
export const episodeUrl = (no = 1) => `https://www.webtoons.com/en/canvas/fixture/episode-${no}/viewer?title_no=7&episode_no=${no}`;
export const image = 'https://webtoon-phinf.pstatic.net/20260927_1/page.jpg';
export const metadata = (url: string) => `<meta property="og:url" content="${url}"><meta property="og:title" content="WEBTOON fixture"><meta property="og:image" content="${image}">`;
export function catalogHtml(page = 1, ids = page === 1 ? [3, 2] : [1], last = 2) {
  return metadata(catalogUrl) + `<div class="detail_header"><div class="info">WEBTOON fixture</div></div><ul id="_listUl">` + ids.map(no =>
    `<li class="_episodeItem" data-episode-no="${no}"><a href="${episodeUrl(no)}"><span class="subj"><span>Episode ${no}</span></span></a></li>`).join('') +
    `</ul><div class="paginate"><a href="#" aria-current="true">${page}</a>` + Array.from({length: last}, (_, i) => i + 1).filter(n => n !== page)
      .map(n => `<a href="${catalogUrl}&page=${n}" class=pg_page>${n}</a>`).join('') + '</div>';
}
export const readerHtml = (no = 1) => metadata(episodeUrl(no)) + `<div id="toolbar"><div class="subj_info">WEBTOON fixture</div></div><div id="_imageList">` +
  [0, 1, 2].map(() => `<img class="_images" data-url="${image}" src="${image}" width="800" height="1200">`).join('') + '</div>';
export const searchHtml = (section = 'canvas', query = 'fixture') => `<a href="/en/search/${section}?keyword=${query}" aria-current="page">${section}</a>` +
  (section === 'canvas' ? `<a class="_card_item" data-title-no="7" href="${catalogUrl}"><div><img src="${image}"></div><div class="info_text"><strong class="title">WEBTOON fixture</strong><div class="author">Author</div></div></a>` : '');
