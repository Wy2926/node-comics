export const id = '12345';
export const mediaId = '67890';
export const url = `https://nhentai.to/g/${id}/`;
export const reader = url + '1/';
export const cover = `https://supercdn.site/galleries/${mediaId}/cover.webp`;
export const image = (page: number, extension = 'webp') => `https://supercdn.site/galleries/${mediaId}/${page}.${extension}`;
export const gallery = () => ({id: Number(id), media_id: mediaId, title: {pretty: 'Sample Gallery', english: 'Sample Gallery', japanese: ''},
  images: {pages: [1, 2, 3].map(() => ({t: 'w', w: 800, h: 1200})), cover: {t: 'w', w: 350, h: 525}},
  num_pages: 3, tags: [{type: 'language', name: 'english'}, {type: 'language', name: 'translated'}, {type: 'category', name: 'doujinshi'}]});
export function readerHtml(data = gallery(), page = 1) {
  const extension = ({j: 'jpg', p: 'png', g: 'gif', w: 'webp'} as Record<string, string>)[data.images.pages[page - 1]?.t] ?? 'webp';
  return `<!doctype html><html><head><link rel="canonical" href="${url}${page}/"></head><body>
    <section id="image-container"><a href="${url}${page + 1}/"><img src="${image(page, extension)}" class="fit-horizontal"></a></section>
    <aside><img src="https://ads.example/ignore.png"></aside>
    <script>N.init(); var reader = new N.reader({media_url: 'https://supercdn.site/',
      gallery: ${JSON.stringify(data).replace(/}$/, ',}')}, start_page: ${page}}); reader.set_page(${page}, false);</script>
    </body></html>`;
}
