import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {InlineBackoff} from './backoff';

beforeEach(()=>{vi.useFakeTimers({toFake:['performance']});vi.stubGlobal('navigator',{onLine:true});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('inline control backoff',()=>{
  it('retains the longest deadline and does not increase failures during local-only recovery',()=>{
    const value=new InlineBackoff(),schedule=vi.fn();
    expect(value.fail()).toBe(1000);expect(value.reason).toBe('backoff');
    vi.advanceTimersByTime(200);value.afterTick(schedule,'backoff');
    expect(schedule).toHaveBeenLastCalledWith(800);
    value.postpone(100);expect(value.delay).toBe(800);
    value.postpone(5000);expect(value.fail()).toBe(5000);
    vi.advanceTimersByTime(5000);expect(value.fail()).toBe(2000);
    vi.advanceTimersByTime(2000);value.afterTick(schedule,undefined);
    expect(value.fail()).toBe(1000);
  });
  it('restores the remote wakeup even if local recovery finishes after its deadline',()=>{
    const value=new InlineBackoff(),schedule=vi.fn();value.fail();
    vi.advanceTimersByTime(1500);value.afterTick(schedule,'backoff');
    expect(schedule).toHaveBeenCalledExactlyOnceWith(0);
    schedule.mockClear();value.afterTick(schedule,undefined);expect(schedule).not.toHaveBeenCalled();
  });
  it('honors server retry delays without shortening a pending deadline',()=>{
    const value=new InlineBackoff();expect(value.fail(5000)).toBe(5000);
    vi.advanceTimersByTime(1000);expect(value.fail(100)).toBe(4000);
    value.reset();expect(value.delay).toBe(0);expect(value.reason).toBeUndefined();
    expect(value.fail()).toBe(1000);
  });
  it('keeps offline local channels usable and resets their successful attempt count',()=>{
    const value=new InlineBackoff();value.fail();vi.advanceTimersByTime(1000);
    vi.stubGlobal('navigator',{onLine:false});expect(value.reason).toBe('offline');
    const schedule=vi.fn();value.afterTick(schedule,'offline',false);
    expect(schedule).not.toHaveBeenCalled();expect(value.fail()).toBe(1000);
  });
});
