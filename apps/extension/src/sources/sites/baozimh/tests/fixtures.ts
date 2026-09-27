import {catalogUrl, chapterUrl, type BaoLocation} from '../definition';

export const comic = 'example-author', url = catalogUrl(comic);
export const loc: BaoLocation = {comic, section: '0', chapter: '0', part: 1};
export const reader = chapterUrl(loc);
export const image = 'https://s1.bzcdn.net/scomic/example-author/0/0-abcd/1.jpg';
export const cover = 'https://static-tw.baozimh.com/cover/example-author.jpg';
export const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export function catalogHtml(count = 27) {
  const links = Array.from({length: count}, (_, i) => `<div class="comics-chapters"><a class="comics-chapters__item" href="/user/page_direct?comic_id=${comic}&amp;section_slot=0&amp;chapter_slot=${i}"><div><span>${i === 1 ? '第01卷' : '第' + (i + 1) + '话'}</span></div></a></div>`);
  return `<!doctype html><html><head><link rel="canonical" href="${url}"></head><body>
    <div class="de-info__box"><amp-img src="${cover}"></amp-img><h1 class="comics-detail__title">Bao fixture &amp; work</h1></div>
    <div class="l-box"><div class="section-title">最新章节</div><div class="pure-g">${links.slice(-24).reverse().join('')}</div>${count > 24 ? `<div class="section-title">章节目录</div><div id="chapter-items">${links.slice(0, 24).join('')}</div><div id="chapters_other_list" hidden="hidden">${links.slice(24).join('')}</div><button id="button_show_all_chatper">查看全部${count}章节</button>` : ''}</div>
    </body></html>`;
}
export function readerHtml(part = 1, total = 2, chapter = '0') {
  const location = {...loc, chapter};
  const name = '第1话' + (total > 1 ? `(${part}/${total})` : '');
  const images = [image, image, image].map((src, i) => `<amp-img class="comic-contain__item" id="chapter-img-0-${i}" src="${src}" width="800" height="1200">
    <noscript><img src="${src}"></noscript><img amp-img-id="chapter-img-0-${i}" src="${src}"></amp-img>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="canonical" href="${chapterUrl(location, part)}"></head><body>
    <div class="header"><a class="btns goto" href="${url}">目录</a><span class="title">${name}</span></div>
    <ul class="comic-contain">${images}</ul><img src="https://ads.invalid/banner.jpg">
    <a id="next-chapter" href="${part < total ? chapterUrl(location, part + 1) : chapterUrl({...location, chapter: String(Number(chapter) + 1)})}">${part < total ? '下一页' : '下一话'}</a></body></html>`;
}
export function searchHtml(query = 'fixture', count = 1) {
  const cards = Array.from({length: count}, (_, i) => {
    const id = i ? `example-${i}` : comic;
    return `<div class="comics-card"><a class="comics-card__poster" href="/comic/${id}"><amp-img src="https://static-tw.baozimh.com/cover/${id}.jpg"><amp-img src="https://static-tw.baozimh.com/cover/default_cover.png" fallback></amp-img></amp-img></a>
      <a class="comics-card__info" href="/comic/${id}"><div><h3 class="text-truncate">${i ? 'Work ' + i : 'Bao fixture &amp; work'}</h3></div><small class="tags">Author &amp; Co</small></a></div>`;
  });
  return `<input name="q" value="${escape(query)}"><div class="keyword-hinter"><span>"${escape(query)}"</span><span>相近搜索结果(${count})</span></div><div class="classify-items">${cards.join('')}</div>`;
}
