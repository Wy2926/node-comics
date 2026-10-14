export const slug = 'sample-comic-digital';
export const url = `https://nhentai.com/es/comic/${slug}`;
export const reader = url + '/reader/2';
export const cover = 'https://cdn.nhentai.com/nhentai/storage/comics/123.jpg';
export const image = (page: number) => `https://cdn.nhentai.com/nhentai/storage/images/123/${page}.jpg`;
export const work = () => ({id: 123, slug, title: 'Sample Comic', pages: 3, chapters_count: 0});
export const catalogData = () => ({...work(), first_chapter: null, image_url: cover,
  language: {slug: 'japanese'}, category: {name: 'Doujinshi'}});
export const pagesData = () => ({comic: work(), chapter: null, next_chapter: null,
  images: [1, 2, 3].map(page => ({id: 100 + page, page, source_url: image(page),
    thumbnail_url: `https://cdn.nhentai.com/nhentai/storage/thumbnails/123/${page}.jpg`}))});
