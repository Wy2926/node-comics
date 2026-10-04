import {describe,expect,it,vi} from 'vitest';
import {shortcutCommands,type ShortcutOverrides} from '../src/shortcuts/catalog';
import {bindingFromEvent,formatBinding,validateBinding} from '../src/shortcuts/keys';
import {activeBindings,findConflict,normalizeOverrides,resolveBindings,scopesOverlap} from '../src/shortcuts/model';
import {bindShortcuts} from '../src/shortcuts/runtime';

function keyboard(code:string,values:Partial<KeyboardEvent>={}){
  return {code,key:code.replace('Key',''),keyCode:0,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,isComposing:false,repeat:false,defaultPrevented:false,
    getModifierState:()=>false,composedPath:()=>[],preventDefault:vi.fn(),...values} as unknown as KeyboardEvent;
}
function fixture(){
  const listeners=new Map<string,Set<(event:KeyboardEvent)=>void>>(),querySelector=vi.fn().mockReturnValue(null);
  const target={document:{querySelector},addEventListener:(type:string,listener:(event:KeyboardEvent)=>void)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(listener);},removeEventListener:(type:string,listener:(event:KeyboardEvent)=>void)=>listeners.get(type)?.delete(listener)} as unknown as Window;
  return {target,listeners,querySelector,emit:(type:string,event:KeyboardEvent)=>{for(const listener of listeners.get(type)??[])listener(event);}};
}

describe('shortcut catalog and normalization',()=>{
  it('has unique IDs, valid defaults, no scope collisions and bounded alternatives',()=>{
    expect(new Set(shortcutCommands.map(command=>command.id)).size).toBe(shortcutCommands.length);
    for(const command of shortcutCommands){
      expect(command.defaults.length).toBeLessThanOrEqual(2);
      for(const binding of command.defaults){expect(validateBinding(binding)).toBeUndefined();expect(findConflict(command.id,binding,{})).toBeUndefined();}
    }
  });
  it('supports exact multi-modifier combinations, layout-independent codes and native labels',()=>{
    expect(bindingFromEvent(keyboard('KeyQ',{key:'a',ctrlKey:true,altKey:true,shiftKey:true,metaKey:true}))).toBe('Ctrl+Alt+Shift+Meta+KeyQ');
    expect(formatBinding('Ctrl+Shift+KeyQ')).toBe('Ctrl + Shift + Q');
    expect(formatBinding('Meta+ArrowRight')).toBe('⌘ + →');
  });
  it.each(['Escape','Tab','Ctrl+KeyL','Meta+KeyR','Ctrl+Shift+KeyT','Ctrl+Digit1','Alt+ArrowLeft','Alt+F4','F5','F12','Shift+F10','Ctrl+KeyE','Ctrl+KeyK','Ctrl+F4','Alt+KeyD'])('reserves browser/system controls %s',binding=>expect(validateBinding(binding)).toBe('reserved'));
  it.each(['','A','KeyAB','Alt+Ctrl+KeyK','Ctrl+Ctrl+KeyK','Ctrl+','Control+KeyQ','__proto__','F13'])('rejects invalid bindings %s',binding=>expect(validateBinding(binding)).toBe('invalid'));
  it('ignores IME, dead keys, AltGraph and modifier-only events',()=>{
    for(const values of [{isComposing:true},{keyCode:229},{key:'Dead'},{key:'Process'},{getModifierState:()=>true}])expect(bindingFromEvent(keyboard('KeyT',values))).toBeUndefined();
    expect(bindingFromEvent(keyboard('ShiftLeft'))).toBeUndefined();
  });
  it('preserves deliberate disable, strips unknown keys, invalid values and redundant defaults',()=>{
    const saved=normalizeOverrides({'reader.next':[],'reader.previous':['Ctrl+Alt+KeyN','Ctrl+Alt+KeyN'],'reader.original':['Ctrl+KeyR'],'reader.fullscreen':['KeyF'],oops:['KeyQ'],'reader.fit':'KeyQ','reader.layout':['KeyQ','KeyW','KeyE']});
    expect(saved).toEqual({'reader.next':[],'reader.previous':['Ctrl+Alt+KeyN']});
    expect(resolveBindings('reader.next',saved)).toEqual([]);
    expect(resolveBindings('reader.fullscreen',saved)).toEqual(['KeyF']);
    for(const corrupt of [null,[],true,'bad'])expect(normalizeOverrides(corrupt)).toEqual({});
  });
  it('allows disjoint scopes, rejects shared/global scopes, fails closed on corrupt conflicts',()=>{
    expect(scopesOverlap('reader','app')).toBe(false);
    expect(scopesOverlap('global','reader')).toBe(true);
    expect(scopesOverlap('global','web')).toBe(false);
    expect(findConflict('reader.next','KeyO',{})).toBe('reader.original');
    expect(findConflict('reader.next','Alt+Digit1',{})).toBeUndefined();
    expect(findConflict('reader.next','Shift+Slash',{})).toBe('app.shortcuts');
    expect(activeBindings({'reader.next':['KeyO']}).has('KeyO')).toBe(false);
  });
  it('discards retired tab-translation page bindings without changing other preferences',()=>{
    expect(normalizeOverrides({'web.translate':['Ctrl+Alt+KeyT'],'web.pause':[]})).toEqual({'web.pause':[]});
    expect(activeBindings({}).has('Alt+Shift+KeyT')).toBe(false);
  });
});

describe('shortcut dispatch',()=>{
  it('runs callbacks, consumes only handled keys, and sees live preferences',()=>{
    const f=fixture(),run=vi.fn(),disabled=vi.fn(()=>false);
    let overrides:ShortcutOverrides={};
    bindShortcuts(f.target,{'reader.next':run,'reader.previous':disabled},{getOverrides:()=>overrides});
    const next=keyboard('KeyJ');f.emit('keydown',next);expect(run).toHaveBeenCalledOnce();expect(next.preventDefault).toHaveBeenCalledOnce();
    const previous=keyboard('KeyK');f.emit('keydown',previous);expect(previous.preventDefault).not.toHaveBeenCalled();
    overrides={'reader.next':['Ctrl+Alt+KeyN']};f.emit('keydown',keyboard('KeyJ'));expect(run).toHaveBeenCalledOnce();
    f.emit('keydown',keyboard('KeyN',{ctrlKey:true,altKey:true}));expect(run).toHaveBeenCalledTimes(2);
    overrides={'reader.next':[]};f.emit('keydown',keyboard('KeyN',{ctrlKey:true,altKey:true}));expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not match extra modifiers or spend DOM work on unrelated keys',()=>{
    const f=fixture(),run=vi.fn();bindShortcuts(f.target,{'reader.original':run},{getOverrides:()=>({})});
    f.emit('keydown',keyboard('KeyO',{ctrlKey:true}));f.emit('keydown',keyboard('KeyQ'));
    expect(run).not.toHaveBeenCalled();expect(f.querySelector).not.toHaveBeenCalled();
  });
  it('ignores IME, prevented events, disabled scopes and editable composed targets',()=>{
    const f=fixture(),run=vi.fn();let enabled=true;
    bindShortcuts(f.target,{'reader.original':run},{getOverrides:()=>({}),enabled:()=>enabled});
    f.emit('keydown',keyboard('KeyO',{isComposing:true}));
    f.emit('keydown',keyboard('KeyO',{defaultPrevented:true}));
    f.emit('keydown',keyboard('KeyO',{composedPath:()=>[{closest:()=>({})}] as unknown as EventTarget[]}));
    enabled=false;f.emit('keydown',keyboard('KeyO'));expect(run).not.toHaveBeenCalled();
  });
  it('preserves dialogs and grouped controls while allowing page navigation after a toolbar click',()=>{
    const f=fixture(),run=vi.fn();bindShortcuts(f.target,{'reader.next':run},{getOverrides:()=>({})});
    f.querySelector.mockReturnValue({});f.emit('keydown',keyboard('KeyJ'));expect(run).not.toHaveBeenCalled();
    f.querySelector.mockReturnValue(null);
    f.emit('keydown',keyboard('PageDown',{composedPath:()=>[{closest:(selector:string)=>selector==='[role="group"]'?{}:null}] as unknown as EventTarget[]}));
    expect(run).not.toHaveBeenCalled();
    f.emit('keydown',keyboard('PageDown',{composedPath:()=>[{closest:(selector:string)=>selector.startsWith('button')?{}:null}] as unknown as EventTarget[]}));
    expect(run).toHaveBeenCalledOnce();
  });
  it('prevents held action re-entry but permits navigation repeats and unregisters all listeners',()=>{
    const f=fixture(),action=vi.fn(),next=vi.fn(),overrides={};
    const stop=bindShortcuts(f.target,{'reader.translation':action,'reader.next':next},{getOverrides:()=>overrides});
    f.emit('keydown',keyboard('KeyT'));f.emit('keydown',keyboard('KeyT',{repeat:true}));f.emit('keydown',keyboard('KeyT'));
    expect(action).toHaveBeenCalledOnce();
    f.emit('keyup',keyboard('KeyT'));f.emit('keydown',keyboard('KeyT'));expect(action).toHaveBeenCalledTimes(2);
    f.emit('blur',keyboard(''));f.emit('keydown',keyboard('KeyT'));expect(action).toHaveBeenCalledTimes(3);
    f.emit('keydown',keyboard('KeyJ'));f.emit('keydown',keyboard('KeyJ',{repeat:true}));expect(next).toHaveBeenCalledTimes(2);
    stop();for(const listeners of f.listeners.values())expect(listeners.size).toBe(0);
  });
  it('does bounded work for ordinary typing: no DOM query and no handler dispatch',()=>{
    const f=fixture(),run=vi.fn(),overrides={};
    bindShortcuts(f.target,{'reader.original':run},{getOverrides:()=>overrides});
    for(let i=0;i<10000;i++)f.emit('keydown',keyboard('KeyQ'));
    expect(f.querySelector).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
  });
});
