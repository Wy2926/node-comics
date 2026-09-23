import {afterEach, describe, expect, it, vi} from 'vitest';
import {readSourceCatalog, recoverCatalogTabs} from '../src/sources/runtime/catalog-reader';

const url='https://www.copy4000.com/comic/fixture';
const snapshot={id:'mangacopy:fixture',sourceId:'mangacopy',url,title:'Fixture',observedAt:1,complete:true,note:'',entries:[],groups:[]};
function browser() {
  const records:Record<string,unknown>={};
  const chrome={
    tabs:{create:vi.fn(async()=>({id:7})),get:vi.fn(async():Promise<{id:number;url:string;status:string;pendingUrl?:string}>=>({id:7,url,status:'complete'})),remove:vi.fn(async()=>{}),sendMessage:vi.fn(async()=>snapshot)},
    scripting:{executeScript:vi.fn(async()=>[])},
    storage:{session:{get:vi.fn(async()=>records),set:vi.fn(async(values:Record<string,unknown>)=>{Object.assign(records,values);}),remove:vi.fn(async(key:string)=>{delete records[key];})}},
  };
  vi.stubGlobal('chrome',chrome);vi.useFakeTimers();return {chrome,records};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('background catalog discovery lifecycle',()=>{
  it('waits for the adapted complete directory and closes only its own tab without import storage',async()=>{
    const {chrome,records}=browser();chrome.tabs.sendMessage.mockResolvedValueOnce({...snapshot,complete:false});
    const pending=readSourceCatalog(url);await vi.advanceTimersByTimeAsync(1000);expect(await pending).toEqual(snapshot);
    expect(chrome.tabs.create).toHaveBeenCalledWith({url,active:false});expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);expect(records).toEqual({});
  });
  it('rejects a pending cross-work navigation without closing the user navigation',async()=>{
    const {chrome,records}=browser();chrome.tabs.get.mockResolvedValue({id:7,url,status:'loading',pendingUrl:'https://www.copy4000.com/comic/different'});
    const pending=expect(readSourceCatalog(url)).rejects.toThrow('跳转');await vi.advanceTimersByTimeAsync(500);await pending;
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();expect(chrome.tabs.remove).not.toHaveBeenCalled();expect(records).toEqual({});
  });
  it('times out incomplete observations and releases the tab for later retry',async()=>{
    const {chrome,records}=browser();chrome.tabs.sendMessage.mockResolvedValue({...snapshot,complete:false});
    const pending=expect(readSourceCatalog(url)).rejects.toThrow('完整加载');await vi.advanceTimersByTimeAsync(20000);await pending;
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);expect(records).toEqual({});
  });
  it('cleans up an abandoned worker tab but leaves live leases and foreign navigations alone',async()=>{
    const {chrome,records}=browser();records['nc-catalog-tab:7']={url,expiresAt:Date.now()-1};records['nc-catalog-tab:8']={url,expiresAt:Date.now()+1000};
    await recoverCatalogTabs();expect(chrome.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);expect(records).toHaveProperty('nc-catalog-tab:8');
    records['nc-catalog-tab:9']={url,expiresAt:Date.now()-1};chrome.tabs.get.mockResolvedValue({id:9,url:'https://example.org/',status:'complete',pendingUrl:undefined});
    await recoverCatalogTabs();expect(chrome.tabs.remove).toHaveBeenCalledTimes(1);expect(records).not.toHaveProperty('nc-catalog-tab:9');
  });
});
