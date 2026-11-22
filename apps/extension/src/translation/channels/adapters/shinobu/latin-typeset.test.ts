import {expect,it} from 'vitest';
import type {PipelineCanvas} from '../../../../../third_party/shinobu/packages/image-pipeline/src/runtime/platform';
import type {TextRegion} from '../../../../../third_party/shinobu/packages/image-pipeline/src/types';
import {configureTypesetFont} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/fontRuntime';
import coverage from '../../../font-coverage.json';
import {drawLatinTypeset} from './latin-typeset';

const mask={x:30,y:18,width:180,height:140,data:Uint8Array.from({length:180*140},(_,i)=>
  Number(((i%180-90)/90)**2+((Math.floor(i/180)-70)/70)**2<=1))};
const vertical:TextRegion={id:'dialogue',sourceText:'縦\n書き',direction:'v',fontSize:22,
  box:{x:111,y:54,width:18,height:68},bubbleMask:mask,translatedText:''};
function render(regions:TextRegion[]){
  configureTypesetFont('test',400,coverage['comic-relief']);
  const ink:{text:string;x:number;y:number;size:number;width:number}[]=[];
  const ctx={font:'',x:0,y:0,s:1,save(){},restore(){this.x=this.y=0;this.s=1;},translate(x:number,y:number){this.x+=x;this.y+=y;},scale(s:number){this.s=s;},get size(){return Number(/ ([\d.]+)px /.exec(this.font)![1]);},
    measureText(text:string){return {width:[...text].length*this.size/2,actualBoundingBoxAscent:this.size*.75,actualBoundingBoxDescent:this.size*.25};},
    strokeText(){},fillText(text:string,x:number,y:number){ink.push({text,x:this.x+x*this.s,y:this.y+y*this.s,size:this.size*this.s,width:this.measureText(text).width*this.s});}};
  drawLatinTypeset({width:240,height:180,getContext:()=>ctx} as unknown as PipelineCanvas,regions);
  return ink;
}
it('reflows vertical dialogue into intact horizontal words inside the balloon, including decomposed Spanish accents',()=>{
  const text='¿Dónde está el pingüino? ¡Mañana lo verás!';
  const lines=render([{...vertical,translatedText:text.normalize('NFD')}]);
  expect(lines.length).toBeGreaterThan(1);expect(lines.map(l=>l.text).join(' ')).toBe(text);
  expect(lines.some(l=>l.width>vertical.box.width)).toBe(true);
  for(const [i,line] of lines.entries()){
    expect(line.size).toBeGreaterThanOrEqual(14);
    if(i)expect(line.y).toBeGreaterThan(lines[i-1].y);
    for(const x of [line.x-line.width/2,line.x+line.width/2])for(const y of [line.y-line.size*.75,line.y+line.size*.25]){
      expect(mask.data[Math.floor(y-mask.y)*mask.width+Math.floor(x-mask.x)]).toBe(1);
    }
  }
});
it('keeps multiple speakers in their own boxes and retains both ends of a word too long for one line',()=>{
  const first={...vertical,box:{x:64,y:45,width:46,height:90},translatedText:'¡Extraordinariamente!'},second={...vertical,id:'other',box:{x:126,y:50,width:54,height:60},translatedText:"Don't go!"};
  const all=render([first,second]);
  for(const r of [first,second]){
    const lines=all.filter(l=>l.x===r.box.x+r.box.width/2);
    expect(lines.map(l=>l.text).join('').replaceAll(' ','')).toBe(r.translatedText.replaceAll(' ',''));
    expect(lines.every(l=>l.width<=r.box.width&&l.y>=r.box.y&&l.y<=r.box.y+r.box.height)).toBe(true);
    if(r===first){expect(lines.length).toBeGreaterThan(1);expect(lines.every(l=>l.text!=='¡'&&l.text!=='!')).toBe(true);}
  }
  expect(render([{...vertical,translatedText:'🧪'}])).toEqual([]);
});
it('fits even a sub-glyph detection without losing the next region',()=>{
  const [tiny,next]=render([{...vertical,bubbleMask:undefined,box:{x:0,y:0,width:2,height:2},translatedText:'Oh!'},
    {...vertical,translatedText:'Hello'}]);
  expect(tiny.text).toBe('Oh!');expect(tiny.width).toBeLessThan(2);
  expect(next.text).toBe('Hello');expect(next.size).toBe(22);
});
