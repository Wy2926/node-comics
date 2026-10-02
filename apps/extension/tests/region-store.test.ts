import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it} from 'vitest';
import {listRegions,readRegion,readRegionBlob,regionForTab,removeRegion,saveRegion,REGION_BUDGET_BYTES,REGION_MAX_RECORDS,type RegionRecord} from '../src/region/store';

const source=new Blob(['cropped pixels'],{type:'image/png'});
const record=(tabId=1):RegionRecord=>({id:crypto.randomUUID(),tabId,navigationId:'document',generation:1,
  rect:{x:10,y:20,width:30,height:40},
  width:30,height:40,sourceSha256:'f'.repeat(64),bytes:source.size,submitted:false});
afterEach(async()=>{for(const item of await listRegions())await removeRegion(item.tabId);});
describe('frozen selection storage',()=>{
  it('retains exact source and prepared bytes separately without LRU eviction',async()=>{
    const input=new Blob(['prepared input'],{type:'image/webp'}),initial=record();await saveRegion(initial,source);
    const saved={...initial,submitted:true,bytes:source.size+input.size};await saveRegion(saved,undefined,input);
    expect(await (await readRegionBlob(saved,'source'))!.text()).toBe('cropped pixels');
    expect(await (await readRegionBlob(saved,'input'))!.text()).toBe('prepared input');
    expect(await regionForTab(1)).toEqual(saved);
  });
  it('reuses source bytes when preprocessing made no change',async()=>{
    const saved={...record(),submitted:true,inputIsSource:true};await saveRegion(saved,source,source);
    expect(await (await readRegionBlob(saved,'input'))!.text()).toBe('cropped pixels');
  });
  it('atomically replaces only the explicitly reselected tab',async()=>{
    const first=record(),second=record(2),replacement=record();await saveRegion(first,source);await saveRegion(second,source);await saveRegion(replacement,source);
    expect(await readRegion(first.id)).toBeUndefined();expect(await readRegionBlob(first,'source')).toBeUndefined();
    await removeRegion(1,first.id);expect(await readRegion(replacement.id)).toEqual(replacement);
    expect(await readRegion(second.id)).toEqual(second);
  });
  it('rejects budget exhaustion without deleting an existing active input',async()=>{
    const saved=record();await saveRegion(saved,source);
    await expect(saveRegion({...record(2),bytes:REGION_BUDGET_BYTES},source)).rejects.toThrow('REGION_STORAGE_FULL');
    expect(await readRegion(saved.id)).toEqual(saved);expect((await listRegions()).length).toBe(1);
  });
  it('enforces a bounded metadata inventory across tabs',async()=>{
    for(let tab=0;tab<REGION_MAX_RECORDS;tab++)await saveRegion(record(tab),source);
    await expect(saveRegion(record(REGION_MAX_RECORDS),source)).rejects.toThrow('REGION_STORAGE_FULL');
    expect((await listRegions()).length).toBe(REGION_MAX_RECORDS);
  });
  it('does not resurrect a closed selection from a late task update',async()=>{
    const saved=record();await saveRegion(saved,source);await removeRegion(saved.tabId,saved.id);
    await expect(saveRegion({...saved,submitted:true})).rejects.toThrow('REGION_SOURCE_MISSING');
    expect(await readRegion(saved.id)).toBeUndefined();
  });
});
