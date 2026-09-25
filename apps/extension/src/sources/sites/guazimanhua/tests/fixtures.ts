export const url = 'https://www.guazimanhua.com/comic.php?id=123';
export const reader = 'https://www.guazimanhua.com/chapter.php?id=11';
export const image = 'https://img.guazicdn.com/th/comics/chapters/10/260925/1_1.webp';
export function catalogHtml(ids = ['11', '7', '50'], total = ids.length) {
  return `<link rel="canonical" href="${url}">
    <script type="application/ld+json">${JSON.stringify({'@graph': [{'@type': 'ComicStory', url, name: 'Fixture comic', image: 'https://img.guazicdn.com/th/comics/cover/10/260925/cover.webp'}]})}</script>
    <script>throw Error('never execute')</script><img src="https://evil.test/recommendation.jpg">
    <div class="cinema-info"><h1 id="cinema-title">Fixture comic</h1><div class="hero-actions"></div></div>
    <div class="all-chapter-grid is-collapsed" data-chapter-list>${[...ids].reverse().map(id => `<a href="/chapter.php?id=${id}">Chapter ${id} &amp; title</a>`).join('')}</div>
    <p>章节总数：${total} 话</p>`;
}
export function readerHtml(images = [image, image]) {
  return `<link rel="canonical" href="${reader}">
    <script type="application/ld+json">${JSON.stringify({'@graph': [
      {'@type': 'Article', url: reader, headline: 'Fixture chapter', isPartOf: {'@type': 'ComicStory', url}},
      {'@type': 'ItemList', numberOfItems: images.length, itemListElement: images.slice(0, 20).map((url, i) => ({'@type': 'ListItem', position: i + 1, item: {'@type': 'ImageObject', url}}))},
    ]})}</script><img id="page-99" src="https://evil.test/ad.jpg">
    <section class="reader-images" data-reader-images>${images.map((url, i) => `<img class="reading-image" id="page-${i + 1}" data-page="${i + 1}" src="${url}">`).join('')}</section>
    <section class="reader-finish"><div class="reader-finish-actions"></div></section>`;
}
