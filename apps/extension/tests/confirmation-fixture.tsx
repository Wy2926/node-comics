/** Isolated metadata, generated images and a synthetic provider; no external services. */
import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BlobReader,BlobWriter,ZipWriter} from '@zip.js/zip.js/index-native.js';
import {catalog} from '../src/comics/repositories';
import type {Comic,Entry,SourceConnection} from '../src/comics/domain';
import {importLocalFile} from '../src/comics/application/import-service';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
import {defaults} from '../src/types';
import {installDictionary} from '../src/i18n/runtime';
import type {UiLocale} from '../src/i18n/locales';
import {DocumentExport} from '../src/ui/DocumentExport';
import {Library} from '../src/ui/Library';
import type {ShelfView} from '../src/ui/ShelfGrid';
import {BookDownloads} from '../src/ui/downloads/BookDownloads';
import {FileDownloadPrompt} from '../src/ui/downloads/FileDownloads';
import type {BookDownloadsController} from '../src/ui/downloads/useBookDownloads';
import {RemoteLibrary} from '../src/ui/remote-library/RemoteLibrary';
import {RemoveConnectionDialog} from '../src/ui/remote-library/RemoveConnectionDialog';
import {Scrollbars} from '../src/ui/Scrollbars';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5181')throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const query=new URLSearchParams(location.search),locale=query.get('locale') as UiLocale|null;
if(locale)installDictionary(locale,await fetch(`/i18n/${locale}.json`).then(response=>response.json()));
document.documentElement.dataset.appearance=query.get('theme')??'light';
document.documentElement.style.setProperty('--text-scale',query.get('scale')??'1');
const account:SourceConnection={id:'dialog-source',provider:'dialog-fixture',displayName:'星海远程书库 · Synthetic Library',status:'connected',generation:1,createdAt:1,updatedAt:1};
let failRemoval=query.has('fail');
registerSourceDriver(localSourceDriver);
registerSourceDriver({id:account.provider,label:'Synthetic',cachePages:false,cacheRanges:false,
  connection:{list:async()=>[account],disconnect:async()=>{account.status='disconnected';},remove:async()=>{if(failRemoval){failRemoval=false;throw Error('模拟移除失败，请重试');}}},
  catalog:{browse:async()=>({title:account.displayName,location:'root',navigation:[],publications:[]}),resolve:async()=>{throw Error('Unexpected download');}},
});
await catalog.put('connections',account);
const comics:Comic[]=Array.from({length:8},(_,i)=>({id:`dialog-comic-${i}`,title:i===0?'星海漫游 · 第一卷':i===1?'<img src=x onerror=alert(1)> 长名称安全显示测试'.repeat(3):`星海漫游 · 第 ${i+1} 卷`,sourceKey:`dialog-${i}`,source:{connectionId:account.id,providerItemId:String(i),locator:{},generation:1,status:'active'},sourceName:'Synthetic',createdAt:1,updatedAt:1}));
for(const comic of comics)await catalog.put('comics',comic);
const canvas=new OffscreenCanvas(320,480),ctx=canvas.getContext('2d')!;ctx.fillStyle='#1769b3';ctx.fillRect(0,0,320,480);
const writer=new ZipWriter(new BlobWriter(),{useWebWorkers:false,level:0});
await writer.add('1.png',new BlobReader(await canvas.convertToBlob({type:'image/png'})));
const imported=await importLocalFile(new File([await writer.close()],'星海漫游 · 导出样本.cbz'));
const exportEntry=(await catalog.get('entries',imported.id))!;
const partialEntry:Entry={...exportEntry,id:'dialog-incomplete',contentId:'dialog-incomplete',format:'image-sequence',containerId:undefined,discoveryComplete:false,pageCount:1};
const epubEntry:Entry={...exportEntry,id:'dialog-epub',contentId:'dialog-epub',format:'epub',containerId:undefined};
await catalog.put('entries',partialEntry);await catalog.put('entries',epubEntry);

function Fixture(){
  const [kind,setKind]=useState(''),[items,setItems]=useState(comics),[notice,setNotice]=useState(''),[attempts,setAttempts]=useState(0);
  const shelfView=useRef<ShelfView>({scrollTop:0,search:'',sort:'recent',updatesOnly:false});
  const close=()=>setKind('');
  const controller:BookDownloadsController={books:[{comic:comics[0],plan:{id:'book-download:'+comics[0].id,comicId:comics[0].id,sourceGeneration:1,generation:1,status:'paused',languages:null,entryIds:[],createdAt:1,updatedAt:1},status:'paused',bytes:12*1024**2,total:10,completed:4,hasPendingTasks:true,newChapters:0,availableLanguages:['zh-Hans']}],
    files:[{intent:{id:'file-download:dialog',connectionId:account.id,connectionGeneration:1,publicationId:'file',representationId:'file',title:'星海漫游 · 完整文件.cbz',contentId:'file',generation:1,status:kind==='complete-file'?'complete':'paused',createdAt:1,updatedAt:1,bytes:5*1024**2,totalBytes:24*1024**2,sourceRemovalVersion:0}}],activeCount:0,
    languagePicker:undefined,focusedComicId:undefined,open:()=>{},close:()=>{},start:async()=>{},promptFileDownload:()=>{},refresh:()=>{},closeFilePrompt:close,
    filePrompt:kind==='download'?{connectionId:account.id,plan:{publication:{id:'new-file',title:'星海漫游 · 下载后阅读'},kind:'download-file',representationId:'file',format:'cbz',locator:{},snapshot:{},size:24*1024**2}}:undefined,
    confirmFile:async()=>{setAttempts(value=>value+1);await new Promise(resolve=>setTimeout(resolve,600));if(attempts===0)throw Error('模拟下载失败，请重试');close();},
  };
  return <div className="nc-app" style={{minHeight:2000,padding:24}}><Scrollbars/><h1>操作弹窗隔离夹具</h1><p>合成数据，不访问外部服务。</p>
    <nav style={{display:'flex',flexWrap:'wrap',gap:10,marginBlock:24}}>{['export','incomplete','epub','library','downloads','complete-file','download','remote','remove-source'].map(id=><button key={id} id={'open-'+id} className="button secondary" onClick={()=>setKind(id)}>{id}</button>)}</nav>
    <output id="attempts">{attempts}</output><output id="notice">{notice}</output>
    {['export','incomplete','epub'].includes(kind)&&<DocumentExport document={kind==='export'?exportEntry:kind==='incomplete'?partialEntry:epubEntry} settings={defaults} onClose={close}/>}
    {kind==='library'&&<Library active library={{comics:items}} shelfView={shelfView} sourceActions={[]} onOpen={()=>{}} onImport={()=>{}} onSource={()=>{}} notify={setNotice} onExport={()=>{}} onChanged={async()=>setItems((await catalog.list('comics',{limit:100})).filter(comic=>comic.id.startsWith('dialog-comic-')))}/>}
    {['downloads','complete-file'].includes(kind)&&<BookDownloads controller={controller} onRead={()=>{}} onManageStorage={()=>{}}/>}
    <FileDownloadPrompt controller={controller}/>
    {kind==='remote'&&<RemoteLibrary active onRead={()=>{}} onDownload={()=>{}}/>}
    {kind==='remove-source'&&<RemoveConnectionDialog account={account} onClose={close} onRemoved={close}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
