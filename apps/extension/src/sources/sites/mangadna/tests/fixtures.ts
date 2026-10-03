// Reduced markup follows the public catalog, reader and search response structures.
export const url = 'https://mangadna.com/manga/fixture';
export const reader = url + '/chapter-175-8-8';
export const cdn = 'https://cdn01.mangadna.com/uploads/7/175.88/';
const canonical = (value: string) => `<link rel="canonical" href="${value}">`;
export function catalogHtml(rows: Array<[string, string]> = [['chapter-175-8-8', 'Chapter 175.88'], ['chapter-0', 'Chapter 0']]) {
  return `${canonical(url)}<div class="post-title"><h1>Fixture &amp; Hero</h1></div>
    <div class="summary_image"><a href="${url}"><img src="https://mangadna.com/thumbnails/fixture-cover.jpg"></a></div>
    <div class="panel-manga-chapter" id="chapterlist"><h2>Latest Manga Releases</h2><ul class="row-content-chapter">
      ${rows.map(([chapter, title]) => `<li class="a-h myx01"><a class="chapter-name text-nowrap" href="${url}/${chapter}">${title}</a></li>`).join('')}
    </ul><div class="chapter-readmore"><span>Show more</span></div></div>
    <script>throw Error('Must never execute');</script><div class="relations-box"><a href="https://evil.test/manga/other">Other</a></div>`;
}
export function readerHtml(numbers = [1, 2], resources = numbers.map(number => cdn + number + '-abc.jpg')) {
  const navigation = '<select class="navi-change-chapter"><option data-c="chapter-175-8-8" selected>Chapter 175.88</option><option data-c="chapter-0">Chapter 0</option></select>';
  return `${canonical(reader)}<ol class="breadcrumb"><li><a href="/">Home</a></li>
    <li><a href="${url}">Fixture &amp; Hero</a></li><li><a class="active" href="${reader}">Chapter 175.88</a></li></ol>
    <h1>Fixture &amp; Hero - Chapter 175.88</h1>${navigation}<div class="read-content">
      ${numbers.map((number, index) => `<img class="loading myx01" data-src="${resources[index]}" src="${resources[index]}" alt="Fixture &amp; Hero - Chapter 175.88 Page ${number}" loading="lazy">`).join('')}
    </div>${navigation}<img src="https://evil.test/ad.jpg"><script><img src="https://evil.test/script.jpg"></script>`;
}
export function searchHtml(query = 'Hero', page = 1, empty = false) {
  return `<h1 class="boxtitle"><i></i>RESULTS FOR "${query}"</h1><div class="listupd">${empty ? `<p>No result for "${query}"</p>` : `
    <div class="home-item"><div class="hinner"><div class="hthumb"><a href="${url}"><img src="https://mangadna.com/thumbnails/fixture-cover.jpg"></a></div>
    <div class="hcontent"><h3 class="htitle"><a href="${url}">Fixture &amp; Hero</a></h3><div class="list-chapter"><a class="btn-link" href="${reader}">Chapter 175.88</a></div></div></div></div>`}</div>
    <div class="blog-pager">${empty ? '' : `<ul class="pagination"><li class="active"><a href="/search?q=${query}&amp;page=${page}">${page}</a></li>
    <li class="next"><a href="/search?q=${query}&amp;page=${page + 1}">&raquo;</a></li></ul>`}</div>`;
}
