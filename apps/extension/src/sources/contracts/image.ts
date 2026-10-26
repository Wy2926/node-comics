/** Image transport/decoding is independent of how a site discovers its directory or pages. */
export interface SourceImageAdapter {
  /** Explicitly verified public images only: Safari native GET has no source cookies. */
  safariTransport?: 'public-native';
  /** Catalog/search artwork only: read bytes in the exact image document's browser session. */
  coverTransport?: 'page';
  /** Extension reader/search image requests only; inline images retain the live page policy. */
  readerReferrerPolicy?: ReferrerPolicy;
  /** Dynamic headers receive only the already authorized image URL. */
  headers?: Readonly<Record<string,string>> | ((url:string)=>Readonly<Record<string,string>>);
  /** Catalog artwork can have different hotlink rules from chapter pages. */
  coverHeaders?: Readonly<Record<string,string>> | ((url:string)=>Readonly<Record<string,string>>);
  decode?(blob:Blob, headers:Headers, processing:string|undefined, signal?:AbortSignal):Promise<Blob>;
  /** HTTP originals backing displayed canvas targets can need site-specific decoding too. */
  decodeInline?(blob:Blob, headers:Headers, url:string, signal?:AbortSignal):Promise<Blob>;
}
export interface SourceImageReference {manifestId:string; pageId:string; expectedUrl:string}

/** Borrowed download chunks, valid only during this read. Observers must not mutate/detach them. */
export interface SourceImageProgress {chunks:readonly Uint8Array<ArrayBuffer>[];done:boolean;}
/** Undefined invalidates a failed attempt, including before a source-locator retry. */
export type SourceImageProgressListener=(progress:SourceImageProgress|undefined)=>void;
