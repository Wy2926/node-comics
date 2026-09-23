import type {SourceCatalogSnapshot} from '../../sources';
import type {Comic} from '../domain';
export interface SourceCatalog extends SourceCatalogSnapshot {comicId?: string}
export interface LibraryViewModel {comics: Comic[]}
export const emptyLibrary=():LibraryViewModel=>({comics:[]});
export interface DownloadTask {
  id:string;entryId:string;status:'queued'|'running'|'paused'|'failed'|'complete';
  generation:number;completed:number;total?:number;error?:string;updatedAt:number;[key:string]:unknown;
}
