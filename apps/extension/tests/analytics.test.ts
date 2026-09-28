import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createAnalyticsEngine,analyticsLimits,type AnalyticsState} from '../src/analytics/engine';
import {sanitizeEvent} from '../src/analytics/schema';
import {track as clientTrack} from '../src/analytics/client';

function fixture(){
  let saved:AnalyticsState|undefined,at=1700000000000,sequence=0,permission=true,status=204;
  const ids=vi.fn(()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`);
  const send=vi.fn(async(_body:unknown,_signal:AbortSignal)=>status),wake=vi.fn(),clearWake=vi.fn();
  const engine=createAnalyticsEngine({read:async()=>structuredClone(saved),write:async value=>{saved=structuredClone(value);},allowed:async()=>permission,send,common:()=>({browser:'chrome',extension_version:'0.6.0'}),wake,clearWake,now:()=>at,uuid:ids});
  return {engine,send,wake,clearWake,ids,get saved(){return saved;},set time(value:number){at=value;},get time(){return at;},set permission(value:boolean){permission=value;},set status(value:number){status=value;}};
}
describe('analytics privacy and delivery',()=>{
  it('does not create an identifier, queue or request before explicit consent',async()=>{
    const f=fixture();await f.engine.track('reader_open',{surface:'reader'});await f.engine.flush();
    expect(f.saved).toBeUndefined();expect(f.ids).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();expect(f.wake).not.toHaveBeenCalled();
    await f.engine.setConsent(true);expect(f.saved).toEqual({consent:true,consented_at:f.time,queue:[]});expect(f.ids).not.toHaveBeenCalled();
  });
  it('allows only event-specific categories and counters, excluding private content',()=>{
    expect(sanitizeEvent('reader_open',{source_type:'website',title:'private',url:'https://private.test',query:'private',file:'a.cbz',stack:'secret',task_id:'123',page_count:12,screen:'settings',extension_version:'0.6.0',target_language:'ja',mode:'custom-http://secret'})).toEqual({name:'reader_open',params:{source_type:'website',page_count:12,extension_version:'0.6.0',target_language:'ja'}});
    expect(sanitizeEvent('unknown',{})).toBeUndefined();
    expect(sanitizeEvent('reading_summary',{active_ms:Infinity,pages_viewed:-1})).toEqual({name:'reading_summary',params:{}});
  });
  it('rejects unimplemented events and fields outside the active product contract',()=>{
    for(const name of ['translation_result','feature_error','login'])expect(sanitizeEvent(name,{})).toBeUndefined();
    expect(sanitizeEvent('import_result',{outcome:'success',count:1,success_count:1,failure_count:0,duplicate_count:0,cancelled_count:0})).toEqual({name:'import_result',params:{outcome:'success',count:1}});
    expect(sanitizeEvent('reading_summary',{active_ms:1000,engagement_time_msec:1000,progress_bucket:25,duration_ms:1000})).toEqual({name:'reading_summary',params:{active_ms:1000,engagement_time_msec:1000}});
    expect(sanitizeEvent('reading_engaged',{active_ms:60000,engagement_time_msec:60000})).toEqual({name:'reading_engaged',params:{active_ms:60000}});
    expect(sanitizeEvent('translation_requested',{method:'oidc',count:1})).toEqual({name:'translation_requested',params:{}});
  });
  it('generates first-use and activation once and groups at most 20 events by session',async()=>{
    const f=fixture();await f.engine.setConsent(true);
    await f.engine.track('reading_engaged',{surface:'reader',active_ms:30000});await f.engine.track('reading_engaged',{surface:'reader',active_ms:30000});
    expect(f.saved?.queue.map(e=>e.name)).toEqual(['extension_first_use','reading_engaged','reader_activated','reading_engaged']);
    f.time+=analyticsLimits.sessionMs+1000;await f.engine.track('page_view',{screen:'library'});
    await f.engine.flush();const first=f.send.mock.calls[0][0] as {session_id:number;events:unknown[]};
    expect(first.events).toHaveLength(4);expect(f.saved?.queue).toHaveLength(1);
    await f.engine.flush();expect(f.send.mock.calls[1][0]).not.toHaveProperty('events.0.session_id');expect(f.saved?.queue).toHaveLength(0);
    for(let i=0;i<30;i++)await f.engine.track('page_view',{screen:'library'});
    await f.engine.flush();expect((f.send.mock.calls[2][0] as {events:unknown[]}).events).toHaveLength(20);
  });
  it('bounds storage, expires offline events and caps retry attempts',async()=>{
    const f=fixture();await f.engine.setConsent(true);
    for(let i=0;i<205;i++)await f.engine.track('page_view',{screen:'library'});
    expect(f.saved?.queue).toHaveLength(200);
    f.time+=analyticsLimits.ageMs+1;await f.engine.flush();expect(f.saved?.queue).toHaveLength(0);expect(f.send).not.toHaveBeenCalled();
    await f.engine.track('page_view',{screen:'reader'});f.status=503;
    for(let i=0;i<analyticsLimits.attempts;i++){await f.engine.flush();f.time+=60*60*1000;}
    expect(f.send).toHaveBeenCalledTimes(analyticsLimits.attempts);expect(f.saved?.queue).toHaveLength(0);
  });
  it('clears identity and queued data on revoke and uses a fresh ID after a new opt-in',async()=>{
    const f=fixture();await f.engine.setConsent(true);await f.engine.track('page_view',{screen:'library'});const old=f.saved?.client_id;
    await f.engine.setConsent(false);expect(f.saved).toEqual({consent:false,queue:[]});await f.engine.flush();expect(f.send).not.toHaveBeenCalled();
    await f.engine.setConsent(true);await f.engine.track('page_view',{screen:'library'});expect(f.saved?.client_id).not.toBe(old);
  });
  it('aborts an in-flight send immediately when consent is withdrawn',async()=>{
    const f=fixture();await f.engine.setConsent(true);await f.engine.track('page_view',{screen:'library'});
    let signal:AbortSignal|undefined;
    f.send.mockImplementation((_body,active)=>new Promise((_resolve,reject)=>{signal=active;active.addEventListener('abort',()=>reject(Error('aborted')));}));
    const sending=f.engine.flush();await vi.waitFor(()=>expect(signal).toBeDefined());
    const revoked=f.engine.setConsent(false);expect(signal!.aborted).toBe(true);await revoked;await sending;
    expect(f.saved).toEqual({consent:false,queue:[]});
  });
  it('checks browser data permission again before enqueue and flush',async()=>{
    const f=fixture();await f.engine.setConsent(true);await f.engine.track('page_view',{screen:'library'});f.permission=false;
    await f.engine.flush();expect(f.send).not.toHaveBeenCalled();expect(f.saved).toEqual({consent:false,queue:[]});
    expect(await f.engine.setConsent(true)).toBe(false);await f.engine.track('page_view',{});expect(f.saved?.queue).toHaveLength(0);
  });
  it('can revoke even if persisted queue data is malformed',async()=>{
    let saved:unknown={consent:true,client_id:'private-invalid-value',queue:[null]};
    const send=vi.fn(async()=>204);
    const engine=createAnalyticsEngine({read:async()=>saved as AnalyticsState,write:async value=>{saved=value;},allowed:async()=>true,send,common:()=>({}),wake:()=>{},clearWake:()=>{}});
    await engine.flush();expect(send).not.toHaveBeenCalled();
    await engine.setConsent(false);expect(saved).toEqual({consent:false,queue:[]});
  });
  it('does not retry permanent rejection and preserves new events added during a send',async()=>{
    const f=fixture();await f.engine.setConsent(true);await f.engine.track('page_view',{screen:'library'});
    let complete:(status:number)=>void=()=>{};f.send.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=f.engine.flush();await vi.waitFor(()=>expect(f.send).toHaveBeenCalled());await f.engine.track('reader_open',{surface:'reader'});complete(400);await pending;
    expect(f.saved?.queue.map(e=>e.name)).toEqual(['reader_open']);
  });
});
describe('analytics task consent boundaries', () => {
  it('drops a task started while off even when it finishes after consent', async () => {
    const f = fixture();
    const startedAt = f.time;
    f.time += 1000;
    await f.engine.setConsent(true);
    f.time += 1000;
    await f.engine.track('import_result', {outcome: 'success', duration_ms: 2000}, startedAt);
    await f.engine.flush();
    expect(f.saved?.queue).toEqual([]);
    expect(f.ids).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('drops work from an earlier opt-in after withdrawal and a new opt-in', async () => {
    const f = fixture();
    await f.engine.setConsent(true);
    const startedAt = f.time;
    f.time += 1000;
    await f.engine.setConsent(false);
    f.time += 1000;
    await f.engine.setConsent(true);
    f.time += 1000;
    await f.engine.track('search_result', {outcome: 'success', duration_ms: 3000}, startedAt);
    await f.engine.flush();
    expect(f.saved?.consented_at).toBe(startedAt + 2000);
    expect(f.ids).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps valid same-consent task metrics without sending local boundary timestamps', async () => {
    const f = fixture();
    await f.engine.setConsent(true);
    const startedAt = f.time;
    f.time += 2000;
    await f.engine.track('import_result', {outcome: 'success', duration_ms: 2000}, startedAt);
    await f.engine.flush();
    const body = f.send.mock.calls[0][0] as {events: {name: string; params: Record<string, unknown>}[]};
    expect(body.events.find(event => event.name === 'import_result')?.params.duration_ms).toBe(2000);
    expect(JSON.stringify(body)).not.toMatch(/startedAt|consented_at/);
  });

  it('preserves the original consent boundary when enable is repeated', async () => {
    const f = fixture();
    await f.engine.setConsent(true);
    const startedAt = f.time;
    f.time += 1000;
    await f.engine.setConsent(true);
    expect(f.saved?.consented_at).toBe(startedAt);
    f.time += 1000;
    await f.engine.track('offline_download_result', {outcome: 'success', duration_ms: 2000}, startedAt);
    await f.engine.flush();
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('does not replay an acknowledged batch when enable is repeated during delivery', async () => {
    const f = fixture();
    await f.engine.setConsent(true);
    await f.engine.track('page_view', {screen: 'library'});
    let complete: (status: number) => void = () => {};
    f.send.mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    const sending = f.engine.flush();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await f.engine.setConsent(true);
    complete(204);
    await sending;
    await f.engine.flush();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.saved?.queue).toEqual([]);
  });
});
describe('analytics client boundary',()=>{
  beforeEach(()=>vi.stubGlobal('chrome',undefined));afterEach(()=>vi.unstubAllGlobals());
  it('is inert in web preview and isolates unavailable extension messaging',()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);expect(()=>clientTrack('page_view',{screen:'library'})).not.toThrow();expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal('chrome',{runtime:{id:'extension',sendMessage:()=>Promise.reject(Error('stopped'))}});
    expect(()=>clientTrack('reader_open',{})).not.toThrow();expect(fetch).not.toHaveBeenCalled();
  });
  it('captures an immediate event time and passes explicit task starts only in the internal envelope', () => {
    const sendMessage = vi.fn(async () => ({ok: true}));
    vi.stubGlobal('chrome', {runtime: {id: 'extension', sendMessage}});
    const before = Date.now();
    clientTrack('page_view', {screen: 'library'});
    const immediate = sendMessage.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(immediate[0].startedAt).toBeGreaterThanOrEqual(before);
    expect(immediate[0].startedAt).toBeLessThanOrEqual(Date.now());
    const startedAt = before - 2000;
    clientTrack('import_result', {outcome: 'success', duration_ms: 2000}, startedAt);
    const task = sendMessage.mock.calls[1] as unknown as [Record<string, unknown>];
    expect(task[0].startedAt).toBe(startedAt);
    expect(task[0].params).not.toHaveProperty('startedAt');
  });
});
