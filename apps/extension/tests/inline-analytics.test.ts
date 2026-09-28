import {afterEach,describe,expect,it,vi} from 'vitest';
import {InlineAnalytics} from '../src/inline/analytics';
const context={channel:'official' as const,mode:'redraw' as const,language:'zh-Hans'};
function createUsage(report:ConstructorParameters<typeof InlineAnalytics>[0]){
  const usage=new InlineAnalytics(report);usage.setConsent(true,0);return usage;
}
afterEach(()=>vi.restoreAllMocks());
describe('inline translation session usage',()=>{
  it('keeps delayed observations tied to their explicit start and refreshes the origin on restart',()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1700000000000);
    const report=vi.fn(),usage=createUsage(report);usage.start(true);
    clock.mockReturnValue(1700000060000);usage.accepted(context);usage.shown(context);
    expect(report.mock.calls.map(call=>call[2])).toEqual([1700000000000,1700000000000]);
    usage.start(false);usage.accepted(context);
    expect(report.mock.calls.at(-1)?.[2]).toBe(1700000060000);
    expect(report.mock.calls.at(-1)?.[1]).not.toHaveProperty('startedAt');
  });
  it('records one manual start and visible image despite repeated responses and image decodes',()=>{
    const report=vi.fn(),usage=createUsage(report);usage.start(false);
    usage.accepted(context);usage.accepted(context);
    usage.shown({...context,mode:'classic'});usage.shown(context);
    expect(report.mock.calls.map(([name])=>name)).toEqual(['translation_requested','translation_viewed']);
    expect(report.mock.calls[0][1]).toMatchObject({surface:'inline',method:'manual',mode:'redraw'});
    expect(report.mock.calls[1][1]).toMatchObject({surface:'inline',method:'manual',mode:'classic'});
    expect(Object.keys(report.mock.calls[1][1]).sort()).toEqual(['channel','method','mode','surface','target_language']);
  });
  it('does not count pre-start, stopped, or unclassified channels and starts a fresh automatic session',()=>{
    const report=vi.fn(),usage=createUsage(report);usage.accepted(context);usage.shown(context);expect(report).not.toHaveBeenCalled();
    usage.start(true);usage.accepted({...context,channel:undefined});expect(report).not.toHaveBeenCalled();
    usage.accepted(context);usage.stop();usage.shown(context);expect(report).toHaveBeenCalledTimes(1);
    usage.start(true);usage.accepted({...context,channel:'local'});usage.shown({...context,channel:'local'});
    expect(report).toHaveBeenCalledTimes(3);expect(report.mock.calls[2][1]).toMatchObject({method:'automatic',channel:'local'});
  });
  it('reopens observation after a frozen consent change without accepting an older request',()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1700000000000);
    const report=vi.fn(),usage=new InlineAnalytics(report);
    usage.start(false);usage.accepted(context);usage.shown(context);
    expect(report).not.toHaveBeenCalled();
    usage.setConsent(true,1700000000000);usage.accepted(context);usage.shown(context);
    expect(report).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(1700000100000);
    usage.setConsent(true,1700000090000);
    report.mockClear();
    usage.accepted(context,1700000080000);usage.shown(context);
    expect(report).not.toHaveBeenCalled();
    usage.accepted(context,1700000100000);usage.shown(context);
    expect(report.mock.calls.map(call=>call[2])).toEqual([1700000090000,1700000090000]);
    usage.setConsent(true,1700000090000);usage.accepted(context);usage.shown(context);
    expect(report).toHaveBeenCalledTimes(2);
    usage.setConsent(false);usage.shown(context);
    expect(report).toHaveBeenCalledTimes(2);
  });
});
