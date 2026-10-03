export const episodeUrl = (id = '11') => 'https://comic-days.com/episode/' + id;
export const imageUrl = 'https://cdn-img.comic-days.com/public/page/2/900-abcdef';
export const readerData = (id = '11') => ({readableProduct: {
  id, typeName: 'episode', title: 'テスト話', permalink: episodeUrl(id),
  pageStructure: {choJuGiga: 'baku', readingDirection: 'rtl', startPosition: 'latter',
    pages: [{type: 'main', width: 1125, height: 1600, src: imageUrl}, {type: 'link'},
      {type: 'main', width: 1125, height: 1600, src: imageUrl}, {type: 'backMatter'}]},
}});
