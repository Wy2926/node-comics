// The isolated worker shares one verified font for measurement and rendering.
let weight=400;
let selectedFamily='';
let coverage:number[][]=[];
export function configureTypesetFont(family:string,fontWeight:number,ranges:number[][]){selectedFamily=family;weight=fontWeight;coverage=ranges;}
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
export function formatTypesetFont(size:number,family:string){return weight+' '+size+'px '+family;}
