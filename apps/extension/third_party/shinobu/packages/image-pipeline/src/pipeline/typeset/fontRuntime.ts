import type {PlatformProvider} from '../../runtime/platform';
// One selected, verified font per isolated pipeline Worker, shared by measurement and rendering.
export let TYPESET_FONT_WEIGHT=400;
let selectedFamily='';
export function configureTypesetFont(family:string,weight:number){selectedFamily=family;TYPESET_FONT_WEIGHT=weight;}
export function resolveTypesetFontFamily(_targetLang?:string):string {
  if(!selectedFamily)throw Error('Font not configured');
  return JSON.stringify(selectedFamily);
}
export function registerTypesetFonts(platform:PlatformProvider,resolve:(path:string)=>string,_targetLang?:string){
  platform.registerFont(resolve('selected-font'),selectedFamily,{style:'normal',weight:String(TYPESET_FONT_WEIGHT)});
}
export function formatTypesetFont(size:number,family:string){return TYPESET_FONT_WEIGHT+' '+size+'px '+family;}
