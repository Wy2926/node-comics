import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {retainResult,resultInMemory,invalidateResultMemory} from '../src/storage/translations/memory';
beforeEach(()=>{vi.stubGlobal('BroadcastChannel',undefined);invalidateResultMemory();});
afterEach(()=>{invalidateResultMemory();vi.unstubAllGlobals();});
it('retains 24 compressed results instead of discarding the previous reading window',()=>{
  for(let i=0;i<25;i++)retainResult(String(i),new Blob([String(i)]));
  expect(resultInMemory('0')).toBeUndefined();
  for(let i=1;i<25;i++)expect(resultInMemory(String(i))).toBeDefined();
});
it('uses a 512 MiB retention budget and never rejects a single oversized result',()=>{
  const blob=(megabytes:number)=>Object.defineProperty(new Blob(['fixture']),'size',{value:megabytes*1024*1024});
  for(let i=0;i<4;i++)retainResult(String(i),blob(160));
  expect(resultInMemory('0')).toBeUndefined();expect(resultInMemory('1')).toBeDefined();
  retainResult('large',blob(600));expect(resultInMemory('3')).toBeUndefined();expect(resultInMemory('large')).toBeDefined();
});
