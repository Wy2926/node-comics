import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {controlledAnalyticsSender,extensionAnalyticsSender} from '../src/analytics/background';
import {analyticsPermission,requestAnalyticsPermission,removeAnalyticsPermission} from '../src/analytics/permissions';
beforeEach(()=>{
  vi.stubGlobal('navigator',{userAgent:'Chrome/140'});
  vi.stubGlobal('chrome',{
    runtime:{id:'self',getURL:(path:string)=>'chrome-extension://self/'+path},
    storage:{session:{get:vi.fn(async()=>({'nc-inline:7':{documentId:'active-document',navigationId:'active-navigation',url:'https://source.test/book'}}))}},
    tabs:{get:vi.fn(async()=>({id:7,url:'https://source.test/book'}))},
    permissions:{contains:vi.fn(async()=>true),request:vi.fn(async()=>true),remove:vi.fn(async()=>true)},
  });
});
afterEach(()=>vi.unstubAllGlobals());
it('accepts only this extension and rejects external, iframe and inactive content senders',async()=>{
  expect(extensionAnalyticsSender({id:'self',url:'chrome-extension://self/reader.html'})).toBe(true);
  expect(extensionAnalyticsSender({id:'other',url:'chrome-extension://self/reader.html'})).toBe(false);
  expect(extensionAnalyticsSender({id:'self',url:'https://source.test/book'})).toBe(false);
  const sender={id:'self',url:'https://source.test/book',frameId:0,documentId:'active-document',tab:{id:7}} as chrome.runtime.MessageSender;
  expect(await controlledAnalyticsSender(sender,'active-navigation')).toBe(true);
  expect(await controlledAnalyticsSender(sender,'stale-navigation')).toBe(false);
  expect(await controlledAnalyticsSender({...sender,documentId:'stale-document'},'active-navigation')).toBe(false);
  expect(await controlledAnalyticsSender({...sender,frameId:3},'active-navigation')).toBe(false);
  expect(await controlledAnalyticsSender({...sender,url:'https://another.test/book'},'active-navigation')).toBe(false);
  expect(await controlledAnalyticsSender({...sender,tab:{...sender.tab,incognito:true} as chrome.tabs.Tab},'active-navigation')).toBe(false);
});
it('uses the activated navigation and current tab URL on Firefox without documentId',async()=>{
  vi.stubGlobal('navigator',{userAgent:'Firefox/140'});
  Object.assign(chrome.storage.session,{get:vi.fn(async()=>({'nc-inline:7':{navigationId:'active-navigation',url:'https://source.test/book'}}))});
  const sender={id:'self',url:'https://source.test/book',frameId:0,tab:{id:7}} as chrome.runtime.MessageSender;
  expect(await controlledAnalyticsSender(sender,'active-navigation')).toBe(true);
  expect(await controlledAnalyticsSender(sender)).toBe(false);
  expect(await controlledAnalyticsSender(sender,'stale-navigation')).toBe(false);
  Object.assign(chrome.tabs,{get:vi.fn(async()=>({id:7,url:'https://source.test/next-book'}))});
  expect(await controlledAnalyticsSender(sender,'active-navigation')).toBe(false);
});
it('checks and requests Firefox optional data collection permission without host permission prompts',async()=>{
  expect(await analyticsPermission()).toBe(true);expect(chrome.permissions.contains).not.toHaveBeenCalled();
  vi.stubGlobal('navigator',{userAgent:'Firefox/140'});
  expect(await requestAnalyticsPermission()).toBe(true);expect(await analyticsPermission()).toBe(true);await removeAnalyticsPermission();
  const permission={data_collection:['technicalAndInteraction']};
  expect(chrome.permissions.request).toHaveBeenCalledWith(permission);expect(chrome.permissions.contains).toHaveBeenCalledWith(permission);expect(chrome.permissions.remove).toHaveBeenCalledWith(permission);
  vi.mocked(chrome.permissions.contains).mockRejectedValue(Error('unsupported'));expect(await analyticsPermission()).toBe(false);
});
