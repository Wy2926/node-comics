/** A packaged, explicitly registered site owns its identities, URLs and image policy. */
export interface MadaraLocation {slug: string; chapter?: string}
export interface MadaraSite {
  id: string;
  name: string;
  origin: string;
  direction: 'ltr' | 'rtl';
  /** Omitted when this site's search pagination has not been verified. */
  searchPageSize?: number;
  /** Default: numbered public HTML pages. AJAX uses the verified content-search template. */
  search?: 'ajax';
  /** Only the verified, complete manga-scoped AJAX chapter endpoint is supported. */
  catalog?: 'ajax';
  /** Default: chapter canonical, heading and static chapter select. */
  reader?: 'ajax-select' | 'ajax-breadcrumb' | 'catalog-select';
  location(url: URL): MadaraLocation | null;
  catalogKey(slug: string): string;
  catalogUrl(slug: string): string;
  chapterKey(location: MadaraLocation): string;
  chapterUrl(location: MadaraLocation): string;
  imageUrl(value: unknown): string;
}
