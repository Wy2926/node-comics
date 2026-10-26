// Synthetic markup matching the verified public site's current static templates.
export const origin = 'https://readcomicsonline.ru';
export const workUrl = origin + '/comic/test-comic-2026';
export const readerUrl = workUrl + '/1';
export const title = 'Test Comic (2026-)';
export const cover = 'https://cdn.readcomicsonline.ru/uploads/manga/test-comic-2026/cover/cover_250x350.jpg?v=1';
export const image = 'https://cdn.readcomicsonline.ru/uploads/manga/test-comic-2026/chapters/1/01.jpg';
export const canonical = (url: string) => `<link rel="canonical" href="${url}">`;
export const row = (chapter: string, label = chapter) => `<a href="${workUrl}/${chapter}"><span class="font-medium">${title} <span class="text-brand-400">#${label}</span></span><span>20 Oct 2026</span></a>`;
export const catalog = `${canonical(workUrl)}<main><h1>${title}</h1><img src="${cover}" alt="${title}">
  <a href="${readerUrl}">Read First</a><section><h2>Chapters</h2><div class="divide-y">
  ${row('annual2026', 'Annual 2026')}${row('2')}${row('1.1', '1 Noir Edition')}${row('1')}
  </div></section></main>`;
export const selected = `<select class="js-chapter-select"><option value="${readerUrl}" selected>Chapter #1</option><option value="${workUrl}/1.1">Chapter #1 Noir Edition</option></select>`;
export const pages = `${canonical(readerUrl)}<main><nav aria-label="Breadcrumb"><a href="${origin}">Home</a><a href="${workUrl}">${title}</a></nav>
  ${selected}<select id="page-list"><option value="${readerUrl}/1">Page 1</option><option value="${readerUrl}/2">Page 2</option></select>
  <div id="reader-wrap"><img id="reader-img" src="${image}" alt="${title} #1 page 1"></div>
  <div id="reader-all"><img src="${image}" loading="lazy" alt="${title} #1 page 1"><img src="${image}" loading="lazy" alt="${title} #1 page 2">${selected}<a href="${workUrl}/1.1">Next Chapter</a></div></main>`;
export function searchHtml(total = 2, page = 1) {
  const cards = Array.from({length: Math.max(0, Math.min(60, total - (page - 1) * 60))}, (_, i) => {
    const slug = 'comic-' + ((page - 1) * 60 + i), title = 'Comic ' + i;
    return `<a class="group" href="${origin}/comic/${slug}"><div class="rc-cover"><img src="https://cdn.readcomicsonline.ru/uploads/manga/${slug}/cover/cover_250x350.jpg" alt="${title}"></div><p>${title}</p></a>`;
  }).join('');
  const next = page * 60 < total ? `<a rel="next" href="${origin}/advanced-search?name=Test&amp;page=${page + 1}">Next</a>` : '';
  const prev = page > 1 ? `<a rel="prev" href="${origin}/advanced-search?name=Test&amp;page=${page - 1}">Previous</a>` : '';
  return `<main><form><input name="name" value="Test"></form><h2>Search results <span>(${total})</span></h2>` +
    (total ? `<div class="grid grid-cols-3 md:grid-cols-6">${cards}</div>` : '<p>No comics match those filters.</p>') +
    (total > 60 ? `<nav aria-label="Pagination Navigation">${next}${prev}<span aria-current="page"><span>${page}</span></span>${next}</nav>` : '') + '</main>';
}
