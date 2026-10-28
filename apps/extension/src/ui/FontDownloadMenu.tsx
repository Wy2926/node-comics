import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {translationFontName} from '../../../../backend/shared/translation-fonts';
import type {FontDownload,FontDownloads} from '../translation/channels/contracts';
import type {availableTranslationFonts} from '../translation/fonts';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {PickerMenu} from './PickerMenu';

const status=(font?:FontDownload)=>font?({missing:msg('未下载'),ready:msg('已下载'),downloading:msg('下载中'),verifying:msg('正在校验'),paused:msg('已暂停'),error:msg('下载失败')})[font.state]:msg('正在读取资源…');
const size=(bytes:number)=>(bytes/1024/1024).toFixed(1)+' MB';
export function FontDownloadMenu({id,downloads,choices,value,language,saving,fontStyle,onChoose,onOpenChange}:{
  id:string;downloads:FontDownloads;choices:ReturnType<typeof availableTranslationFonts>;value?:string;language:string;saving:boolean;
  fontStyle:(id:string)=>CSSProperties;onChoose:(id:string)=>Promise<boolean|undefined>;onOpenChange:(open:boolean)=>void;
}){
  const [open,setOpen]=useState(false),[resources,setResources]=useState<FontDownload[]>([]),[error,setError]=useState(''),[pending,setPending]=useState<string[]>([]);
  const refreshRef=useRef(()=>{}),requests=useRef(new Set<string>());
  function toggle(next:boolean){setOpen(next);onOpenChange(next);if(next)setError('');}
  useEffect(()=>{
    let live=true,reading=false,again=false,timer:ReturnType<typeof setTimeout>|undefined;
    async function refresh(){
      if(reading){again=true;return;}
      reading=true;
      try{
        const next=await downloads.read();
        if(live){setResources(next);setPending(ids=>ids.filter(id=>next.find(font=>font.id===id)?.state==='missing'));}
      }catch{if(live)setError(msg('资源状态读取失败，请重新打开。'));}
      finally{reading=false;if(live&&again){again=false;void refresh();}}
    }
    // Progress broadcasts are coalesced; closed menus never poll or load model metadata.
    const schedule=()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},200);};
    refreshRef.current=()=>void refresh();void refresh();
    const stop=downloads.subscribe(schedule),poll=open?setInterval(schedule,3000):undefined;
    return()=>{live=false;stop();clearTimeout(timer);clearInterval(poll);};
  },[downloads,open]);
  async function download(font:FontDownload){
    if(requests.current.has(font.id))return;
    requests.current.add(font.id);setPending(ids=>[...ids,font.id]);setError('');
    try{await downloads.download(font.id);refreshRef.current();}
    catch(error){setPending(ids=>ids.filter(id=>id!==font.id));setError((error as Error).message);}
    finally{requests.current.delete(font.id);}
  }
  const selected=choices.find(font=>font.id===value),selectedResource=resources.find(font=>font.id===value);
  return <PickerMenu id={id} label={msg('本地翻译字体')} descriptionId={id+'-note'} open={open} onOpenChange={toggle} busy={saving}
    trigger={<><span style={value?fontStyle(value):undefined} lang={language}>{selected?translationFontName(selected,language):''}</span><small data-ready={selectedResource?.state==='ready'||undefined}>{status(selectedResource)}</small></>}>
    <div className="nc-picker-items nc-font-downloads">
      {choices.map(font=>{
        const resource=resources.find(item=>item.id===font.id),ready=resource?.state==='ready',waiting=pending.includes(font.id),working=waiting||resource?.state==='downloading'||resource?.state==='verifying';
        const name=translationFontName(font,language);
        return <div key={font.id} className="nc-font-download-item">
          <div className="nc-picker-item" data-selected={value===font.id||undefined}>
            <button type="button" className="nc-select-option nc-picker-choice" aria-pressed={value===font.id} disabled={saving||!ready}
              onClick={()=>void onChoose(font.id).then(saved=>{if(saved){toggle(false);document.getElementById(id)?.focus({preventScroll:true});}})}>
              <span><strong style={fontStyle(font.id)} lang={language}>{name}</strong><small data-ready={ready||undefined}>{waiting&&resource?.state==='missing'?msg('等待下载'):status(resource)}{resource&&' · '+size(resource.bytes)}</small></span>
              {value===font.id&&<Icon name="check" size={16}/>}
            </button>
            {resource&&!ready&&<button type="button" className="nc-font-download-action" disabled={working} aria-label={msg('下载')+' · '+name} onClick={()=>void download(resource)}>
              <Icon name="download" size={16}/><span>{working?resource.state==='verifying'?msg('正在校验'):msg('下载中'):resource.state==='paused'?msg('继续下载'):resource.state==='error'?msg('重试下载'):msg('下载')}</span>
            </button>}
          </div>
          {resource&&working&&<progress max={resource.bytes} value={resource.downloaded} aria-label={name+' · '+msg('下载中')}/>}
          {resource?.state==='error'&&resource.detail&&<p className="nc-muted">{resource.detail}</p>}
        </div>;
      })}
      {error&&<p role="alert">{error}</p>}
    </div>
  </PickerMenu>;
}
