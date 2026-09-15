import type {ReadingCopy} from '../../types';
import type {LibraryState} from '../../library/types';
import {copyPageTotal,completePageList} from '../../library/model';

export type LibraryRun = (key:string, label:string, operation:()=>Promise<unknown>, success:string)=>Promise<boolean>;
export type EditorKind = 'work'|'chapter'|'publication'|'coverage'|'inclusion'|'publicationRelations'|'version'|'relation';
export type UndoAssignment = {copyId:string;before:LibraryState['coverage'];afterIds:string[]};
export const savedPages = (copy:ReadingCopy)=>copy.pages.filter(page=>page.blobKey).length;
export const copyComplete = (copy:ReadingCopy)=>completePageList(copy)&&savedPages(copy)===copy.pages.length;
export const copyCover = (copy?:ReadingCopy)=>copy?.pages.find(page=>page.id===copy.coverPageId&&page.blobKey)??copy?.pages.find(page=>page.blobKey);
export const copySummary = (copy:ReadingCopy)=>copyComplete(copy)?`${copy.retention==='offline'?'离线可读':'已缓存'} · ${copy.pages.length} 页`:`已保存 ${savedPages(copy)} / ${copyPageTotal(copy)??'待确认'} 页`;
export const relationLabels = {related:'相关',sequel:'续作',prequel:'前传',spinoff:'外传',adaptation:'改编',fanwork:'同人'};
