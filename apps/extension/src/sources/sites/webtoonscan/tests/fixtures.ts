// Sanitized source structure, with original fixture titles and no copied comic artwork.
export const origin = 'https://webtoonscan.com', slug = 'sample-book', title = 'WebtoonScan fixture';
export const url = `${origin}/manhwa/${slug}/`, reader = url + 'chapter-1/';
export const artwork = `${origin}/wp-content/uploads/2026/01/fixture.jpg`;
export const image = 'https://cdn4.webtoonscan.cc/sample-book-42/chapter-1/1.jpg';
export const canonical = (value: string) => `<link rel="canonical" href="${value}">`;
export const chapter = (id: string) => `<li class="wp-manga-chapter"><a href="${url}${id}/">${id}</a><span class="chapter-release-date">2026</span></li>`;
export const poster = (owner = url) => `<a href="${owner}"><img src="${artwork}"></a>`;
export function catalogHtml(ids = ['chapter-2.5', 'chapter-1', '0']) {
  return `${canonical(url)}<h1>${title}</h1><div class="summary_image">${poster()}</div>
    <div class="listing-chapters_wrap show-more"><ul class="main version-chap no-volumn active">${ids.map(chapter).join('')}</ul></div>`;
}
export function readerHtml(images = [image, image], id = 'chapter-1') {
  const target = url + id + '/';
  return `${canonical(target)}<h1 id="chapter-heading">${title} - ${id}</h1>
    <select class="single-chapter-select"><option value="${id}" data-redirect="${target}" selected="selected">${id}</option></select>
    <div class="reading-content"><input id="wp-manga-current-chap" data-id="42" value="${id}">
    ${images.map((src, i) => `<div class="page-break no-gaps"><img id="image-${i}" class="wp-manga-chapter-img" src="\n\t${src}"></div>`).join('')}</div>`;
}
export function searchHtml(total = 1, page = 1, query = 'sample') {
  const input = `<input class="search-field" name="s" value="${query}">`;
  if (!total) return input + '<p>No matches found. Try a different search...</p>';
  const cards = Array.from({length: Math.min(20, total - (page - 1) * 20)}, (_, i) => {
    const work = `${origin}/manhwa/sample-${(page - 1) * 20 + i}/`;
    return `<div class="row c-tabs-item__content"><div class="tab-thumb">${poster(work)}</div>
      <div class="tab-summary"><div class="post-title"><h3><a href="${work}">Sample &amp; Book ${i}</a></h3></div></div></div>`;
  });
  const pager = total > 20 ? `<div class="wp-pagenavi"><span class="current">${page}</span>${page * 20 < total
    ? `<a rel="next" href="${origin}/page/${page + 1}/?s=${query}&amp;post_type=wp-manga">Next Page</a>` : ''}</div>` : '';
  return `${input}<h1 class="h4">${total} results for "${query}"</h1>${cards.join('')}${pager}`;
}
