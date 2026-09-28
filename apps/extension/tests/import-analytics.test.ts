import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const track=vi.hoisted(()=>vi.fn());
vi.mock('../src/analytics',()=>({track}));
import {importFormat,observeImport} from '../src/comics/application/import-analytics';

beforeEach(()=>track.mockClear());
afterEach(()=>vi.restoreAllMocks());
describe('import usage boundary',()=>{
  it.each([false,true])('keeps the operation origin for delayed results, including failure=%s',async fail=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1700000000000);
    let finish!:()=>void;
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    const work=observeImport('local','cbz',async()=>{await pending;if(fail)throw Error('private failure');return 'private result';});
    clock.mockReturnValue(1700000060000);
    finish();
    if(fail)await expect(work).rejects.toThrow('private failure');else await expect(work).resolves.toBe('private result');
    expect(track.mock.calls.map(call=>call[2])).toEqual([1700000000000,1700000000000]);
    expect(track.mock.calls[1][1]).not.toHaveProperty('startedAt');
  });
  it('only emits format and categories while preserving the private result',async()=>{
    const result={id:'private-id',created:false,name:'private-title.cbz'};
    expect(await observeImport('local',importFormat('private-title.CBZ'),async()=>result,value=>value.created)).toBe(result);
    expect(track.mock.calls.map(([name])=>name)).toEqual(['import_started','import_result']);
    expect(track.mock.calls[1][1]).toMatchObject({source_type:'local',format:'cbz',outcome:'duplicate'});
    expect(JSON.stringify(track.mock.calls)).not.toContain('private-');
    expect(importFormat('secret.exe')).toBe('unknown');
  });
  it('preserves the original failure and reports cancellation without its message',async()=>{
    const error=new DOMException('private-file-name','AbortError');
    await expect(observeImport('google_drive','pdf',async()=>{throw error;})).rejects.toBe(error);
    expect(track.mock.calls[1][1]).toMatchObject({outcome:'cancelled',error_code:'cancelled'});
    expect(JSON.stringify(track.mock.calls)).not.toContain('private-file-name');
  });
});
