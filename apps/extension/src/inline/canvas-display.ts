import {msg} from '../i18n/runtime';

/** Canvas ignores CSS content. A pointer-transparent sibling follows the site's canvas box,
 * leaving its pixels, dimensions and event handlers available to the reader and source capture. */
export class CanvasDisplay {
 private preview?:HTMLImageElement;
 private objectUrl?:string;
 private parent?:HTMLElement;
 private oldPosition?:{value:string;priority:string;hadStyle:boolean};
 key?:string;
 constructor(readonly canvas:HTMLCanvasElement){}
 async show(data:string,key:string,current:()=>boolean){
  const blob=await(await fetch(data)).blob(),url=URL.createObjectURL(blob),preview=new Image();
  preview.src=url;
  try{await preview.decode();}catch{URL.revokeObjectURL(url);throw Error(msg('当前网站阻止显示译图，原图已保留。'));}
  if(!current()||!this.canvas.parentElement){URL.revokeObjectURL(url);return;}
  this.restore();this.parent=this.canvas.parentElement;this.preview=preview;this.objectUrl=url;this.key=key;
  preview.alt='';preview.setAttribute('aria-hidden','true');preview.dataset.ncCanvasTranslation='';
  this.canvas.after(preview);this.sync();
 }
 sync(){
  const parent=this.parent,preview=this.preview;if(!parent||!preview)return;
  if(this.canvas.parentElement===parent&&preview.previousElementSibling!==this.canvas)this.canvas.after(preview);
  if(getComputedStyle(parent).position==='static'){
   this.oldPosition={value:parent.style.getPropertyValue('position'),priority:parent.style.getPropertyPriority('position'),hadStyle:parent.hasAttribute('style')};
   parent.style.setProperty('position','relative','important');
  }
  const css=getComputedStyle(this.canvas);
  const properties:Record<string,string>={all:'initial',position:'absolute',display:'block',left:`${this.canvas.offsetLeft}px`,top:`${this.canvas.offsetTop}px`,width:`${this.canvas.offsetWidth}px`,height:`${this.canvas.offsetHeight}px`,'max-width':'none','max-height':'none','object-fit':'fill','pointer-events':'none','user-select':'none','z-index':'1'};
  // Comici centers each canvas with top:50% + translateY(-50%). Its offset box
  // alone is not the displayed box; keep all site-authored transforms as well.
  for(const name of ['transform','transform-origin','translate','rotate','scale'])properties[name]=css.getPropertyValue(name);
  for(const [name,value] of Object.entries(properties))if(preview.style.getPropertyValue(name)!==value||preview.style.getPropertyPriority(name)!=='important')preview.style.setProperty(name,value,'important');
 }
 restore(){
  this.preview?.remove();this.preview=undefined;
  const parent=this.parent,old=this.oldPosition;
  if(parent&&old&&parent.style.getPropertyValue('position')==='relative'&&parent.style.getPropertyPriority('position')==='important'){
   if(old.value)parent.style.setProperty('position',old.value,old.priority);else parent.style.removeProperty('position');
   if(!old.hadStyle&&!parent.style.length)parent.removeAttribute('style');
  }
  this.parent=undefined;this.oldPosition=undefined;
  if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=undefined;this.key=undefined;
 }
}
