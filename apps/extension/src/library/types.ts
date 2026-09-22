import type { SourceCatalogSnapshot } from '../sources';
export type { SourceEntry,SourceGroup } from '../sources';
export type Evidence = {status:'observed'|'confirmed'|'user'; source:string};
export interface ComicWork {id:string;title:string;aliases:string[];creators:string[];createdAt:number;updatedAt:number;evidence:Evidence;preferredCopyId?:string;coverCopyId?:string;readAt?:number;}
export interface Chapter {id:string;workId:string;title:string;number?:string;numbering:string;order:number;role:'main'|'extra'|'unknown';evidence:Evidence;readAt?:number;}
export interface ContentVersion {id:string;workId:string;chapterId?:string;title:string;language?:string;translator?:string;evidence:Evidence;}
export interface PublicationSeries {id:string;workIds:string[];title:string;publisher?:string;language?:string;edition?:string;evidence:Evidence;}
export interface Publication {id:string;workIds:string[];seriesId?:string;title:string;number?:string;order:number;form:'book'|'issue'|'unknown';isbn?:string;evidence:Evidence;readAt?:number;}
export interface ContentInclusion {id:string;publicationId:string;target:{kind:'chapter'|'work';id:string};versionId?:string;order:number;evidence:Evidence;}
export interface PublicationRelation {id:string;fromId:string;toId:string;kind:'collects'|'reprint';evidence:Evidence;}
export interface CopyCoverage {id:string;copyId:string;workId:string;target:{kind:'chapter'|'publication'|'work'|'unclassified';id:string};startPageId?:string;endPageId?:string;evidence:Evidence;}
export interface WorkRelation {id:string;fromId:string;toId:string;kind:'sequel'|'prequel'|'spinoff'|'adaptation'|'fanwork'|'related';evidence:Evidence;}
export interface SourceCatalog extends SourceCatalogSnapshot {workId?:string;excludedEntryIds:string[];}
export interface AcquisitionTask {id:string;copyId:string;status:'queued'|'running'|'paused'|'failed'|'complete';phase:'discover'|'images';completed:number;total?:number;error?:string;updatedAt:number;}
export interface LibraryState {id:'library';revision:number;works:ComicWork[];chapters:Chapter[];versions:ContentVersion[];series:PublicationSeries[];publications:Publication[];inclusions:ContentInclusion[];publicationRelations:PublicationRelation[];coverage:CopyCoverage[];relations:WorkRelation[];catalogs:SourceCatalog[];tasks:AcquisitionTask[];}
export type ImportKind='chapter'|'extra'|'publication'|'work'|'unclassified';
export interface ImportAssignment {workId?:string;title:string;kind:ImportKind;number?:string;seriesId?:string;targetId?:string;}
