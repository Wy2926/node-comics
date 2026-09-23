import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BlobReader,BlobWriter,ZipWriter} from '@zip.js/zip.js/index-native.js';
import {catalog} from '../src/comics/repositories';
import {importLocalFile} from '../src/comics/application/import-service';
import {DocumentExport} from '../src/ui/DocumentExport';
import {defaults} from '../src/types';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
registerSourceDriver(localSourceDriver);
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5176')throw Error('导出验收仅允许独立的 127.0.0.1:5176 来源。');
const works=await catalog.listWorks({limit:100});
if(works.some(work=>!work.title.startsWith('导出验收')))throw Error('此隔离来源已有其他资料，停止写入夹具。');
let exportedDocument=(await catalog.list('documents',{limit:1}))[0];
if(!exportedDocument){
  const writer=new ZipWriter(new BlobWriter(),{useWebWorkers:false,level:0});
  for(const [index,color] of ['#ff486d','#40b58b','#427cdd'].entries()){
    const canvas=new OffscreenCanvas(360,540),ctx=canvas.getContext('2d')!;ctx.fillStyle=color;ctx.fillRect(0,0,360,540);ctx.fillStyle='white';ctx.fillRect(24,24,312,140);ctx.fillStyle='#253047';ctx.font='bold 36px sans-serif';ctx.fillText(`PAGE ${index+1}`,42,105);
    await writer.add(`${index+1}.png`,new BlobReader(await canvas.convertToBlob({type:'image/png'})));
  }
  const result=await importLocalFile(new File([await writer.close()],'导出验收样本.cbz'),{title:'导出验收 · 星光书店',kind:'book'});
  exportedDocument=(await catalog.get('documents',result.id))!;
}
function Fixture(){const [open,setOpen]=useState(true);return <div className="nc-app"><main className="nc-main"><h1>导出验收 · 保存完整源文件，按需读取页面</h1><button className="button primary" onClick={()=>setOpen(true)}>打开导出</button>{open&&<DocumentExport document={exportedDocument} settings={defaults} onClose={()=>setOpen(false)}/>}</main></div>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
