import {msg} from '../i18n/runtime';
import {discoverDocument,safeImageUrl,type SourceItem} from './adapters';

/** The site's reader decrypts contentKey with cct, then appends that ordered
 * array to the DOM. Read the same inline data without running page-provided code.
 */
export async function readMangaCopyData(doc:Document,pageUrl:string){
 const before=discoverDocument(doc,pageUrl);
 if(before.adapter!=='mangacopy')return before;
 const scripts=[...doc.querySelectorAll<HTMLScriptElement>('script:not([src])')];
 const data=scripts.map(script=>{
  const source=script.textContent??'';
  const key=source.match(/\bvar\s+contentKey\s*=\s*(["'])([^"'\\\r\n]*)\1\s*;/)?.[2];
  const secret=source.match(/\bvar\s+cct\s*=\s*(["'])([^"'\\\r\n]*)\1\s*;/)?.[2];
  return key&&secret?{key,secret}:null;
 }).filter(value=>value!==null);
 if(!data.length)return before;
 if(data.length!==1)throw Error(msg("来源图片数据不唯一，请刷新来源页面后重试。"));
 const {key,secret}=data[0],encoder=new TextEncoder(),rawKey=encoder.encode(secret),iv=encoder.encode(key.slice(0,16)),hex=key.slice(16);
 if(![16,24,32].includes(rawKey.length)||iv.length!==16||!hex.length||hex.length>8*1024*1024||hex.length%32||!/^[a-f\d]+$/i.test(hex))throw Error(msg("来源图片数据格式已变化，无法读取图片清单。"));
 let decoded:unknown;
 try{
  const aes=await crypto.subtle.importKey('raw',rawKey,'AES-CBC',false,['decrypt']);
  const bytes=Uint8Array.from(hex.match(/../g)!,pair=>parseInt(pair,16));
  const plaintext=await crypto.subtle.decrypt({name:'AES-CBC',iv},aes,bytes);
  decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
 }catch{throw Error(msg("来源图片数据无法解码，请刷新来源页面后重试。"));}
 if(!Array.isArray(decoded)||!decoded.length||decoded.length>10000)throw Error(msg("来源图片清单不可用。"));
 if(before.knownTotal&&decoded.length!==before.knownTotal)throw Error(msg("来源图片清单与网页总页数不一致，请刷新后重试。"));
 const items:SourceItem[]=decoded.map((value:unknown,order)=>{
  const raw=value&&typeof value==='object'&&'url' in value?value.url:undefined;
  const url=typeof raw==='string'?safeImageUrl(raw,pageUrl):null;
  if(!url)throw Error(msg("来源图片清单包含无效地址。"));
  return {id:`slot-${order}`,url,order,width:800,height:1200};
 });
 // Cross-check every currently rendered slot before assigning stable page IDs.
 const images=[...doc.querySelectorAll<HTMLImageElement>('.comicContent-list img')];
 if(images.length>items.length)throw Error(msg("来源页面与图片清单不一致，请重新发现。"));
 for(const [index,img] of images.entries()){
  const url=safeImageUrl(img.getAttribute('data-src')??'',pageUrl);
  if(url&&url!==items[index].url)throw Error(msg("来源页面的图片顺序与清单不一致，请重新发现。"));
  const known=before.items[index];if(known?.url===items[index].url){items[index].width=known.width;items[index].height=known.height;}
 }
 return {...before,items,knownTotal:items.length,discoveryComplete:true,note:msg("已读取网页 JS 的完整有序图片清单，并核对已显示图片；原图下载进度单独记录。")};
}
