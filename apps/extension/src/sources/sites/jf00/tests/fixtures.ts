export const url = 'https://www.00jf.com/comic_123.html';
export const reader = 'https://www.00jf.com/chapter_123_11.html';
export const image = 'https://manhua.5um.net/colatj/fixture/1/one.webp';
export const title = 'Work & with - punctuation';
export function catalogHtml(ids = ['11', '7', '50']) {
  return `<link rel="canonical" href="${url}"><div class="comic-cover-large"><img src="https://comic.5um.net/comic/cover/fixture.webp"></div>
    <div class="comic-meta-info"><h1>Work &amp; with - punctuation</h1></div><div class="chapter-section">
    <div class="chapter-list" id="chapter-list">${ids.map(id => `<div class="chapter-item"><a href="/chapter_123_${id}.html">Chapter ${id} &amp; title</a></div>`).join('')}</div></div>`;
}
export function breadcrumb() {
  return JSON.stringify({'@type': 'BreadcrumbList', itemListElement: [
    {'@type': 'ListItem', position: 1, name: 'Site', item: 'www.00jf.com'},
    {'@type': 'ListItem', position: 2, name: title, item: 'www.00jf.com/comic_123.html'},
    {'@type': 'ListItem', position: 3, name: 'Chapter 11', item: 'www.00jf.com/chapter_123_11.html'},
  ]});
}
export function readerHtml(images = [image, image]) {
  return `<link rel="canonical" href="www.00jf.com/chapter_123_11.html">
    <script type="application/ld+json">${breadcrumb()}</script>
    <div class="comic-content">${images.map((src, i) => `<img class="comic-image" src="${src}" alt="Work &amp; with - punctuation - Chapter 11 - 第${i + 1}张图">`).join('')}</div>
    <script>$(function(){readPic(123,11,0,0);});</script>`;
}
export function searchHtml(query = 'Work', total = 2, page = 1) {
  const start = (page - 1) * 30, count = Math.min(30, Math.max(0, total - start));
  const target = (n: number) => `/search/${encodeURIComponent(query)}${n > 1 ? '/' + n : ''}`;
  return `<div class="comic-section"><h2>“${query}”搜索结果</h2><div class="page-info">共${total}部漫画</div><div class="comic-list">
    ${Array.from({length: count}, (_, i) => `<div class="comic-item"><a class="comic-cover" href="/comic_${start + i + 1}.html"><img src="https://comic.5um.net/comic/cover/${i}.webp" alt="Work ${i} long title"></a>
      <h3><a href="/comic_${start + i + 1}.html" title="Work ${i} long title">Work ${i}...</a></h3><p class="comic-author">Author ${i}</p></div>`).join('')}
    </div><div class="pagination"><a class="on" href="${target(page)}">${page}</a>${page * 30 < total ? `<a class="next" href="${target(page + 1)}">Next</a>` : ''}</div></div>`;
}
