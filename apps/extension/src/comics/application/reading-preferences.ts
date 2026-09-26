import {catalog, type CatalogMutation} from '../repositories';
import type {CatalogRecord, Comic, Entry} from '../domain';
import {msg} from '../../i18n/runtime';

export const readingPreferencesId = (comicId:string) => 'reading-preferences:' + comicId;
export const readingSelectionKey = (entry:Pick<Entry,'sequenceId'|'readingSlotId'|'id'>) =>
  JSON.stringify([entry.sequenceId ?? null, entry.readingSlotId ?? null, entry.readingSlotId ? null : entry.id]);

export interface ReadingPreferences extends CatalogRecord {
  comicId:string;
  sourceGeneration:number;
  selections:Record<string,string>;
  lastEntryId?:string;
  selectedAt?:number;
  sourceLanguagePreference?:string;
}

export async function readReadingPreferences(comic:Comic, tx:Pick<CatalogMutation,'get'>=catalog):Promise<ReadingPreferences> {
  const id=readingPreferencesId(comic.id),saved=await tx.get('metadata',id) as ReadingPreferences|undefined;
  const current=saved?.comicId===comic.id&&saved.sourceGeneration===comic.source.generation?saved:undefined;
  return {id,comicId:comic.id,sourceGeneration:comic.source.generation,selections:current?.selections??{},
    lastEntryId:current?.lastEntryId,selectedAt:current?.selectedAt,sourceLanguagePreference:current?.sourceLanguagePreference};
}

/** A source-content preference belongs to this book, independently of image translation. */
export async function setSourceLanguagePreference(comicId:string,value:string|undefined) {
  let normalized:string|undefined;
  if(value){try{normalized=new Intl.Locale(value).baseName;}catch{throw Error(msg('内容语言无效。'));}}
  const owner=await catalog.get('comics',comicId);if(!owner)throw Error(msg('漫画已移除。'));
  await catalog.mutate(['comics','connections','metadata'],async tx=>{
    const comic=await requireActiveComic(tx,comicId,owner.source.generation),saved=await readReadingPreferences(comic,tx);
    await tx.put('metadata',{...saved,sourceLanguagePreference:normalized});
  });
}

async function requireActiveComic(tx:CatalogMutation, comicId:string, generation:number) {
  const comic=await tx.get('comics',comicId),connection=comic&&await tx.get('connections',comic.source.connectionId);
  if(!comic||comic.source.generation!==generation||comic.source.status!=='active'||!connection||['revoked','disconnected'].includes(connection.status))
    throw Error('漫画已移除或来源已断开，请重新打开。');
  return comic;
}

export const entryReadable=(entry:Entry)=>!entry.sourceRemoved&&entry.readable!==false;
export const entryRetained=(entry:Entry)=>(entry.pageCount??0)>0;
export const sourceOrder=(a:Entry,b:Entry)=>(a.sourceOrder??a.order)-(b.sourceOrder??b.order);

/** Automatic opening records recency; only a deliberate candidate choice pins a slot. */
export async function selectReadingEntry(entryId:string,rememberChoice=true):Promise<void> {
  const initial=await catalog.get('entries',entryId),owner=initial&&await catalog.get('comics',initial.comicId);
  if(!initial||!owner)throw Error('漫画已移除。');
  await catalog.mutate(['comics','entries','connections','metadata'],async tx=>{
    const comic=await requireActiveComic(tx,owner.id,owner.source.generation),entry=await tx.get('entries',entryId);
    if(!entry||entry.comicId!==comic.id||entry.generation!==initial.generation)throw Error('来源内容已变化，请重新打开。');
    if(rememberChoice&&!entryReadable(entry)&&!entryRetained(entry))throw Error('该话暂无可读内容。');
    const saved=await readReadingPreferences(comic,tx);
    await tx.put('metadata',{...saved,lastEntryId:entry.id,selectedAt:Date.now(),
      selections:rememberChoice&&entryReadable(entry)?{...saved.selections,[readingSelectionKey(entry)]:entry.id}:saved.selections});
  });
}

export interface ReadingSlot {id:string;entries:Entry[];order:number;sourceOrder:number}
export function readingSlots(entries:Entry[]):ReadingSlot[] {
  const grouped=new Map<string,Entry[]>();
  for(const entry of entries){const key=readingSelectionKey(entry),values=grouped.get(key)??[];values.push(entry);grouped.set(key,values);}
  return [...grouped].map(([id,values])=>{
    values.sort(sourceOrder);const representative=values.find(entry=>!entry.sourceRemoved)??values[0];
    return {id,entries:values,order:representative.order,sourceOrder:representative.sourceOrder??representative.order};
  }).sort((a,b)=>a.order-b.order||Number(a.entries.some(entry=>!entry.sourceRemoved))-Number(b.entries.some(entry=>!entry.sourceRemoved))||a.sourceOrder-b.sourceOrder);
}

function language(value:string|undefined){
  if(!value)return;
  try{const locale=new Intl.Locale(value),maximized=locale.maximize();return {tag:locale.baseName,language:locale.language,script:maximized.script};}catch{return;}
}
/** Scripts distinguish simplified/traditional Chinese; regions within a script are compatible. */
export function languageMatches(candidate:string|undefined,target:string|undefined):boolean {
  const a=language(candidate),b=language(target);
  return !!a&&!!b&&a.language===b.language&&a.script===b.script;
}
export function sourceLanguageMatches(candidate:string|undefined,target:string|undefined):boolean {
  if(!candidate||!target)return false;
  try{
    const parts=(value:string)=>{
      const locale=new Intl.Locale(value);
      const chineseScript=locale.language==='zh'&&locale.region?
        ({CN:'Hans',SG:'Hans',TW:'Hant',HK:'Hant',MO:'Hant'} as Record<string,string>)[locale.region]:undefined;
      return {language:locale.language,script:locale.script??chineseScript};
    };
    const a=parts(candidate),b=parts(target);
    return a.language===b.language&&(!b.script||a.script===b.script);
  }catch{return false;}
}

/** Every slot independently resolves hand-picked, target-language, English, then source order. */
export function chooseReadingEntry(slot:ReadingSlot,preferences:ReadingPreferences,targetLanguage?:string):Entry {
  const candidates=slot.entries.filter(entryReadable);
  const chosen=candidates.find(entry=>entry.id===preferences.selections[slot.id]);if(chosen)return chosen;
  const preferred=preferences.sourceLanguagePreference??targetLanguage,target=language(preferred);
  return (preferences.sourceLanguagePreference==='zh'?undefined:candidates.find(entry=>target&&language(entry.contentLanguage)?.tag===target.tag))
    ??candidates.find(entry=>preferences.sourceLanguagePreference?sourceLanguageMatches(entry.contentLanguage,preferred):languageMatches(entry.contentLanguage,preferred))
    ??candidates.find(entry=>languageMatches(entry.contentLanguage,'en'))
    ??candidates[0]??slot.entries[0];
}

/** A wholly unavailable slot stays visible and ends the automatic sequence, never disappearing. */
export function resolveReadingSequence(current:Entry,allEntries:Entry[],preferences:ReadingPreferences,targetLanguage?:string):Entry[] {
  if(!current.sequenceId)return [current];
  const slots=readingSlots(allEntries.filter(entry=>entry.sequenceId===current.sequenceId));
  const at=slots.findIndex(slot=>slot.entries.some(entry=>entry.id===current.id));
  if(at<0)return [current];
  if(!slots[at].entries.some(entryReadable))return [current];
  const entries=[current];
  for(const direction of [-1,1] as const){
    for(let index=at+direction;index>=0&&index<slots.length;index+=direction){
      const chosen=chooseReadingEntry(slots[index],preferences,targetLanguage);
      if(direction<0)entries.unshift(chosen);else entries.push(chosen);
      if(!entryReadable(chosen))break;
    }
  }
  return entries;
}
