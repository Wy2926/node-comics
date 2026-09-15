import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {historyPollDelay,pollVisibleHistory} from '../src/ui/history-polling';

describe('history request scheduling',()=>{
  let doc: EventTarget & {hidden:boolean};
  let stop: (()=>void)|undefined;
  beforeEach(()=>{
    vi.useFakeTimers();
    doc=Object.assign(new EventTarget(),{hidden:false});
    vi.stubGlobal('document',doc);
  });
  afterEach(()=>{stop?.();vi.useRealTimers();vi.unstubAllGlobals();});
  function start(load=vi.fn(async()=>['running'])){
    const receive=vi.fn(),error=vi.fn();
    stop=pollVisibleHistory({load,receive,error,delay:historyPollDelay,current:()=>true});
    return {load,receive,error};
  }
  it('polls running work at 15 seconds and stops once completed',async()=>{
    const load=vi.fn().mockResolvedValueOnce(['running']).mockResolvedValue(['succeeded']);
    start(load);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(historyPollDelay(['outcome_unknown'])).toBe(60_000);
  });
  it('does not load hidden pages; refreshes on return even for completed records',async()=>{
    doc.hidden=true;
    const {load}=start(vi.fn(async()=>['succeeded']));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).not.toHaveBeenCalled();
    doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
    doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('backs off errors and resumes normal polling after recovery',async()=>{
    const load=vi.fn().mockRejectedValueOnce(Error('offline')).mockRejectedValueOnce(Error('offline')).mockResolvedValue(['queued']);
    const {error}=start(load);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it('does not overlap slow requests or update disposed views',async()=>{
    let resolve!: (states:string[])=>void;
    const load=vi.fn(()=>new Promise<string[]>(done=>{resolve=done;}));
    const {receive}=start(load);
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(1);
    stop?.();resolve(['running']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(receive).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
