import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChannelConnectionInput,ChannelConnectionResult} from '../src/translation/channels/contracts';

const protocol=vi.hoisted(()=>({connect:vi.fn(),open:vi.fn()}));
vi.mock('../src/translation/channels/registry',()=>{
  const local={id:'fixture',label:'Fixture service',configurable:true,fields:[],connect:protocol.connect,open:protocol.open,
    permissionOrigins:(input:ChannelConnectionInput)=>[new URL(input.settings.baseUrl).origin+'/*']};
  const official={id:'nodelane',label:'NodeLane',configurable:false,fields:[],open:vi.fn()};
  return {channelDefinitions:()=>[official,local],channelDefinition:(id:string)=>id==='nodelane'?official:local};
});

let metadata:Record<string,unknown>;
let changes:Set<(change:Record<string,unknown>,area:string)=>void>;
let permission:ReturnType<typeof vi.fn>;
function installLocks(enabled:boolean){
  const queues=new Map<string,Promise<unknown>>();
  const request=vi.fn((name:string,run:()=>Promise<unknown>)=>{
    const next=(queues.get(name)??Promise.resolve()).then(run,run);queues.set(name,next.catch(()=>{}));return next;
  });
  vi.stubGlobal('navigator',enabled?{locks:{request}}:{});return request;
}
function input(baseUrl='http://127.0.0.1:8000',password='fixture-password'):ChannelConnectionInput{
  return {settings:{baseUrl,username:'fixture-reader'},secrets:{password}};
}
function result(value:ChannelConnectionInput):ChannelConnectionResult{
  return {settings:{baseUrl:value.settings.baseUrl,username:value.settings.username},secrets:{token:'private-token-'+value.secrets.password}};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

beforeEach(()=>{
  vi.resetModules();protocol.connect.mockReset().mockImplementation(async(value:ChannelConnectionInput)=>result(value));protocol.open.mockReset();
  vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
  metadata={};changes=new Set();permission=vi.fn(async()=>true);installLocks(true);
  vi.stubGlobal('chrome',{permissions:{request:permission},storage:{local:{
    get:vi.fn(async(key:string)=>({[key]:structuredClone(metadata[key])})),
    set:vi.fn(async(values:Record<string,unknown>)=>{
      const event:Record<string,unknown>={};
      for(const [key,value] of Object.entries(values)){event[key]={oldValue:metadata[key],newValue:structuredClone(value)};metadata[key]=structuredClone(value);}
      for(const listener of changes)listener(event,'local');
    }),
  },onChanged:{addListener:(listener:(change:Record<string,unknown>,area:string)=>void)=>changes.add(listener),removeListener:(listener:(change:Record<string,unknown>,area:string)=>void)=>changes.delete(listener)}}});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('channel configuration and connection',()=>{
  it.each([true,false])('keeps both concurrent additions with Web Locks=%s',async enabled=>{
    const locks=installLocks(enabled),{connectChannel,listChannels}=await import('../src/translation/channels');
    const {readChannelSecrets,channelSettingsKey}=await import('../src/translation/channels/configuration');
    const one=input('http://127.0.0.1:8001','one'),two=input('http://127.0.0.1:8002','two');
    const profiles=await Promise.all([connectChannel('fixture','First',one),connectChannel('fixture','Second',two)]);
    const saved=await listChannels();expect(saved.profiles.map(profile=>profile.name).sort()).toEqual(['First','NodeLane','Second']);
    expect(new Set(profiles.map(profile=>profile.id)).size).toBe(2);
    expect(await readChannelSecrets(profiles[0].id)).toEqual(result(one).secrets);expect(await readChannelSecrets(profiles[1].id)).toEqual(result(two).secrets);
    if(enabled)expect(locks).toHaveBeenCalledWith(channelSettingsKey,expect.any(Function));else expect(locks).not.toHaveBeenCalled();
  });
  it('selects a configured channel and returns to official when the active profile is removed',async()=>{
    const {connectChannel,selectChannel,removeChannel,listChannels}=await import('../src/translation/channels');
    const {readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input());await selectChannel(profile.id);
    expect((await listChannels()).activeId).toBe(profile.id);await removeChannel(profile.id);
    expect(await listChannels()).toMatchObject({activeId:'nodelane',profiles:[{id:'nodelane'}]});expect(await readChannelSecrets(profile.id)).toEqual({});
    await expect(selectChannel(profile.id)).rejects.toThrow('已移除');await expect(removeChannel('nodelane')).rejects.toThrow('不能移除');
  });
  it('keeps revision on token rotation, notifies once per write, and revises a changed address',async()=>{
    const {connectChannel}=await import('../src/translation/channels');
    const {channelSettingsKey,readChannelSecrets,subscribeChannelSettings}=await import('../src/translation/channels/configuration');
    const listener=vi.fn(),unsubscribe=subscribeChannelSettings(listener);
    const first=await connectChannel('fixture','First name',input());expect(listener).toHaveBeenCalledOnce();
    const initialChange=(metadata[channelSettingsKey] as {changeId:string}).changeId;
    const rotated=await connectChannel('fixture','New name',input(undefined,'rotated-password'),first.id);
    expect(rotated).toMatchObject({id:first.id,name:'New name',revision:1});expect(listener).toHaveBeenCalledTimes(2);
    expect((metadata[channelSettingsKey] as {changeId:string}).changeId).not.toBe(initialChange);
    expect(await readChannelSecrets(first.id)).toEqual({token:'private-token-rotated-password'});
    const moved=await connectChannel('fixture','New name',input('http://127.0.0.1:9000','rotated-password'),first.id);
    expect(moved.revision).toBe(2);expect(listener).toHaveBeenCalledTimes(3);unsubscribe();expect(changes.size).toBe(0);
  });
  it('stores credentials only in IndexedDB and supplies them only when opening the selected channel',async()=>{
    const {connectChannel,selectChannel,openActiveChannel}=await import('../src/translation/channels');
    const {readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input()),secrets=await readChannelSecrets(profile.id);
    const stored=JSON.stringify(metadata);expect(stored).not.toContain('private-token');expect(stored).not.toContain('fixture-password');expect(stored).not.toContain('"password"');expect(stored).not.toContain('"token"');
    expect(secrets).toEqual({token:'private-token-fixture-password'});await selectChannel(profile.id);
    const current=()=>true;await openActiveChannel(current);expect(protocol.open).toHaveBeenCalledWith(profile,secrets,current);
  });
  it('does not recreate a removed profile when a pending reconnect returns',async()=>{
    const {connectChannel,selectChannel,removeChannel,listChannels}=await import('../src/translation/channels');
    const {readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input());await selectChannel(profile.id);
    const pending=deferred<ChannelConnectionResult>();protocol.connect.mockImplementationOnce(()=>pending.promise);
    const reconnect=connectChannel('fixture','Late',input(undefined,'late-password'),profile.id);
    await vi.waitFor(()=>expect(protocol.connect).toHaveBeenCalledTimes(2));await removeChannel(profile.id);
    pending.resolve(result(input(undefined,'late-password')));await expect(reconnect).rejects.toThrow('已移除');
    expect((await listChannels()).profiles.map(item=>item.id)).toEqual(['nodelane']);expect(await readChannelSecrets(profile.id)).toEqual({});
  });
  it('does not log in or save a profile when host permission is denied',async()=>{
    permission.mockResolvedValue(false);const {connectChannel,listChannels}=await import('../src/translation/channels');
    await expect(connectChannel('fixture','Denied',input())).rejects.toThrow('访问权限');
    expect(permission).toHaveBeenCalledWith({origins:['http://127.0.0.1:8000/*']});expect(protocol.connect).not.toHaveBeenCalled();
    expect((await listChannels()).profiles.map(profile=>profile.id)).toEqual(['nodelane']);expect(metadata).toEqual({});
  });
});
