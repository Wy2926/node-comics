/** Lightweight work metadata from a site's current document, never a chapter title. */
export interface SourceWorkReference {
  title:string;
  catalogId:string;
  catalogUrl:string;
  cover?:{url:string};
}
export interface SourceSearchSeed {
  title:string;
  sourceName?:string;
  origin?:{sourceId:string;catalogId:string;url:string};
  cover?:{url:string};
}
