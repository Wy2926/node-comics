import {afterEach,beforeEach,describe,expect,it,vi,type Mock} from 'vitest';
import {automaticTabsAllowed,registerAutomaticTabs} from '../src/inline/auto-tabs';
import {settingsKey} from '../src/inline/settings';
import {defaults} from '../src/types';

const event=()=>{const listeners:((...args:any[])=>void)[]=[];return {addListener:(fn:(...args:any[])=>void)=>listeners.push(fn),emit:(...args:any[])=>listeners.forEach(fn=>fn(...args))};};
let value={...defaults},granted=true;
let tabs:chrome.tabs.Tab[],updated:ReturnType<typeof event>,activated:ReturnType<typeof event>,changed:ReturnType<typeof event>,removed:ReturnType<typeof event>,startup:ReturnType<typeof event>;
let activate:Mock<(tabId:number,automatic:boolean)=>Promise<void>>,stop:Mock<(tabId:number)=>Promise<void>>;
beforeEach(()=>{
 value={...defaults};granted=true;tabs=[{id:1,url:'https://comic.example/chapter',active:true,status:'complete'},{id:2,url:'https://comic.example/next',active:false,status:'complete'},{id:3,url:'chrome://settings',active:true,status:'complete'}] as chrome.tabs.Tab[];
 updated=event();activated=event();changed=event();removed=event();startup=event();activate=vi.fn(async()=>{});stop=vi.fn(async()=>{});
 vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async()=>({[settingsKey]:value})),set:vi.fn(async data=>{const oldValue=value;value=data[settingsKey];changed.emit({[settingsKey]:{oldValue,newValue:value}},'local');})},onChanged:changed},permissions:{contains:vi.fn(async()=>granted),onRemoved:removed},tabs:{query:vi.fn(async()=>tabs),get:vi.fn(async id=>tabs.find(tab=>tab.id===id)),onUpdated:updated,onActivated:activated},runtime:{onStartup:startup}});
});
afterEach(()=>vi.unstubAllGlobals());
describe('automatic webpage entry',()=>{
 it('is opt-in and never starts without persistent origin permission',async()=>{
  expect(await automaticTabsAllowed()).toBe(false);value.autoTranslateTabs=true;granted=false;expect(await automaticTabsAllowed()).toBe(false);
  registerAutomaticTabs(activate,stop);await vi.waitFor(()=>expect(stop).toHaveBeenCalledTimes(3));expect(activate).not.toHaveBeenCalled();
 });
 it('restores an enabled preference when the background worker starts, only for visible web tabs',async()=>{
  value.autoTranslateTabs=true;registerAutomaticTabs(activate,stop);await vi.waitFor(()=>expect(activate).toHaveBeenCalledExactlyOnceWith(1,true));expect(stop).not.toHaveBeenCalled();
 });
 it('starts on tab activation and completed navigation, excluding loading and browser pages',async()=>{
  registerAutomaticTabs(activate,stop);await vi.waitFor(()=>expect(stop).toHaveBeenCalledTimes(3));value.autoTranslateTabs=true;
  updated.emit(1,{status:'loading'},{...tabs[0],status:'loading'});updated.emit(3,{status:'complete'},tabs[2]);updated.emit(2,{status:'complete'},tabs[1]);
  updated.emit(1,{status:'complete'},tabs[0]);await vi.waitFor(()=>expect(activate).toHaveBeenCalledTimes(1));
  tabs[1].active=true;activated.emit({tabId:2});await vi.waitFor(()=>expect(activate).toHaveBeenLastCalledWith(2,true));
 });
 it('reconciles existing tabs on preference changes and stops automatically started sessions on disable',async()=>{
  registerAutomaticTabs(activate,stop);await vi.waitFor(()=>expect(stop).toHaveBeenCalledTimes(3));stop.mockClear();
  const oldValue=value;value={...value,autoTranslateTabs:true};changed.emit({[settingsKey]:{oldValue,newValue:value}},'local');await vi.waitFor(()=>expect(activate).toHaveBeenCalledWith(1,true));
  const enabled=value;value={...value,autoTranslateTabs:false};changed.emit({[settingsKey]:{oldValue:enabled,newValue:value}},'local');await vi.waitFor(()=>expect(stop).toHaveBeenCalledTimes(3));
 });
 it('does not reactivate tabs when only the target language changes',async()=>{
  value.autoTranslateTabs=true;registerAutomaticTabs(activate,stop);await vi.waitFor(()=>expect(activate).toHaveBeenCalledTimes(1));activate.mockClear();
  const oldValue=value;value={...value,language:'en'};changed.emit({[settingsKey]:{oldValue,newValue:value}},'local');await Promise.resolve();expect(activate).not.toHaveBeenCalled();
 });
 it('turns the preference off and stops automatic sessions after permission revocation',async()=>{
  value.autoTranslateTabs=true;registerAutomaticTabs(activate,stop);await vi.waitFor(()=>expect(activate).toHaveBeenCalledTimes(1));granted=false;removed.emit({origins:['https://*/*']});
  await vi.waitFor(()=>expect(value.autoTranslateTabs).toBe(false));await vi.waitFor(()=>expect(stop).toHaveBeenCalledWith(1));expect(value.language).toBe(defaults.language);
 });
});
