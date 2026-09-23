import {msg} from '../../i18n/runtime';
import {sourceFor, sourceName} from '../../sources';
import {catalog} from '../repositories';
import {getSourceDriver} from '../sources/registry';
import type {LibraryViewModel, SourceLabel} from './types';

/** Names come from source definitions/drivers, never a comic title or cloud account name. */
export async function withSourceLabels(library:LibraryViewModel, complete=false):Promise<LibraryViewModel> {
  const readConnection=(id:string)=>catalog.get('connections',id);
  const bindings=new Map<string,Promise<SourceLabel>>(), connections=new Map<string,ReturnType<typeof readConnection>>();
  function labelFor(id:string):Promise<SourceLabel> {
    let pending=bindings.get(id);
    if(!pending){pending=(async()=>{
      const binding=await catalog.get('bindings',id);
      if(!binding)return {id:'unknown',label:msg('未知')};
      let connection=connections.get(binding.connectionId);
      if(!connection){connection=readConnection(binding.connectionId);connections.set(binding.connectionId,connection);}
      const value=await connection;
      if(!value)return {id:binding.connectionId,label:msg('未知')};
      if(value.provider==='website'){
        const url=binding.locator.url;
        if(typeof url==='string')try{
          const {definition}=sourceFor(url);
          return {id:definition.id==='generic'?'website:'+new URL(url).hostname:'website:'+definition.id,label:definition.name||new URL(url).hostname};
        }catch{/* Unavailable metadata must not prevent opening the library. */}
        return {id:value.id,label:sourceName(value.id.replace(/^website:/,''))};
      }
      return {id:value.provider,label:getSourceDriver(value.provider)?.label||value.provider};
    })();bindings.set(id,pending);}
    return pending;
  }
  const workSources:Record<string,SourceLabel[]>={};
  for(const work of library.works){
    const units=new Set(library.units.filter(unit=>unit.workId===work.id).map(unit=>unit.id));
    const ids=complete?[...new Set(library.documents.filter(doc=>units.has(doc.unitId)).map(doc=>doc.sourceBindingId))]:await catalog.workSourceBindings(work.id);
    const sources=new Map<string,SourceLabel>();
    for(let offset=0;offset<ids.length;offset+=16)for(const source of await Promise.all(ids.slice(offset,offset+16).map(labelFor)))sources.set(source.id,source);
    workSources[work.id]=[...sources.values()];
  }
  const documentSources:Record<string,SourceLabel>={};
  for(const doc of library.documents)documentSources[doc.id]=await labelFor(doc.sourceBindingId);
  return {...library,documentSources,workSources};
}
