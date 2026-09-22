import type {ComicElement} from '../sources/model';
import {CanvasDisplay} from './canvas-display';
import {msg} from '../i18n/runtime';
import styles from './display.css?inline';
import {shadowThemeStyles} from './shadow';

export const inlineStyles=shadowThemeStyles(styles);
export const imageDisplay=(image:ComicElement)=>image instanceof HTMLCanvasElement?new CanvasDisplay(image):new ImageDisplay(image);

/** Keep src, srcset, picture sources, links and event listeners owned by the site. */
export class ImageDisplay {
  private undo:Array<()=>void>=[];
  private repairs:Array<()=>void>=[];
  private objectUrl?:string;
  key?:string;
  constructor(readonly image:HTMLImageElement){}
  async show(data:string,key:string,current:()=>boolean){
    const response=await fetch(data),blob=await response.blob(),url=URL.createObjectURL(blob);
    const preview=new Image();preview.src=url;
    try{await preview.decode();}catch{URL.revokeObjectURL(url);throw Error(msg("当前网站阻止显示译图，原图已保留。"));}
    if(!current()){URL.revokeObjectURL(url);return;}
    this.restore();
    const image=this.image;
    const width=image.naturalWidth,height=image.naturalHeight;
    const authoredRatio=getComputedStyle(image).aspectRatio;
    const properties=[['content',`url("${url}")`]];
    if(authoredRatio==='auto'||authoredRatio.startsWith('auto '))properties.push(['aspect-ratio',`${width} / ${height}`]);
    if(!image.hasAttribute('style'))this.undo.push(()=>{if(!image.style.length)image.removeAttribute('style');});
    // Intrinsic geometry comes from the original even if the translated bitmap differs.
    for(const [name,value] of [['width',width],['height',height]] as const){
      if(image.hasAttribute(name))continue;
      const applied=String(value);image.setAttribute(name,applied);
      this.undo.push(()=>{if(image.getAttribute(name)===applied)image.removeAttribute(name);});
    }
    for(const [property,value] of properties){
      let old=image.style.getPropertyValue(property),priority=image.style.getPropertyPriority(property);
      image.style.setProperty(property,value,'important');const applied=image.style.getPropertyValue(property);
      this.repairs.push(()=>{
        if(image.style.getPropertyValue(property)===applied&&image.style.getPropertyPriority(property)==='important')return;
        // Framework renders may replace the entire style attribute. Remember the site's
        // latest value so restoring originals does not roll back its subsequent edits.
        old=image.style.getPropertyValue(property);priority=image.style.getPropertyPriority(property);
        image.style.setProperty(property,value,'important');
      });
      this.undo.push(()=>{if(image.style.getPropertyValue(property)!==applied||image.style.getPropertyPriority(property)!=='important')return;if(old)image.style.setProperty(property,old,priority);else image.style.removeProperty(property);});
    }
    this.objectUrl=url;this.key=key;
  }
  sync(){for(const repair of this.repairs)repair();}
  restore(){for(const undo of this.undo.reverse())undo();this.undo=[];this.repairs=[];if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=undefined;this.key=undefined;}
}
