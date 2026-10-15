/** Concrete sites own all URL identities, registration and resource policy. */
export interface MangaThemesiaLocation {catalogSlug?: string; chapterSlug?: string}
export interface MangaThemesiaSite {
  id: string;
  name: string;
  origin: string;
  direction: 'ltr' | 'rtl';
  location(url: URL): MangaThemesiaLocation | null;
  catalogKey(slug: string): string;
  catalogUrl(slug: string): string;
  chapterKey(slug: string): string;
  chapterUrl(slug: string, catalogSlug?: string): string;
  searchUrl(query: string, page: number): string;
  emptySearchText: string;
  imageUrl(value: unknown): string;
}
