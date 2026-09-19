/** Keep src, srcset, picture sources, links and event listeners owned by the site. */
export class ImageDisplay {
  private undo:Array<()=>void>=[];
  private objectUrl?:string;
  key?:string;
  constructor(readonly image:HTMLImageElement){}
  async show(data:string,key:string,current:()=>boolean){
    const response=await fetch(data),blob=await response.blob(),url=URL.createObjectURL(blob);
    const preview=new Image();preview.src=url;
    try{await preview.decode();}catch{URL.revokeObjectURL(url);throw Error('当前网站阻止显示译图，原图已保留。');}
    if(!current()){URL.revokeObjectURL(url);return;}
    this.restore();
    const image=this.image;
    const authoredRatio=getComputedStyle(image).aspectRatio;
    const properties=[['content',`url("${url}")`]];
    if(authoredRatio==='auto'||authoredRatio.startsWith('auto '))properties.push(['aspect-ratio',`${image.naturalWidth} / ${image.naturalHeight}`]);
    if(!image.hasAttribute('style'))this.undo.push(()=>{if(!image.style.length)image.removeAttribute('style');});
    // Intrinsic geometry comes from the original even if the translated bitmap differs.
    for(const [name,value] of [['width',image.naturalWidth],['height',image.naturalHeight]] as const){
      if(image.hasAttribute(name))continue;
      const applied=String(value);image.setAttribute(name,applied);
      this.undo.push(()=>{if(image.getAttribute(name)===applied)image.removeAttribute(name);});
    }
    for(const [property,value] of properties){
      const old=image.style.getPropertyValue(property),priority=image.style.getPropertyPriority(property);
      image.style.setProperty(property,value,'important');const applied=image.style.getPropertyValue(property);
      this.undo.push(()=>{if(image.style.getPropertyValue(property)!==applied)return;if(old)image.style.setProperty(property,old,priority);else image.style.removeProperty(property);});
    }
    this.objectUrl=url;this.key=key;
  }
  restore(){for(const undo of this.undo.reverse())undo();this.undo=[];if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=undefined;this.key=undefined;}
}
