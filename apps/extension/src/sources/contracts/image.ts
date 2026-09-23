/** Image transport/decoding is independent of how a site discovers its directory or pages. */
export interface SourceImageAdapter {
  /** Dynamic headers receive only the already authorized image URL. */
  headers?: Readonly<Record<string,string>> | ((url:string)=>Readonly<Record<string,string>>);
  decode?(blob:Blob, headers:Headers, processing:string|undefined, signal?:AbortSignal):Promise<Blob>;
}
export interface SourceImageReference {manifestId:string; pageId:string; expectedUrl:string}
