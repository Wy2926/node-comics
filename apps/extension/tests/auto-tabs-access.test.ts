import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaults,type Settings} from '../src/types';
const preferences=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(async(_value:unknown)=>{})}));
vi.mock('react',()=>({useRef:()=>({current:false}),useState:(value:unknown)=>[value,()=>{}]}));
vi.mock('../src/comics/application/preferences',()=>({settings:preferences.read,saveSettings:preferences.save}));
import {useAutoTranslateSettings} from '../src/ui/useAutoTranslateSettings';
const site={hostname:'comic.example',enabled:true,scope:'domain' as const,value:''};
let value:Settings;
const contains=vi.fn(async()=>true);
beforeEach(()=>{
 contains.mockReset();contains.mockResolvedValue(true);
 value={...defaults,autoTranslateSites:[]};preferences.read.mockImplementation(()=>value);preferences.save.mockReset();preferences.save.mockResolvedValue(undefined);
 vi.stubGlobal('chrome',{runtime:{id:'test-extension'},storage:{local:{get:async()=>({'nc-reader-settings':value})}},permissions:{contains,request:vi.fn(async()=>true)}});
});
afterEach(()=>vi.unstubAllGlobals());
describe('automatic site settings persistence',()=>{
 it('enables a site with installed access without requesting new browser permissions',async()=>{
  const saved=vi.fn(),hook=useAutoTranslateSettings(saved);
  expect(await hook.update(previous=>({...previous,autoTranslateTabs:true,autoTranslateSites:[site]}))).toBe(true);
  expect(chrome.permissions.contains).toHaveBeenCalledWith({origins:['https://*/*','http://*/*']});expect(chrome.permissions.request).not.toHaveBeenCalled();
  expect(preferences.save).toHaveBeenCalledWith({...value,autoTranslateTabs:true,autoTranslateSites:[site]});expect(saved).toHaveBeenCalledOnce();
 });
 it('does not persist a new enabled site when access is restricted',async()=>{
  contains.mockResolvedValue(false);const saved=vi.fn();
  expect(await useAutoTranslateSettings(saved).update(previous=>({...previous,autoTranslateTabs:true,autoTranslateSites:[site]}))).toBe(false);
  expect(preferences.save).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled();
 });
 it('allows removing a site even after permission loss and keeps other sites',async()=>{
  value={...value,autoTranslateTabs:true,autoTranslateSites:[site,{...site,hostname:'other.example'}]};
  contains.mockResolvedValue(false);
  expect(await useAutoTranslateSettings(vi.fn()).update(previous=>({...previous,autoTranslateSites:previous.autoTranslateSites.filter(site=>site.hostname!=='comic.example')}))).toBe(true);
  expect(chrome.permissions.contains).not.toHaveBeenCalled();
  expect(preferences.save).toHaveBeenCalledWith({...value,autoTranslateSites:[{...site,hostname:'other.example'}]});
 });
 it('restores the old settings after a write failure and rejects overlapping clicks',async()=>{
  preferences.save.mockRejectedValueOnce(Error('Write failed'));
  const saved=vi.fn(),hook=useAutoTranslateSettings(saved),change=(previous:Settings)=>({...previous,autoTranslateTabs:true,autoTranslateSites:[site]});
  const first=hook.update(change);expect(await hook.update(change)).toBe(false);expect(await first).toBe(false);
  expect(preferences.save).toHaveBeenLastCalledWith(value);expect(saved).not.toHaveBeenCalled();
 });
});
