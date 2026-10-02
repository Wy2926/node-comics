import {afterEach,describe,expect,it,vi} from 'vitest';

afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
function localFixture(){
  const data=new Map<string,string>(),changed=vi.fn();
  vi.stubGlobal('chrome',undefined);vi.stubGlobal('window',{addEventListener:changed});
  vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:vi.fn((key:string,value:string)=>data.set(key,value))});
  return {data,changed};
}
describe('shortcut preference persistence',()=>{
  it('persists versioned overrides independently of reader preferences and reloads them',async()=>{
    const f=localFixture();let store=await import('../src/shortcuts/store');
    await store.initializeShortcuts();expect(store.getShortcutSnapshot()).toMatchObject({ready:true,error:false,overrides:{}});
    await store.saveShortcutOverrides({'reader.original':['Ctrl+Alt+KeyO'],'reader.next':[]});
    expect([...f.data.keys()]).toEqual(['nc-shortcuts']);
    vi.resetModules();store=await import('../src/shortcuts/store');await store.initializeShortcuts();
    expect(store.getShortcutSnapshot().overrides).toEqual({'reader.original':['Ctrl+Alt+KeyO'],'reader.next':[]});
  });
  it('preserves last working preferences on failed writes and can retry',async()=>{
    localFixture();const store=await import('../src/shortcuts/store');await store.initializeShortcuts();
    await store.saveShortcutOverrides({'reader.next':[]});
    vi.mocked(localStorage.setItem).mockImplementationOnce(()=>{throw Error('Storage full');});
    await expect(store.saveShortcutOverrides({'reader.original':[]})).rejects.toThrow('Storage full');
    expect(store.getShortcutSnapshot()).toMatchObject({error:true,overrides:{'reader.next':[]}});
    await store.saveShortcutOverrides({'reader.original':[]});expect(store.getShortcutSnapshot()).toMatchObject({error:false,overrides:{'reader.original':[]}});
  });
  it.each(['{bad','null','{"version":2,"overrides":{"reader.next":[]}}'])('handles unsupported/corrupt stored payload %s',async value=>{
    const f=localFixture();f.data.set('nc-shortcuts',value);const store=await import('../src/shortcuts/store');await store.initializeShortcuts();
    expect(store.getShortcutSnapshot()).toMatchObject({ready:true,overrides:{}});
  });
  it('uses trusted extension storage, live updates and rejects a stale initial read',async()=>{
    let resolve!:(value:object)=>void,listener!:(changes:Record<string,{newValue:unknown}>,area:string)=>void;
    const get=vi.fn(()=>new Promise<object>(done=>{resolve=done;})),set=vi.fn();
    vi.stubGlobal('chrome',{storage:{local:{get,set},onChanged:{addListener:(callback:typeof listener)=>{listener=callback;}}}});
    const store=await import('../src/shortcuts/store'),loaded=store.initializeShortcuts();
    listener({'nc-shortcuts':{newValue:{version:1,overrides:{'reader.next':[]}}}},'local');
    resolve({'nc-shortcuts':{version:1,overrides:{'reader.original':[]}}});await loaded;
    expect(store.getShortcutSnapshot().overrides).toEqual({'reader.next':[]});
    await store.saveShortcutOverrides({'reader.fullscreen':[]});
    expect(set).toHaveBeenCalledWith({'nc-shortcuts':{version:1,overrides:{'reader.fullscreen':[]}}});
    listener({'nc-shortcuts':{newValue:undefined}},'local');expect(store.getShortcutSnapshot().overrides).toEqual({});
  });
  it('reports unavailable preference reads without throwing during page startup',async()=>{
    localFixture();vi.stubGlobal('localStorage',{getItem:()=>{throw Error('Denied');}});
    const store=await import('../src/shortcuts/store');await expect(store.initializeShortcuts()).resolves.toBeUndefined();
    expect(store.getShortcutSnapshot()).toMatchObject({ready:false,error:true});
  });
  it('does not publish an older save over a newer cross-window change',async()=>{
    let complete!:()=>void,listener!:(changes:Record<string,{newValue:unknown}>,area:string)=>void;
    vi.stubGlobal('chrome',{storage:{local:{get:async()=>({}),set:()=>new Promise<void>(done=>{complete=done;})},onChanged:{addListener:(callback:typeof listener)=>{listener=callback;}}}});
    const store=await import('../src/shortcuts/store');await store.initializeShortcuts();
    const save=store.saveShortcutOverrides({'reader.next':[]});
    listener({'nc-shortcuts':{newValue:{version:1,overrides:{'reader.original':[]}}}},'local');
    complete();await save;
    expect(store.getShortcutSnapshot().overrides).toEqual({'reader.original':[]});
  });
});
