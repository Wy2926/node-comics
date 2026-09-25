const mirroredSettingsKey='nc-reader-settings';
let overrideMb:number|undefined,extensionMb:number|undefined,initial:Promise<void>|undefined;
const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&(value>=0||value===-1);
export function translationBudgetBytes(){
  let mb=overrideMb??extensionMb;
  if(mb===undefined){try{const value=JSON.parse(localStorage.getItem('nc-settings')??'{}').cacheLimitMb;if(valid(value))mb=value;}catch{/* A service worker reads mirrored preferences instead. */}}
  return mb===-1?Infinity:(mb??1024)*1024**2;
}
export function overrideTranslationBudget(mb:number){
  if(!valid(mb))throw Error('Invalid translation cache budget');overrideMb=mb;
}
/** Initialized by cache IO, so workers cannot write with a default budget before preferences load. */
export function initializeTranslationBudget(onChanged:()=>void):Promise<void>{
  if(initial)return initial;
  if(typeof chrome==='undefined'||!chrome.storage?.local)return Promise.resolve();
  let revision=0;
  const apply=(value:unknown)=>{const limit=(value as {cacheLimitMb?:unknown}|undefined)?.cacheLimitMb;extensionMb=valid(limit)?limit:1024;};
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=='local'||!changes[mirroredSettingsKey])return;
    revision++;apply(changes[mirroredSettingsKey].newValue);onChanged();
  });
  const started=revision;
  initial=chrome.storage.local.get(mirroredSettingsKey).then(saved=>{if(revision===started)apply(saved[mirroredSettingsKey]);});
  return initial;
}
