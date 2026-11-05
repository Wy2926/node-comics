import {useEffect,useState} from 'react';

export const pdfDisplayWidth=(cssWidth:number)=>Math.max(128,Math.ceil(cssWidth*(window.devicePixelRatio||1)/128)*128);

/** Keep sufficient pixels while zooming; only settled increases request another raster. */
export function usePdfDisplayWidth(scope:string,cssWidth?:number){
  const requested=()=>cssWidth===undefined?undefined:pdfDisplayWidth(cssWidth);
  const [raster,setRaster]=useState(()=>({scope,width:requested()}));
  useEffect(()=>{
    if(cssWidth===undefined)return;
    let timer:ReturnType<typeof setTimeout>,media:MediaQueryList;
    const update=()=>{
      clearTimeout(timer);
      timer=setTimeout(()=>{
        const width=requested()!;
        setRaster(previous=>previous.scope===scope&&(previous.width??0)>=width?previous:{scope,width});
      },200);
    };
    const watch=()=>{
      media?.removeEventListener('change',watch);
      media=window.matchMedia(`(resolution: ${window.devicePixelRatio||1}dppx)`);
      media.addEventListener('change',watch);
      update();
    };
    watch();window.addEventListener('resize',update);
    return()=>{clearTimeout(timer);media.removeEventListener('change',watch);window.removeEventListener('resize',update);};
  },[scope,cssWidth]);
  return cssWidth===undefined?undefined:raster.scope===scope?raster.width??requested():requested();
}
