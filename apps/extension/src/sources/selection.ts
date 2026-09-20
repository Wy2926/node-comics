import type {PageManifest,SourceItem} from './adapters';

export type ImageChoice=SourceItem&{selected:boolean};
export function initialChoices(manifest:PageManifest):ImageChoice[]{
 return manifest.items.map(item=>({...item,selected:true}));
}
/** Keep explicit choices and reading order; drop removed URLs and append new images. */
export function refreshChoices(previous:ImageChoice[],manifest:PageManifest):ImageChoice[]{
 const remaining=new Map(manifest.items.map(item=>[item.id,item]));
 const kept=previous.flatMap(old=>{
  const item=remaining.get(old.id);if(!item||item.url!==old.url)return [];
  remaining.delete(old.id);return [{...item,selected:old.selected}];
 });
 return [...kept,...initialChoices({...manifest,items:[...remaining.values()]})];
}
export function moveChoice(choices:ImageChoice[],id:string,targetId:string):ImageChoice[]{
 const from=choices.findIndex(item=>item.id===id),to=choices.findIndex(item=>item.id===targetId);
 if(from<0||to<0||from===to)return choices;
 const result=[...choices];result.splice(to,0,...result.splice(from,1));return result;
}
/** Resolve selection against the trusted snapshot; never accept caller-provided URLs. */
export function selectManifest(manifest:PageManifest,itemIds:unknown):PageManifest{
 if(!Array.isArray(itemIds)||!itemIds.length||itemIds.length>manifest.items.length||itemIds.some(id=>typeof id!=='string')||new Set(itemIds).size!==itemIds.length)throw Error('请选择有效且不重复的图片。');
 const items=itemIds.map((id,order)=>{
  const item=manifest.items.find(item=>item.id===id);if(!item)throw Error('图片已不在当前来源清单中，请刷新。');
  return {...item,order};
 });
 const whole=items.length===manifest.items.length;
 return {...manifest,items,selectionConfirmed:true,discoveryComplete:whole&&manifest.discoveryComplete,knownTotal:whole?manifest.knownTotal:undefined,note:whole?manifest.note:`已选 ${items.length} / ${manifest.items.length} 张图片，保留所选顺序；不代表完整章节。`};
}
