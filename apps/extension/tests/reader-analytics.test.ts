import {afterEach,describe,expect,it,vi} from 'vitest';
import {ReaderAnalytics,type ReadingDimensions} from '../src/reader/analytics';

const dimensions:ReadingDimensions={source_type:'website',format:'website',layout:'continuous',mode:'original',target_language:'zh-Hans'};
function setup(){const report=vi.fn();return {report,session:new ReaderAnalytics(report)};}
function read(session:ReaderAnalytics,from:number,to:number,pages=['private-page-a','private-page-b']){
  for(let at=from;at<=to;at+=1000)session.sample(at,pages,dimensions,true,12);
}
afterEach(()=>vi.restoreAllMocks());
describe('reader usage boundaries',()=>{
  it('starts a new observation window when a frozen page sees a new consent epoch with enabled still true',()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1700000000000);
    const {session,report}=setup(),translation={channel:'official' as const,mode:'classic' as const,target_language:'zh-Hans' as const};
    session.setEnabled(true,0,1700000000000);
    session.requestTranslation(0,translation);
    read(session,0,30000,['before-consent']);
    // The page never observes the intermediate false value while frozen.
    clock.mockReturnValue(1700000100000);
    session.setEnabled(true,100000,1700000090000);
    report.mockClear();
    session.sample(100000,['after-consent'],dimensions,true,12);
    session.translationShown(100000,translation);
    session.flush(100000);
    expect(report.mock.calls.map(([event])=>event)).toEqual(['reader_open','translation_viewed','reading_summary']);
    expect(report.mock.calls.every(call=>call[2]===1700000100000)).toBe(true);
    expect(report.mock.calls[1][1]).not.toHaveProperty('duration_ms');
    expect(report.mock.calls[2][1]).toMatchObject({pages_viewed:1,active_ms:0});
    session.setEnabled(true,101000,1700000090000);
    session.sample(101000,['after-consent'],dimensions,true,12);
    expect(report.mock.calls.filter(([event])=>event==='reader_open')).toHaveLength(1);
  });
  it('retains the consent observation origin for time summaries and delayed translation, then resets it',()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(1700000000000);
    const {session,report}=setup(),translation={channel:'official' as const,mode:'classic' as const,target_language:'zh-Hans' as const};
    session.setEnabled(true,0);session.requestTranslation(0,translation);
    clock.mockReturnValue(1700000060000);
    read(session,0,60000);session.flush(60000);session.translationShown(60000,translation);
    expect(report.mock.calls.every(call=>call[2]===1700000000000)).toBe(true);
    expect(report.mock.calls.at(-1)?.[1]).toMatchObject({duration_ms:60000});
    session.setEnabled(false,60000);session.setEnabled(true,60000);
    session.translationShown(61000,translation);
    expect(report.mock.calls.at(-1)?.[2]).toBe(1700000060000);
    expect(report.mock.calls.at(-1)?.[1]).not.toHaveProperty('duration_ms');
  });
  it('does not count decoded offscreen pages, hidden time or activity before consent',()=>{
    const {session,report}=setup();read(session,0,65000);session.setEnabled(true,65000);
    session.sample(65000,[],dimensions,true,12);session.sample(66000,['private-prefetch'],dimensions,false,12);
    session.flush(67000);expect(report).not.toHaveBeenCalled();
    session.sample(68000,['private-page-a'],dimensions,true,12);session.suspend(69000);
    session.sample(90000,['private-page-a'],dimensions,false,12);session.flush(90000);
    expect(report.mock.calls.filter(([event])=>event==='reader_open')).toHaveLength(1);
    expect(report.mock.calls.filter(([event])=>event==='reading_summary').map(([,params])=>params.active_ms)).toEqual([1000]);
    expect(JSON.stringify(report.mock.calls)).not.toContain('private-');
  });
  it('activates once after 60 foreground seconds and two visible pages, across remount suspension',()=>{
    const {session,report}=setup();session.setEnabled(true,0);read(session,0,30000,['a']);session.suspend(30000);
    session.setEnabled(true,40000);read(session,40000,70000,['b']);session.flush(70000);read(session,71000,80000,['b']);
    expect(report.mock.calls.filter(([event])=>event==='reader_open')).toHaveLength(1);
    const engaged=report.mock.calls.filter(([event])=>event==='reading_engaged');
    expect(engaged).toHaveLength(1);expect(engaged[0][1]).toMatchObject({active_ms:60000,pages_viewed:2});
    expect(engaged[0][1]).not.toHaveProperty('engagement_time_msec');
    const summaries=report.mock.calls.filter(([event])=>event==='reading_summary');
    expect(summaries.map(([,params])=>params.pages_viewed)).toEqual([1,1]);
  });
  it('pauses idle reading after 120 seconds and resets observations on withdrawal',()=>{
    const {session,report}=setup();session.setEnabled(true,0);read(session,0,150000);session.flush(150000);
    expect(report.mock.calls.at(-1)?.[1].active_ms).toBe(120000);
    session.interact(150000);read(session,151000,152000);session.flush(152000);
    expect(report.mock.calls.at(-1)?.[1].active_ms).toBe(2000);
    session.setEnabled(false,152000);read(session,153000,200000);session.setEnabled(true,200000);
    session.sample(200000,['new'],dimensions,true,12);session.flush(200000);
    expect(report.mock.calls.at(-1)?.[1]).toMatchObject({pages_viewed:1,active_ms:0});
  });
  it('excludes an obscuring dialog even while its keyboard interactions remain active',()=>{
    const {session,report}=setup();
    session.setEnabled(true,0);
    read(session,0,10000,['a']);
    session.sample(10000,[],dimensions,false,12);
    for(let at=11000;at<=80000;at+=1000){
      session.interact(at);
      session.sample(at,[],dimensions,false,12);
    }
    session.flush(80000);
    expect(report.mock.calls.filter(([event])=>event==='reading_engaged')).toHaveLength(0);
    read(session,81000,131000,['b']);
    session.flush(131000);
    const summaries=report.mock.calls.filter(([event])=>event==='reading_summary');
    expect(summaries.map(([,params])=>params.active_ms)).toEqual([10000,50000]);
    expect(report.mock.calls.filter(([event])=>event==='reading_engaged')[0][1]).toMatchObject({active_ms:60000,pages_viewed:2});
  });
  it('records the first visible translation, but not repeated decoding or polling',()=>{
    const {session,report}=setup();const translation={channel:'official' as const,mode:'classic' as const,target_language:'zh-Hans' as const};
    session.setEnabled(true,0);session.requestTranslation(100,translation);session.translationShown(400,translation);session.translationShown(800,translation);
    expect(report.mock.calls.map(([event])=>event)).toEqual(['translation_requested','translation_viewed']);
    expect(report.mock.calls[1][1]).toMatchObject({duration_ms:300});
    session.setEnabled(false,900);session.translationShown(1000,translation);expect(report).toHaveBeenCalledTimes(2);
  });
  it('segments mode changes and counts one visible quota obstacle per mode',()=>{
    const {session,report}=setup();session.setEnabled(true,0);read(session,0,2000,['a']);
    session.sample(3000,['a'],{...dimensions,mode:'classic'},true,12);session.sample(4000,['a'],{...dimensions,mode:'classic'},true,12);session.flush(4000);
    const summaries=report.mock.calls.filter(([event])=>event==='reading_summary');
    expect(summaries.map(([,params])=>[params.mode,params.active_ms])).toEqual([['original',3000],['classic',1000]]);
    const quota={mode:'classic' as const,channel:'official' as const,target_language:'zh-Hans' as const};
    session.quotaShown(quota);session.quotaShown(quota);
    expect(report.mock.calls.filter(([event])=>event==='quota_blocked')).toHaveLength(1);
  });
});
