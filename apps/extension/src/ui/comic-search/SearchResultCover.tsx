import {useEffect,useRef,useState} from 'react';
import {RequestPool} from '../../concurrency';
import {Icon} from '../../icons';
import {msg} from '../../i18n/runtime';
import {readSearchCover,type SourceSearchResult} from '../../sources';

const covers=new RequestPool(3);
export const searchResultCoverKey=(hit:SourceSearchResult)=>JSON.stringify([hit.sourceId,hit.siteId,hit.catalogId,hit.catalogUrl,hit.key,hit.cover?.url]);
export function SearchResultCover({hit,cache}:{hit:SourceSearchResult;cache:Map<string,string>}){
  const ref=useRef<HTMLDivElement>(null),[url,setUrl]=useState<string>(),[visible,setVisible]=useState(false);
  const key=searchResultCoverKey(hit);
  useEffect(()=>{
    const element=ref.current;if(!element||!hit.cover)return;
    if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{root:element.closest('.nc-search-body'),rootMargin:'80px'});
    observer.observe(element);return()=>observer.disconnect();
  },[key]);
  useEffect(()=>{
    if(!visible||!hit.cover){setUrl(cache.get(key));return;}
    const cached=cache.get(key);if(cached){setUrl(cached);return;}
    setUrl(undefined);
    const controller=new AbortController();let transient:string|undefined;
    void covers.run(async()=>{
      controller.signal.throwIfAborted();
      const blob=await readSearchCover(hit,controller.signal);controller.signal.throwIfAborted();
      const bitmap=await createImageBitmap(blob,{resizeWidth:144,resizeQuality:'medium'});
      let thumbnail:Blob;
      try{
        const height=Math.min(216,bitmap.height),canvas=new OffscreenCanvas(144,height),drawing=canvas.getContext('2d');
        if(!drawing)throw new Error('Canvas unavailable');
        drawing.drawImage(bitmap,0,0,144,bitmap.height);thumbnail=await canvas.convertToBlob({type:'image/webp',quality:.8});
      }finally{bitmap.close();}
      controller.signal.throwIfAborted();
      const local=URL.createObjectURL(thumbnail);
      if(cache.size<100)cache.set(key,local);else transient=local;
      setUrl(local);
    }).catch(()=>{});
    return()=>{controller.abort();if(transient)URL.revokeObjectURL(transient);};
  // Metadata enrichment keeps the same runtime image authority and must not restart a download.
  },[visible,key,cache]);
  return <div ref={ref} className="nc-search-result-cover">{url?<img src={url} alt={msg('{0}封面',{'0':hit.title})}/>:<Icon name="image" size={25}/>}</div>;
}
