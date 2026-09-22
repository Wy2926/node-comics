import {msg} from '../i18n/runtime';
import {imageDataUrl,maxInlineBytes} from '../inline/bytes';
import type {PageImage,SourceSnapshot} from './model';

export async function canvasImage(canvas:HTMLCanvasElement):Promise<Blob>{
 if(!canvas.width||!canvas.height||canvas.width*canvas.height>60_000_000)throw Error(msg('原图尺寸不可用。'));
 try{
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob||blob.size>maxInlineBytes)throw Error();
  return blob;
 }catch{throw Error(msg('网页原图读取失败。'));}
}

/** Only registered rendered elements can yield bytes. No page-provided scripts or arbitrary URLs. */
export class PageImageRegistry {
 private entries=new Map<string,{id:string;image:PageImage;width:number;height:number;pageUrl:string}>();
 async register(snapshot:SourceSnapshot,images:PageImage[]):Promise<SourceSnapshot>{
  const active=new Set(images.map(image=>image.url));
  for(const [url,entry] of this.entries)if(entry.pageUrl!==snapshot.url||!active.has(url))this.entries.delete(url);
  const items=[];let previewBytes=0;
  for(const item of snapshot.items){
   if(item.kind!=='page'){items.push(item);continue;}
   const image=images.find(image=>image.url===item.url);
   if(!image?.read)continue;
   this.entries.set(item.url,{id:item.id,image,width:item.width,height:item.height,pageUrl:snapshot.url});
   let preview:string|undefined;
   try{const canvas=document.createElement('canvas');canvas.width=180;canvas.height=Math.max(1,Math.round(180*item.height/item.width));if(canvas.height<=1000){canvas.getContext('2d')!.drawImage(image.element,0,0,canvas.width,canvas.height);const value=canvas.toDataURL('image/png');if(value.length<=100_000&&previewBytes+value.length<=2_000_000){preview=value;previewBytes+=value.length;}}}catch{/* An unreadable canvas remains selectable and reports its acquisition error. */}
   items.push({...item,preview});
  }
  return {...snapshot,items};
 }
 async read(url:string,pageUrl:string,id:string,getCurrent:()=>PageImage[]){
  const validate=()=>{
   const entry=this.entries.get(url),image=getCurrent().find(image=>image.url===url);
   if(!entry||entry.id!==id||entry.pageUrl!==pageUrl||!image?.read||image.element!==entry.image.element||image.key!==entry.image.key||!image.element.isConnected||image.element.width!==entry.width||image.element.height!==entry.height)throw Error(msg('图片来源已变化，请重新发现。'));
   return image;
  };
  const data=await imageDataUrl(await validate().read!());validate();return data;
 }
}
