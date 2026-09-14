import type { Mode, Page } from '../types';
export const automaticScope = (copyId:string|undefined, ownerId:string|undefined, origin:string, language:string, mode:Mode) => JSON.stringify([copyId,ownerId,origin,language,mode]);
export const id = () => crypto.randomUUID();
export const naturalSort = <T extends {name:string}>(items:T[]) => [...items].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'}));
export function anchorFor(top:number,height:number,viewportTop:number) {return Math.max(0,Math.min(1,(viewportTop-top)/Math.max(1,height)));}
export const emptyPage = (name:string,width:number,height:number):Page => ({id:id(),name,width,height,jobs:[],outputBlobs:{},operationIds:{}});
