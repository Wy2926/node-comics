import type {PlatformProvider} from '../../runtime/platform';
// One selected, verified font per isolated pipeline Worker, shared by measurement and rendering.
export let TYPESET_FONT_WEIGHT=400;
let selectedFamily='';
let coverage:number[][]=[];
export function configureTypesetFont(family:string,weight:number,ranges:number[][]){selectedFamily=family;TYPESET_FONT_WEIGHT=weight;coverage=ranges;}
export function supportedTypesetText(text:string):string {
  let supported='';
  for(const character of text){
    if(/\s/u.test(character)){supported+=character;continue;}
    const point=character.codePointAt(0)!;
    let low=0,high=coverage.length-1;
    while(low<=high){
      const mid=(low+high)>>>1,[start,end]=coverage[mid];
      if(point<start)high=mid-1;else if(point>end)low=mid+1;else{supported+=character;break;}
    }
  }
  return supported;
}
export function resolveTypesetFontFamily(_targetLang?:string):string {
  if(!selectedFamily)throw Error('Font not configured');
  return JSON.stringify(selectedFamily);
}
export function registerTypesetFonts(platform:PlatformProvider,resolve:(path:string)=>string,_targetLang?:string){
  platform.registerFont(resolve('selected-font'),selectedFamily,{style:'normal',weight:String(TYPESET_FONT_WEIGHT)});
}
export function formatTypesetFont(size:number,family:string){return TYPESET_FONT_WEIGHT+' '+size+'px '+family;}
