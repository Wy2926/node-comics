import {useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import {translationFontName,translationFontPreview} from '../../../../backend/shared/translation-fonts';
import {msg} from '../i18n/runtime';
import type {FontSelection} from '../translation/channels/contracts';
import {availableTranslationFonts,effectiveTranslationFont} from '../translation/fonts';
import {Select,SelectOption} from './Select';
import {FontDownloadMenu} from './FontDownloadMenu';
import './translation-fonts.css';
import {SettingRow} from './components';

// Fetch only the selected face or the open language list; the shipped catalog bounds this cache.
const loadedFaces=new Map<string,{promise:Promise<FontFace>;loaded:boolean}>();
function loadPreview(family:string,url:string){
  let entry=loadedFaces.get(url);
  if(!entry){
    const source=typeof chrome!=='undefined'&&chrome.runtime?.id?chrome.runtime.getURL(url.replace(/^\//,'')):new URL(url,location.href).href;
    const promise=new FontFace(family,`url(${JSON.stringify(source)})`).load().then(face=>{
      document.fonts.add(face);entry!.loaded=true;return face;
    }).catch(error=>{loadedFaces.delete(url);throw error;});
    entry={promise,loaded:false};loadedFaces.set(url,entry);
  }
  return entry.promise;
}

export function TranslationFontPicker({selection,language}:{selection?:FontSelection;language:string}){
  const id=useId(),value=effectiveTranslationFont(selection?.fonts,language,selection?.value(language)),choices=availableTranslationFonts(selection?.fonts,language);
  const restoreFocus=useRef<{language:string;value:string|undefined}|undefined>(undefined);
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[expanded,setExpanded]=useState(false);
  const [states,setStates]=useState<Record<string,'loading'|'loaded'|'failed'>>({});
  useLayoutEffect(()=>{
    if(!selection){setExpanded(false);return;}
    const pending=restoreFocus.current;
    if(pending&&effectiveTranslationFont(selection.fonts,pending.language,selection.value(pending.language))===pending.value){
      restoreFocus.current=undefined;
      // Saving reconnects the channel and briefly removes its controls. Do not steal focus after Tab/click.
      if(document.activeElement===document.body)document.getElementById(id)?.focus({preventScroll:true});
    }
  },[selection,id]);
  const requested=[...new Set([...(value?[value]:[]),...(expanded?choices.map(font=>font.id):[])])]
    .flatMap(fontId=>{const preview=translationFontPreview(fontId,language);return preview?[preview]:[];});
  const requestKey=requested.map(preview=>preview.url).join('|');
  useEffect(()=>{
    let current=true;
    for(const preview of requested){
      if(loadedFaces.get(preview.url)?.loaded||states[preview.url]==='failed'&&!expanded)continue;
      setStates(previous=>({...previous,[preview.url]:'loading'}));
      void loadPreview(preview.family,preview.url).then(
        ()=>{if(current)setStates(previous=>({...previous,[preview.url]:'loaded'}));},
        ()=>{if(current)setStates(previous=>({...previous,[preview.url]:'failed'}));}
      );
    }
    return()=>{current=false;};
  },[requestKey,expanded]);
  const failed=requested.some(preview=>states[preview.url]==='failed'&&!loadedFaces.get(preview.url)?.loaded);
  function fontStyle(fontId:string):CSSProperties{
    const preview=translationFontPreview(fontId,language);
    return {fontFamily:preview&&loadedFaces.get(preview.url)?.loaded?preview.family:undefined,fontWeight:400,fontSynthesis:'none'};
  }
  async function choose(next:string){
    if(!selection||saving||!choices.some(font=>font.id===next))return;
    restoreFocus.current=document.activeElement===document.getElementById(id)||document.getElementById(id+'-menu')?.contains(document.activeElement)?{language,value:next}:undefined;
    setSaving(true);setError('');
    try{await selection.select(language,next);return true;}catch(error){restoreFocus.current=undefined;setError((error as Error).message);return false;}finally{setSaving(false);}
  }
  if(!selection||!choices.length)return null;
  return <div className="nc-font-picker">
    <SettingRow title={<label htmlFor={id}>{selection.downloads?msg('本地翻译字体'):msg('翻译字体')}</label>}
      description={selection.description??msg('字体按目标语言提供；更换仅影响新任务，已有译图需手动重新翻译。')} descriptionId={id+'-note'}>
      {/* Keep keyboard focus while saving; native disabled would blur the trigger. */}
      {selection.downloads?<FontDownloadMenu id={id} downloads={selection.downloads} choices={choices} value={value} language={language} saving={saving} fontStyle={fontStyle} onChoose={choose} onOpenChange={setExpanded}/>:
      <Select id={id} placement="end" aria-label={msg('翻译字体')} aria-describedby={id+'-note'} value={value??''} aria-disabled={saving||undefined} aria-busy={saving||undefined}
        onClick={event=>{if(saving)event.preventDefault();}} onKeyDown={event=>{if(saving&&!['Tab','Escape'].includes(event.key)){event.preventDefault();event.stopPropagation();}}}
        onOpenChange={setExpanded} onChange={event=>void choose(event.target.value)}>
        {choices.map(font=><SelectOption key={font.id} value={font.id} style={fontStyle(font.id)} lang={language} dir={language==='ar'?'rtl':'ltr'}>{translationFontName(font,language)}</SelectOption>)}
      </Select>}
    </SettingRow>
    {failed&&<p role="status">{msg('字体预览加载失败，重新展开列表可重试，不影响翻译设置。')}</p>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
