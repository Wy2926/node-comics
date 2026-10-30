import {afterEach,beforeEach,describe,expect,it,vi,type Mock} from 'vitest';
import {automaticTabsAllowed,registerAutomaticTabs} from '../src/inline/auto-tabs';
import {settingsKey} from '../src/inline/settings';
import {defaults,type Settings} from '../src/types';
const host=vi.hoisted(()=>({ensure:vi.fn(async()=>{})}));
vi.mock('../src/translation/channels/host-background',()=>({ensureLocalHost:host.ensure}));
const event=()=>{const listeners:((...args:any[])=>void)[]=[];return {addListener:(fn:(...args:any[])=>void)=>listeners.push(fn),emit:(...args:any[])=>listeners.forEach(fn=>fn(...args))};};
const site={hostname:'comic.example',enabled:true,scope:'domain' as const,value:''};
let value:Settings,granted=true;
let tabs:chrome.tabs.Tab[],updated:ReturnType<typeof event>,activated:ReturnType<typeof event>,changed:ReturnType<typeof event>,removed:ReturnType<typeof event>,startup:ReturnType<typeof event>;
let activate:Mock<(tabId:number,automatic:boolean)=>Promise<void>>,stop:Mock<(tabId:number)=>Promise<void>>;
const change=(next:Partial<Settings>)=>{const oldValue=value;value={...value,...next};changed.emit({[settingsKey]:{oldValue,newValue:value}},'local');};
beforeEach(()=>{
 value={...defaults,autoTranslateSites:[site]};granted=true;host.ensure.mockClear();tabs=[{id:1,url:'https://comic.example/chapter',active:true,status:'complete'},{id:2,url:'https://comic.example/next',active:false,status:'complete'},{id:3,url:'chrome://settings',active:true,status:'complete'},{id:4,url:'https://other.example/chapter',active:true,status:'complete'}] as chrome.tabs.Tab[];
 updated=event();activated=event();changed=event();removed=event();startup=event();activate=vi.fn(async()=>{});stop=vi.fn(async()=>{});
 vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async()=>({[settingsKey]:value})),set:vi.fn(async data=>change(data[settingsKey]))},onChanged:changed},permissions:{contains:vi.fn(async()=>granted),onRemoved:removed},tabs:{query:vi.fn(async()=>tabs),get:vi.fn(async id=>tabs.find(tab=>tab.id===id)),onUpdated:updated,onActivated:activated},runtime:{onStartup:startup,sendMessage:vi.fn(async request=>({ok:true,value:{matches:new RegExp(request.pattern).test(request.url)}}))}});
 registerAutomaticTabs(activate,stop);
});
afterEach(()=>vi.unstubAllGlobals());
describe('automatic webpage allowlist lifecycle',()=>{
 it('starts only foreground tabs at explicitly enabled hostnames',async()=>{
  await vi.waitFor(()=>expect(stop).toHaveBeenCalledTimes(4));change({autoTranslateTabs:true});
  await vi.waitFor(()=>expect(activate).toHaveBeenCalledExactlyOnceWith(1,true));
  expect(host.ensure).not.toHaveBeenCalled();
 });
 it('never interprets a legacy enabled preference as permission for every website',async()=>{
  change({autoTranslateTabs:true,autoTranslateSites:[]});expect(await automaticTabsAllowed(tabs[0].url)).toBe(false);expect(activate).not.toHaveBeenCalled();
 });
 it('checks URLs on activation and SPA navigation and stops sessions outside their directory',async()=>{
  change({autoTranslateTabs:true,autoTranslateSites:[{...site,scope:'directory',value:'/chapter'}]});await vi.waitFor(()=>expect(activate).toHaveBeenCalledWith(1,true));activate.mockClear();stop.mockClear();
  tabs[0]={...tabs[0],url:'https://comic.example/account'};updated.emit(1,{url:tabs[0].url},tabs[0]);await vi.waitFor(()=>expect(stop).toHaveBeenCalledWith(1));expect(activate).not.toHaveBeenCalled();
  tabs[1]={...tabs[1],active:true,url:'https://comic.example/chapter/2'};activated.emit({tabId:2});await vi.waitFor(()=>expect(activate).toHaveBeenCalledExactlyOnceWith(2,true));
 });
 it('reconciles scope edits and preserves the cache when unrelated preferences change',async()=>{
  change({autoTranslateTabs:true});await vi.waitFor(()=>expect(activate).toHaveBeenCalledWith(1,true));activate.mockClear();
  const reads=vi.mocked(chrome.storage.local.get).mock.calls.length;change({language:'en'});
  await Promise.all(Array.from({length:200},()=>automaticTabsAllowed(tabs[0].url)));
  expect(chrome.storage.local.get).toHaveBeenCalledTimes(reads);expect(activate).not.toHaveBeenCalled();
  change({autoTranslateSites:[{...site,scope:'directory',value:'/manga'}]});await vi.waitFor(()=>expect(stop).toHaveBeenCalledWith(1));expect(await automaticTabsAllowed(tabs[0].url)).toBe(false);
 });
 it('uses full tab URLs for regex and caches repeated checks',async()=>{
  change({autoTranslateTabs:true,autoTranslateSites:[{...site,scope:'regex',value:'/chapter'}]});await vi.waitFor(()=>expect(activate).toHaveBeenCalledWith(1,true));
  await Promise.all(Array.from({length:30},()=>automaticTabsAllowed(tabs[0].url)));
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({action:'match-tab-url',url:tabs[0].url}));
  expect((vi.mocked(chrome.runtime.sendMessage).mock.calls as unknown as [{url:string}][]).filter(([request])=>request.url===tabs[0].url)).toHaveLength(1);
 });
 it('does not allow a stale regex result after its rule is disabled',async()=>{
  const finishes:((value:unknown)=>void)[]=[];vi.mocked(chrome.runtime.sendMessage).mockImplementation(()=>new Promise(resolve=>{finishes.push(resolve);}));
  change({autoTranslateTabs:true,autoTranslateSites:[{...site,scope:'regex',value:'.*'}]});
  const pending=automaticTabsAllowed(tabs[0].url);await vi.waitFor(()=>expect(finishes.length).toBeGreaterThan(0));
  change({autoTranslateTabs:false});finishes.forEach(finish=>finish({ok:true,value:{matches:true}}));expect(await pending).toBe(false);expect(activate).not.toHaveBeenCalled();
 });
 it('turns the global switch off after permission revocation but keeps the allowlist',async()=>{
  change({autoTranslateTabs:true});await vi.waitFor(()=>expect(activate).toHaveBeenCalledWith(1,true));granted=false;removed.emit({origins:['https://*/*']});
  await vi.waitFor(()=>expect(value.autoTranslateTabs).toBe(false));expect(value.autoTranslateSites).toEqual([site]);expect(await automaticTabsAllowed(tabs[0].url)).toBe(false);
 });
});
