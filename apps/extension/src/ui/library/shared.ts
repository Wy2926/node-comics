import {msg} from '../../i18n/runtime';
import type {ReadingCopy} from '../../types';
import type {LibraryState} from '../../library/types';
import {copyPageTotal,completePageList} from '../../library/model';

export type LibraryRun = (key:string, label:string, operation:()=>Promise<unknown>, success:string)=>Promise<boolean>;
export type EditorKind = 'work'|'chapter'|'publication'|'coverage'|'inclusion'|'publicationRelations'|'version'|'relation';
export type UndoAssignment = {copyId:string;before:LibraryState['coverage'];afterIds:string[]};
export const savedPages = (copy:ReadingCopy)=>copy.pages.filter(page=>page.blobKey).length;
export const copyComplete = (copy:ReadingCopy)=>completePageList(copy)&&savedPages(copy)===copy.pages.length;
export const copyCover = (copy?:ReadingCopy)=>copy?.pages.find(page=>page.id===copy.coverPageId&&page.blobKey)??copy?.pages.find(page=>page.blobKey);
export const copySummary = (copy:ReadingCopy)=>copyComplete(copy)?msg("{0} · {1} 页", {"0": copy.retention==='offline'?msg("离线可读"):msg("已缓存"), "1": copy.pages.length}):msg("已保存 {0} / {1} 页", {"0": savedPages(copy), "1": copyPageTotal(copy)??msg("待确认")});
export const relationLabels = {get related(){return msg("相关");},get sequel(){return msg("续作");},get prequel(){return msg("前传");},get spinoff(){return msg("外传");},get adaptation(){return msg("改编");},get fanwork(){return msg("同人");}};
