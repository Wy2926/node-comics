import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChannelConnectionInput,ChannelConnectionResult} from '../src/translation/channels/contracts';

const protocol=vi.hoisted(()=>({connect:vi.fn(),open:vi.fn()}));
vi.mock('../src/translation/channels/registry',()=>{
  const local={id:'fixture',label:'Fixture service',configurable:true,fields:[{key:'password',type:'password',required:true}],connect:protocol.connect,open:protocol.open,
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
  return {settings:{baseUrl:value.settings.baseUrl,username:value.settings.username},secrets:{token:'private-token-'+value.secrets.password,password:value.secrets.password}};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

beforeEach(()=>{
  vi.resetModules();protocol.connect.mockReset().mockImplementation(async(value:ChannelConnectionInput)=>result(value));protocol.open.mockReset();
  vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
  metadata={};changes=new Set();permission=vi.fn(async()=>true);installLocks(true);
  vi.stubGlobal('chrome',{runtime:{id:'test-extension'},permissions:{contains:permission,request:vi.fn(async()=>true)},storage:{local:{
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
    expect(await readChannelSecrets(first.id)).toEqual({token:'private-token-rotated-password',password:'rotated-password'});
    const moved=await connectChannel('fixture','New name',input('http://127.0.0.1:9000','rotated-password'),first.id);
    expect(moved.revision).toBe(2);expect(listener).toHaveBeenCalledTimes(3);unsubscribe();expect(changes.size).toBe(0);
  });
  it('stores credentials only in IndexedDB and supplies them only when opening the selected channel',async()=>{
    const {connectChannel,selectChannel,openActiveChannel}=await import('../src/translation/channels');
    const {readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input()),secrets=await readChannelSecrets(profile.id);
    const stored=JSON.stringify(metadata);expect(stored).not.toContain('private-token');expect(stored).not.toContain('fixture-password');expect(stored).not.toContain('"password"');expect(stored).not.toContain('"token"');
    expect(secrets).toEqual({token:'private-token-fixture-password',password:'fixture-password'});await selectChannel(profile.id);
    const current=()=>true;await openActiveChannel(current);expect(protocol.open).toHaveBeenCalledWith(profile,secrets,current);
  });
  it('reuses only the declared saved password for an unchanged destination without exposing its value to the settings UI',async()=>{
    const {connectChannel,savedChannelSecretFields}=await import('../src/translation/channels');
    const {readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input());
    expect(await savedChannelSecretFields(profile.id)).toEqual(['token','password']);
    const supplied=input(undefined,'');
    const reconnected=await connectChannel('fixture','Renamed',supplied,profile.id);
    expect(protocol.connect).toHaveBeenLastCalledWith(input());
    expect(supplied.secrets).toEqual({password:''});
    expect(reconnected).toMatchObject({id:profile.id,revision:profile.revision,name:'Renamed'});
    expect(await readChannelSecrets(profile.id)).toEqual(result(input()).secrets);
  });
  it.each(['address','username','adapter','added setting','removed setting'])('does not send a saved password after changing the %s',async change=>{
    const {connectChannel,listChannels}=await import('../src/translation/channels');
    const {readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input()),next=input(undefined,'');
    let adapterId='fixture';
    if(change==='address')next.settings.baseUrl='http://127.0.0.1:9000';
    if(change==='username')next.settings.username='different-reader';
    if(change==='adapter')adapterId='another-fixture';
    if(change==='added setting')next.settings.extra='new-setting';
    if(change==='removed setting')delete next.settings.username;
    protocol.connect.mockRejectedValueOnce(Error('Password required'));
    await expect(connectChannel(adapterId,'Changed',next,profile.id)).rejects.toThrow('Password required');
    expect(protocol.connect).toHaveBeenLastCalledWith(next);
    expect(protocol.connect.mock.calls.at(-1)?.[0].secrets).toEqual({password:''});
    expect((await listChannels()).profiles.find(item=>item.id===profile.id)).toEqual(profile);
    expect(await readChannelSecrets(profile.id)).toEqual(result(input()).secrets);
  });
  it('requires a password once for a legacy token-only profile, then supports blank-password reconnects',async()=>{
    const {connectChannel,selectChannel,openActiveChannel,savedChannelSecretFields}=await import('../src/translation/channels');
    const {readChannelSecrets,writeChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Legacy',input());
    await writeChannelSecrets(profile.id,{token:'legacy-token'});
    expect(await savedChannelSecretFields(profile.id)).toEqual([]);
    await selectChannel(profile.id);
    const current=()=>true;await openActiveChannel(current);
    expect(protocol.open).toHaveBeenLastCalledWith(profile,{token:'legacy-token'},current);
    protocol.connect.mockImplementation(async(value:ChannelConnectionInput)=>{
      if(!value.secrets.password)throw Error('Password required');return result(value);
    });
    await expect(connectChannel('fixture','Legacy',input(undefined,''),profile.id)).rejects.toThrow('Password required');
    expect(protocol.connect).toHaveBeenLastCalledWith(input(undefined,''));
    expect(await readChannelSecrets(profile.id)).toEqual({token:'legacy-token'});
    await connectChannel('fixture','Legacy',input(undefined,'new-password'),profile.id);
    await connectChannel('fixture','Legacy',input(undefined,''),profile.id);
    expect(protocol.connect).toHaveBeenLastCalledWith(input(undefined,'new-password'));
    expect(await readChannelSecrets(profile.id)).toEqual(result(input(undefined,'new-password')).secrets);
  });
  it('keeps the selected profile and saved credentials when a replacement password fails to connect',async()=>{
    const {connectChannel,listChannels,selectChannel}=await import('../src/translation/channels');
    const {readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input());await selectChannel(profile.id);
    const before=structuredClone(metadata);
    protocol.connect.mockRejectedValueOnce(Error('Login failed'));
    await expect(connectChannel('fixture','Replacement',input(undefined,'incorrect-password'),profile.id)).rejects.toThrow('Login failed');
    expect(protocol.connect).toHaveBeenLastCalledWith(input(undefined,'incorrect-password'));
    expect(metadata).toEqual(before);
    expect((await listChannels()).activeId).toBe(profile.id);
    expect(await readChannelSecrets(profile.id)).toEqual(result(input()).secrets);
  });
  it.each([true,false])('reads credentials after a concurrent settings mutation completes with Web Locks=%s',async enabled=>{
    installLocks(enabled);
    const {connectChannel}=await import('../src/translation/channels');
    const {readChannelCredentials,updateChannelSettings,writeChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Local',input()),entered=deferred<void>(),release=deferred<void>();
    const updated={...profile,settings:{...profile.settings,baseUrl:'http://127.0.0.1:9000'}};
    const updatedSecrets={password:'other-password',token:'other-token'};
    const mutation=updateChannelSettings(async value=>{
      await writeChannelSecrets(profile.id,updatedSecrets,updated);entered.resolve();await release.promise;
      return {...value,profiles:value.profiles.map(item=>item.id===profile.id?updated:item)};
    });
    await entered.promise;
    const credentials=readChannelCredentials(profile.id);
    release.resolve();await mutation;
    expect(await credentials).toEqual({profile:updated,secrets:updatedSecrets});
  });
  it.each([true,false])('blocks credentials for a different destination after a settings write fails with Web Locks=%s',async enabled=>{
    installLocks(enabled);
    const {connectChannel,listChannels,selectChannel,savedChannelSecretFields,openActiveChannel}=await import('../src/translation/channels');
    const {readChannelCredentials,readChannelSecrets}=await import('../src/translation/channels/configuration');
    const profile=await connectChannel('fixture','Destination A',input());await selectChannel(profile.id);
    const before=structuredClone(metadata),destinationB=input('http://127.0.0.1:9000','destination-b-password');
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(Error('Settings write failed'));
    await expect(connectChannel('fixture','Destination B',destinationB,profile.id)).rejects.toThrow('Settings write failed');
    expect(protocol.connect).toHaveBeenLastCalledWith(destinationB);
    expect(metadata).toEqual(before);
    expect(await readChannelSecrets(profile.id)).toEqual(result(destinationB).secrets);
    expect(await readChannelCredentials(profile.id)).toEqual({profile,secrets:{}});
    expect(await savedChannelSecretFields(profile.id)).toEqual([]);
    const current=()=>true;await openActiveChannel(current);
    expect(protocol.open).toHaveBeenLastCalledWith(profile,{},current);
    protocol.connect.mockImplementation(async(value:ChannelConnectionInput)=>{
      if(!value.secrets.password)throw Error('Password required');return result(value);
    });
    await expect(connectChannel('fixture','Destination A',input(undefined,''),profile.id)).rejects.toThrow('Password required');
    expect(protocol.connect).toHaveBeenLastCalledWith(input(undefined,''));
    expect(metadata).toEqual(before);
    const restored=await connectChannel('fixture','Destination A',input(),profile.id);
    expect(restored).toEqual(profile);
    expect((await listChannels()).activeId).toBe(profile.id);
    expect(await savedChannelSecretFields(profile.id)).toEqual(['token','password']);
    expect(await readChannelSecrets(profile.id,restored)).toEqual(result(input()).secrets);
    await openActiveChannel(current);
    expect(protocol.open).toHaveBeenLastCalledWith(restored,result(input()).secrets,current);
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
  it('does not prompt, log in or save a profile when browser host access is revoked',async()=>{
    permission.mockResolvedValue(false);const {connectChannel,listChannels}=await import('../src/translation/channels');
    await expect(connectChannel('fixture','Denied',input())).rejects.toThrow('访问权限');
    expect(permission).toHaveBeenCalledWith({origins:['http://127.0.0.1:8000/*']});expect(protocol.connect).not.toHaveBeenCalled();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect((await listChannels()).profiles.map(profile=>profile.id)).toEqual(['nodelane']);expect(metadata).toEqual({});
  });
});
