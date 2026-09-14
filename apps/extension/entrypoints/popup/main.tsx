import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Icon} from '../../src/icons';
import type {PageManifest} from '../../src/sources/adapters';
import type {SourceCatalog} from '../../src/library/types';
import '../../src/styles.css';
type Discovery={kind:'catalog';id:string;catalog:SourceCatalog}|{kind:'pages';id:string;manifest:PageManifest};
function Popup(){
 const [discovery,setDiscovery]=useState<Discovery>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function discover(){setBusy(true);setError('');try{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!tab.url)throw Error('请先打开漫画网页。');const url=new URL(tab.url);if(!['http:','https:'].includes(url.protocol))throw Error('请切换到普通漫画网页。');if(!await chrome.permissions.request({origins:[url.origin+'/*']}))throw Error('未取得本站访问权限。');const result=await chrome.runtime.sendMessage({type:'NC_DISCOVER_TAB',tabId:tab.id});if(!result.ok)throw Error(result.error);setDiscovery(result.data);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function open(useDiscovery=true){const query=useDiscovery&&discovery?'?'+(discovery.kind==='catalog'?'catalog':'manifest')+'='+discovery.id:'';await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html'+query)});window.close();}
 return <div className="popup-shell"><div className="brand"><span className="brand-mark"><Icon name="book"/></span><b>Node Comics<span>漫游</span></b></div><div className="popup-hero"><span className="eyebrow">YOUR NEXT CHAPTER</span><h1>下一页，<br/>没有语言的距离。</h1></div><div className="popup-status"><Icon name="book"/><div><b>{discovery?.kind==='catalog'?discovery.catalog.title:discovery?.kind==='pages'?'发现 '+discovery.manifest.items.length+' 张图片':'导入当前网页的漫画'}</b><p>{discovery?.kind==='catalog'?'发现 '+discovery.catalog.entries.length+' 个来源条目，可选择整部或指定范围':discovery?.kind==='pages'?discovery.manifest.note:'详情页导入作品目录，阅读页导入当前图片'}</p></div></div>{error&&<p className="error-message" role="alert">{error}</p>}<button className="button primary full" disabled={busy} onClick={()=>discovery?void open():void discover()}>{busy?'正在发现…':discovery?.kind==='catalog'?'选择导入范围':discovery?'进入阅读器':'识别当前页面'}<Icon name="arrow"/></button><button className="button plain full" onClick={()=>void open(false)}>打开书架／导入本地漫画</button><footer className="popup-footer"><span>仅访问主动授权的网站</span><button onClick={()=>chrome.runtime.openOptionsPage()}>设置</button></footer></div>;
}
createRoot(document.getElementById('root')!).render(<Popup/>);
