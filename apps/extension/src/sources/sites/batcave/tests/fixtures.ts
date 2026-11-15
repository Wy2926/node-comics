export const origin = 'https://batcave.biz';
export const workUrl = origin + '/101-test-comic.html';
export const readerUrl = origin + '/reader/101/501';
export const title = 'Test Comic (2026-)';
export const imageUrl = 'https://img.batcave.biz/img/1/101/501/1-abcdef.jpg?s=fixture';
export const catalogData = {
  news_id: 101, title, limit: 30,
  chapters: [
    {id: 503, posi: 3, pages: 0, title: title + ' #Annual 2026', broken: true},
    {id: 502, posi: 2, pages: 2, title: title + ' #1.1', broken: false},
    {id: 501, posi: 1, pages: 2, title: title + ' #1', broken: false},
  ],
};
export const readerData = {news_id: 101, chapter_id: 501, post_link: workUrl, post_title: title,
  images: [imageUrl, imageUrl, 'https://unrelated.example/trailing-ad.jpg'], pages: 2, broken: false, rdr_ajax: false};
export const script = (data: unknown) => `<script>window.__DATA__ = ${JSON.stringify(data)};</script>`;
export function catalog(data = catalogData) {
  return `<link rel="canonical" href="${workUrl}"><h1>${title}</h1>
    <div class="page__poster img-wide"><a><img src="/uploads/posts/hd/101.webp"></a></div>
    <li data-tab="chapters"><h2>Chapters (${data.chapters.length})</h2></li>${script(data)}`;
}
export function pages(data = readerData) {
  return `<link rel="canonical" href="${readerUrl}"><h1 class="chapter__selector-trigger__title">${title} #1</h1>
    ${script(data).replace('</script>', 'if(window.__DATA__.images&&window.__DATA__.pages<window.__DATA__.images.length)window.__DATA__.images.length=window.__DATA__.pages;</script>')}
    <img src="https://ads.example/advert.jpg">`;
}
export function searchHtml(total = 11, page = 1, query = 'Test') {
  const rows = Array.from({length: Math.max(0, Math.min(10, total - (page - 1) * 10))}, (_, i) => {
    const n = (page - 1) * 10 + i + 1, url = `${origin}/${n}-test-${n}.html`;
    return `<div class="readed d-flex short"><a href="${url}" class="readed__img"><img data-src="/uploads/mini/100x150/a/${n}.webp" src="data:image/gif;base64,x" alt="Comic ${n}"></a>
      <div><h2 class="readed__title"><a href="${url}">Comic ${n}</a></h2><a href="/reader/${n}/501">Read</a></div></div>`;
  }).join('');
  const last = Math.min(10, Math.ceil(total / 10));
  const pager = last > 1 ? `<div class="pagination__pages">${Array.from({length: last}, (_, i) => i + 1 === page ? `<span>${page}</span>` :
    `<a href="/search/${query}${i ? '/page/' + (i + 1) + '/' : ''}">${i + 1}</a>`).join('')}</div>` : '';
  return `<main id="main-content"><input id="searchinput" value="${query}"><div class="message-info">Your query found ${total} answers${total ?
    ` (Query results ${(page - 1) * 10 + 1} - ${Math.min(page * 10, total)})` : ''}:</div>${rows}${pager}</main>`;
}
