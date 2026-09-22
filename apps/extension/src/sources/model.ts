export interface SourceItem {id:string;url:string;width:number;height:number;order:number;kind?:'page';preview?:string;}
export interface PageManifest {id:string;sourceTabId:number;navigationId:string;revision:number;title:string;url:string;adapter:string;direction:'ltr'|'rtl';discoveryComplete:boolean;knownTotal?:number;note:string;items:SourceItem[];selectionConfirmed?:boolean;}
export type SourceSnapshot=Omit<PageManifest,'id'|'sourceTabId'|'navigationId'|'revision'>;
export type ComicElement=HTMLImageElement|HTMLCanvasElement;
export interface PageImage {element:ComicElement;key:string;url:string;read?:()=>Promise<Blob>;}
/** Site rules own discovery and rendered targets; transport and translation stay shared. */
export interface SourceAdapter {
 id:string;
 name:string;
 direction?:'ltr'|'rtl';
 matches:(url:URL)=>boolean;
 discover:(doc:Document,url:string)=>SourceSnapshot;
 read?:(doc:Document,url:string)=>Promise<SourceSnapshot>;
 images?:(doc:Document,url:string)=>PageImage[];
}
