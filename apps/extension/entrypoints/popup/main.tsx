import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Icon} from '../../src/icons';
import type {PageManifest} from '../../src/sources/adapters';
import type {SourceCatalog} from '../../src/library/types';
import {initialChoices,refreshChoices,type ImageChoice} from '../../src/sources/selection';
import {sourceMessage} from '../../src/sources/client';
import {SourceImagePicker} from '../../src/ui/SourceImagePicker';
import {useAppearance} from '../../src/ui/Appearance';
import {settings} from '../../src/library/store';
import '../../src/styles.css';
import '../../src/redesign.css';
import './popup.css';
type Discovery={kind:'catalog';id:string;catalog:SourceCatalog}|{kind:'pages';id:string;manifest:PageManifest};
type Draft={discovery:Discovery;choices:ImageChoice[];url:string};
function Popup(){
 const [discovery,setDiscovery]=useState<Discovery>(),[choices,setChoices]=useState<ImageChoice[]>([]);
 const [source,setSource]=useState<chrome.tabs.Tab>(),[error,setError]=useState(''),[busy,setBusy]=useState(true),[opening,setOpening]=useState(false);
 const previous=useRef<Discovery>(undefined),selection=useRef<ImageChoice[]>([]),lock=useRef(false),openLock=useRef(false);
 const [appearance]=useState(settings);useAppearance(appearance);
 const count=choices.filter(item=>item.selected).length;
 function accept(next:Discovery){
  const last=previous.current;
  const same=last?.kind==='pages'&&next.kind==='pages'&&last.manifest.url===next.manifest.url&&last.manifest.navigationId===next.manifest.navigationId;
  const items=next.kind==='pages'?(same?refreshChoices(selection.current,next.manifest):initialChoices(next.manifest)):[];
  previous.current=next;selection.current=items;setDiscovery(next);setChoices(items);
 }
 async function discover(tab:chrome.tabs.Tab){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{accept(await sourceMessage<Discovery>({type:'NC_DISCOVER_TAB',tabId:tab.id}));}
  catch(e){setError((e as Error).message);}
  finally{lock.current=false;setBusy(false);}
 }
 useEffect(()=>{
  void (async()=>{
   try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(tab?.id==null||!tab.url||!['https:','http:'].includes(new URL(tab.url).protocol))throw Error('请在普通漫画网页上打开插件。');
    setSource(tab);
    const key='nc-popup:'+tab.id,data=await chrome.storage.session.get(key),draft=data[key] as Draft|undefined;
    if(draft?.url===tab.url){previous.current=draft.discovery;selection.current=draft.choices;setDiscovery(draft.discovery);setChoices(draft.choices);}
    // Clicking the toolbar grants activeTab. Automatic discovery never prompts for persistent access.
    await discover(tab);
   }catch(e){setError((e as Error).message);setBusy(false);}
  })();
 },[]);
 useEffect(()=>{if(discovery&&source?.id!=null&&source.url)void chrome.storage.session.set({['nc-popup:'+source.id]:{discovery,choices,url:source.url} satisfies Draft});},[discovery,choices,source]);
 async function grant(){
  if(!source?.url||lock.current)return;
  try{if(!await chrome.permissions.request({origins:[new URL(source.url).origin+'/*']}))throw Error('未取得本站权限，可再次授权后发现。');await discover(source);}
  catch(e){setError((e as Error).message);}
 }
 async function open(useDiscovery=true){
  if(useDiscovery&&lock.current||openLock.current)return;openLock.current=true;setOpening(true);setError('');
  try{
   let query='';
   if(useDiscovery&&discovery){
    if(discovery.kind==='catalog')query='?catalog='+discovery.id;
    else{const result=await sourceMessage<{id:string}>({type:'NC_SELECT_MANIFEST',manifestId:discovery.id,itemIds:choices.filter(item=>item.selected).map(item=>item.id)});query='?manifest='+result.id;}
   }
   await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html'+query)});window.close();
  }catch(e){setError((e as Error).message);}finally{openLock.current=false;setOpening(false);}
 }
 return <main className="nc-app nc-popup">
  <header className="nc-popup-header"><a className="nc-brand" href="#" onClick={e=>{e.preventDefault();void open(false);}}><span><Icon name="book"/></span><b>漫游 <small>Node Comics</small></b></a><button className="icon-button" aria-label="设置" disabled={opening} onClick={()=>void chrome.runtime.openOptionsPage()}><Icon name="settings" size={18}/></button></header>
  <section className="nc-popup-source"><span className="nc-popup-source-icon"><Icon name="globe"/></span><div><h1>{discovery?.kind==='catalog'?discovery.catalog.title:'发现网页图片'}</h1><p title={source?.title}>{source?.url?new URL(source.url).hostname:'在网页中寻找下一段故事'}</p></div><button className="button secondary small" disabled={!source||busy||opening} onClick={()=>source&&void discover(source)}><Icon name="refresh" size={15}/>刷新</button></section>
  <div className="nc-popup-body">
   {busy&&<div className="nc-popup-loading" role="status"><Icon name="refresh" size={17}/><span>{discovery?'正在刷新，保留已有选择与顺序…':'正在自动发现当前页面…'}</span></div>}
   {error&&<div className="nc-popup-error" role="alert"><p>{error}</p>{source&&<button disabled={busy||opening} onClick={()=>void grant()}>授权本站并重试</button>}</div>}
   {discovery?.kind==='pages'&&<><SourceImagePicker choices={choices} generic={discovery.manifest.adapter==='generic'} disabled={busy||opening} onChange={items=>{selection.current=items;setChoices(items);}}/><p className="nc-popup-note">{discovery.manifest.note}</p></>}
   {discovery?.kind==='catalog'&&<div className="nc-popup-catalog"><span className="nc-popup-catalog-icon"><Icon name="layers" size={28}/></span><h2>发现作品目录</h2><p><strong>{discovery.catalog.entries.length}</strong> 个来源条目 · {discovery.catalog.groups.length} 个分组</p><p>可选择整部或指定范围，归入已有作品。</p><small>{discovery.catalog.note}</small></div>}
   {!discovery&&!busy&&!error&&<div className="nc-image-empty">滚动网页加载图片后，点击刷新。</div>}
  </div>
  <footer className="nc-popup-footer"><button className="button primary full" disabled={busy||opening||!discovery||discovery.kind==='pages'&&!count} onClick={()=>void open()}>{opening?'正在打开…':discovery?.kind==='catalog'?'选择目录导入范围':`加入漫画${count?' · '+count+' 张':''}`}<Icon name="arrow" size={18}/></button><p>选择作品归属，或插入已有阅读副本</p><button className="nc-popup-library" disabled={opening} onClick={()=>void open(false)}><Icon name="folder" size={16}/>打开漫画管理器 / 导入本地漫画</button></footer>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Popup/>);
